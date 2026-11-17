"""Save the example targets' finished pictures into the repository.

The server keeps everything it builds in .cache/, but the free hosting plan
wipes that folder on every restart, and it restarts whenever nobody has
visited for 15 minutes. A visitor arriving after that would wait minutes for
each example. This script copies what the examples need into backend/seed/,
which is part of the repository and so is always there:

    targets.json     where each example is on the sky (no name lookup needed)
    searches/        which exposures cover it
    stacks/          the finished picture for each visit, default settings

cache.py copies a seed file into .cache/ the first time it is asked for.
Run it before a release, then commit backend/seed/:

    python -m backend.seed

It builds any picture that is not in this machine's cache yet, so the first
run can take a while. It covers what the page asks for when someone clicks an
example with the default settings; keep that in step with prewarm.py.
"""

import json
import shutil

import numpy as np

from . import archive, config, imaging, spherex, targets, wise
from .prewarm import DETECTOR, EXAMPLES, FIELD_DEG, WISE_MOMENTS, spread_out as spread_like_page
from .visits import group_into_visits, spread_out


def main() -> None:
    shutil.rmtree(config.SEED_DIR, ignore_errors=True)  # no leftovers from an older seed
    for kind in ("searches", "stacks"):
        (config.SEED_DIR / kind).mkdir(parents=True)

    positions, stacks = {}, 0
    for name in EXAMPLES:
        target = targets._look_up_name(name)
        positions[name.lower()] = target
        ra, dec = target["ra"], target["dec"]

        # The same searches the server runs, and the same pick of exposures.
        searches = [spherex.search_filter(), config.WISE_2010_COLLECTION, config.NEOWISE_COLLECTION]
        visits = group_into_visits(spherex.find_exposures(ra, dec))
        jobs = []
        for visit in visits:
            urls = [e["url"] for e in visit if e["detector"] == DETECTOR]
            if urls:
                jobs.append(spread_out(urls, config.SPHEREX_MAX_EXPOSURES_PER_VISIT))
        band = wise.band_for_detector(DETECTOR)
        with_band = [v for v in wise.find_visits(ra, dec) if v["urls"].get(band)]
        jobs += [v["urls"][band] for v in spread_like_page(with_band, WISE_MOMENTS)]

        saved = 0
        for urls in jobs:
            try:
                result = imaging.stack_exposures(urls, ra, dec, FIELD_DEG)
            except archive.ArchiveError as error:
                print(f"  {name}: one picture could not be built ({error})")
                continue
            path = imaging.stack_file(urls, ra, dec, FIELD_DEG)
            if not path.exists():
                continue  # built from an incomplete download, so not kept: not worth seeding
            # Compressed: these are committed, and every megabyte stays in the repository's history.
            np.savez_compressed(config.SEED_DIR / "stacks" / path.name, image=result["image"], used=result["used"])
            saved += 1
        for where in searches:
            path = archive._search_cache_file(where, ra, dec)
            if path.exists():
                shutil.copyfile(path, config.SEED_DIR / "searches" / path.name)
        stacks += saved
        print(f"  {name}: {saved}/{len(jobs)} pictures saved")

    (config.SEED_DIR / "targets.json").write_text(json.dumps(positions, indent=1))
    size = sum(f.stat().st_size for f in config.SEED_DIR.rglob("*") if f.is_file())
    print(f"Seed written to {config.SEED_DIR}: {stacks} pictures, {size / 1e6:.1f} MB. Commit it.")


if __name__ == "__main__":
    main()

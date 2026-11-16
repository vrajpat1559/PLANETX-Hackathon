"""Load every example target once, so the demo never waits on the archive.

The first look at a target downloads and combines many exposures (WISE ones
especially); after that everything is cached on disk and loads instantly. Run
this against the running server before a demo:

    python -m backend.prewarm                       # http://localhost:8020
    python -m backend.prewarm http://my-host:8000   # another server

It requests exactly what the page requests when someone clicks an example with
the default settings (band D2, 0.25 degree field, one image per visit, five
WISE moments since 2010). Keep EXAMPLES in step with PRESETS in frontend/js/app.js.
"""

import sys
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlencode

import requests

EXAMPLES = ["Barnard's Star", "eps Ind B", "WISE J085510.83-071442.5", "RW Aur", "R Dra"]
DETECTOR = "D2"
FIELD_DEG = 0.25
WISE_MOMENTS = 5          # WISE_MOMENTS_IN_SHORT_HISTORY in app.js
PARALLEL = 3              # images loaded at once, as the page does


def spread_out(items: list, limit: int) -> list:
    """The same evenly spaced pick as spreadOut() in app.js."""
    if not limit or len(items) <= limit:
        return items
    picked = []
    for i in range(limit):
        item = items[round(i * (len(items) - 1) / (limit - 1))]
        if item not in picked:
            picked.append(item)
    return picked


def warm(server: str, name: str) -> None:
    session = requests.Session()
    def get(path, **params):
        response = session.get(f"{server}{path}?{urlencode(params)}", timeout=900)
        if path != "/api/stack" and path != "/api/wise/stack":
            response.raise_for_status()  # a failed search: say so, and move on to the next example
        return response
    started = time.time()
    target = get("/api/resolve", q=name).json()
    ra, dec = target["ra"], target["dec"]
    config = get("/api/config").json()
    band = config["detectors"][DETECTOR]["wise_band"]

    observations = get("/api/observations", ra=ra, dec=dec).json()
    wise_visits = get("/api/wise/visits", ra=ra, dec=dec).json()
    jobs = [("/api/stack", dict(ra=ra, dec=dec, fov=FIELD_DEG, detector=DETECTOR, visit=v["index"]))
            for v in observations["visits"] if v["exposures_per_detector"].get(DETECTOR)]
    with_band = [v for v in wise_visits if v["exposures_per_band"].get(band)]
    jobs += [("/api/wise/stack", dict(ra=ra, dec=dec, fov=FIELD_DEG, band=band, visit=v["index"]))
             for v in spread_out(with_band, WISE_MOMENTS)]

    with ThreadPoolExecutor(PARALLEL) as pool:
        results = list(pool.map(lambda job: get(job[0], **job[1]).status_code, jobs))
    failed = sum(code != 200 for code in results)
    print(f"  {name}: {len(jobs) - failed}/{len(jobs)} images ready in {time.time() - started:.0f} s"
          + (f" ({failed} failed, run again to retry)" if failed else ""))


def main() -> None:
    server = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8020").rstrip("/")
    print(f"Pre-loading {len(EXAMPLES)} examples from {server} ...")
    for name in EXAMPLES:
        try:
            warm(server, name)
        except requests.HTTPError as error:
            print(f"  {name}: the archive search failed ({error.response.status_code}); run again to retry")
        except requests.RequestException as error:
            print(f"  {name}: could not reach the server ({type(error).__name__})")


if __name__ == "__main__":
    main()

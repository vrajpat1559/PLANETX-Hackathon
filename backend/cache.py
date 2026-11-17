"""The on-disk cache, so we never ask the archive for the same thing twice.

Three kinds of file live in .cache/, each in its own folder:

  searches/   IRSA's answer to "which images cover this spot?"   (small)
  exposures/  one exposure, already lined up on the target grid  (most of the space)
  stacks/     the finished picture for one visit                 (what users see)

The cache has a size limit (config.CACHE_MAX_MB). When it goes over, trim()
deletes the files that have gone longest without being used. Exposures go
first: they are only ingredients, and the stack made from them is kept.
Everything here is safe to delete at any time; it is rebuilt on demand.
"""

import hashlib
import logging
import os
import shutil
import threading
import time
import zipfile
from pathlib import Path

import numpy as np

from . import config

log = logging.getLogger("uvicorn.error")

# Deleted in this order when space runs out.
KINDS = ["exposures", "stacks", "searches"]
# After a trim the cache is this full, so trimming is not needed again right away.
TRIM_TO_FRACTION = 0.8
# Half-written files older than this were left by a crash; remove them.
STALE_PART_SECONDS = 3600


def cache_file(kind: str, key: str, extension: str) -> Path:
    """Path of the cache file for `key`. `kind` is one of KINDS."""
    folder = config.CACHE_DIR / kind
    folder.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha1(key.encode()).hexdigest()[:20]
    path = folder / f"{digest}.{extension}"
    _copy_from_seed(kind, path)
    return path


def _copy_from_seed(kind: str, path: Path) -> None:
    """If the cache lacks this file but the repository's seed has it, copy it in.

    The seed (config.SEED_DIR, made by seed.py) holds the example targets'
    searches and finished pictures. Copying one in makes it an ordinary cache
    file from then on: fresh as of now, counted against the size limit, and
    copied in again if it is ever trimmed away.
    """
    if path.exists():
        return
    seed = config.SEED_DIR / kind / path.name
    if not seed.exists():
        return
    temporary = _temporary_name(path)
    try:
        shutil.copyfile(seed, temporary)
        os.replace(temporary, path)
    except OSError:
        temporary.unlink(missing_ok=True)  # the cache is only a shortcut: build it the slow way


def is_fresh(path: Path, max_age_hours: float) -> bool:
    """True if the file exists and is younger than `max_age_hours`."""
    if not path.exists():
        return False
    age_hours = (time.time() - path.stat().st_mtime) / 3600
    return age_hours < max_age_hours


# ---------- one builder at a time ----------

_locks: dict[Path, threading.Lock] = {}
_locks_guard = threading.Lock()
_MAX_REMEMBERED_LOCKS = 10_000


def only_one_builder(path: Path) -> threading.Lock:
    """A lock for one cache file. Use it as:

        with only_one_builder(path):
            ...read it from the cache, or build it and save it...

    When several visitors ask for the same new image at the same moment, the
    first one builds it and the others wait, then find it in the cache,
    instead of all doing the same downloads and overwriting each other's file.
    """
    with _locks_guard:
        if len(_locks) > _MAX_REMEMBERED_LOCKS:
            # Forget locks nobody is holding, so this list cannot grow forever.
            for idle in [p for p, lock in _locks.items() if not lock.locked()]:
                del _locks[idle]
        return _locks.setdefault(path, threading.Lock())


# ---------- reading and writing ----------

def load_arrays(path: Path) -> dict | None:
    """The arrays saved with save_arrays(), or None if there is nothing usable.

    Reading a file also marks it as "just used", which is what trim() goes by.
    """
    try:
        with np.load(path) as saved:
            arrays = {name: saved[name] for name in saved.files}
        os.utime(path)
    except (OSError, ValueError, zipfile.BadZipFile):
        return None  # missing, trimmed a moment ago, or damaged: build it again
    return arrays


def save_arrays(path: Path, **arrays) -> None:
    """Save a set of numpy arrays (an .npz file)."""
    temporary = _temporary_name(path)
    with open(temporary, "wb") as file:
        np.savez(file, **arrays)
    _swap_in(temporary, path)


def save_text(path: Path, text: str) -> None:
    """Save a text file."""
    temporary = _temporary_name(path)
    temporary.write_text(text)
    _swap_in(temporary, path)


def _swap_in(temporary: Path, path: Path) -> None:
    """Put a finished file in place in one step, so nobody reads it half-written.

    Windows refuses if someone has the old file open for reading at that
    instant. Try a few times; if it keeps failing, skip it. The cache is only
    a shortcut, so not saving is harmless.
    """
    size = temporary.stat().st_size
    for attempt in range(5):
        try:
            os.replace(temporary, path)
            _count_written(size)
            return
        except PermissionError:
            time.sleep(0.05 * (attempt + 1))
    temporary.unlink(missing_ok=True)


def _temporary_name(path: Path) -> Path:
    # Unique per thread, so two requests saving the same thing do not collide.
    return path.with_name(f"{path.name}.{os.getpid()}-{threading.get_ident()}.part")


# ---------- keeping the cache under its size limit ----------

_written_since_trim = 0
_written_guard = threading.Lock()
_trimming = threading.Lock()


def _count_written(size: int) -> None:
    """Trim once enough new data has been written to possibly matter.

    Checking after every 5% of the limit keeps the cost negligible while
    never letting the cache overshoot by more than that.
    """
    global _written_since_trim
    with _written_guard:
        _written_since_trim += size
        due = _written_since_trim > 0.05 * config.CACHE_MAX_MB * 1e6
        if due:
            _written_since_trim = 0
    if due:
        trim()


def trim() -> dict:
    """Delete least-recently-used files until the cache is under its limit.

    Returns {"before_mb", "after_mb", "deleted"} and logs it if anything went.
    """
    if not _trimming.acquire(blocking=False):
        return {}  # another request is already trimming
    try:
        limit = config.CACHE_MAX_MB * 1e6
        files = {kind: _files_oldest_first(kind) for kind in KINDS}
        before = total = sum(size for kind in KINDS for _, size, _ in files[kind])
        deleted = 0
        for kind in KINDS:
            for _, size, path in files[kind]:
                if total <= (limit if deleted == 0 else limit * TRIM_TO_FRACTION):
                    break
                try:
                    os.remove(path)
                except OSError:
                    continue  # in use right now (Windows); leave it for next time
                total -= size
                deleted += 1
        report = {"before_mb": round(before / 1e6), "after_mb": round(total / 1e6), "deleted": deleted}
        if deleted:
            log.info(
                "Cache was %d MB (limit %d MB): removed the %d least recently used files, now %d MB",
                report["before_mb"], config.CACHE_MAX_MB, deleted, report["after_mb"],
            )
        return report
    finally:
        _trimming.release()


def _files_oldest_first(kind: str) -> list[tuple[float, int, str]]:
    """(last used, size in bytes, path) for every file of one kind."""
    folder = config.CACHE_DIR / kind
    if not folder.exists():
        return []
    found = []
    now = time.time()
    for entry in os.scandir(folder):
        try:
            info = entry.stat()
        except OSError:
            continue  # deleted while we were looking
        if entry.name.endswith(".part"):
            if now - info.st_mtime > STALE_PART_SECONDS:
                try:
                    os.remove(entry.path)
                except OSError:
                    pass
            continue
        found.append((info.st_mtime, info.st_size, entry.path))
    return sorted(found)

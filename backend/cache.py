"""A tiny on-disk cache so we never ask the archive for the same thing twice."""

import hashlib
import time
from pathlib import Path

from .config import CACHE_DIR


def cache_file(kind: str, key: str, extension: str) -> Path:
    """Path of the cache file for `key`. `kind` becomes a sub-folder."""
    folder = CACHE_DIR / kind
    folder.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha1(key.encode()).hexdigest()[:20]
    return folder / f"{digest}.{extension}"


def is_fresh(path: Path, max_age_hours: float) -> bool:
    """True if the file exists and is younger than `max_age_hours`."""
    if not path.exists():
        return False
    age_hours = (time.time() - path.stat().st_mtime) / 3600
    return age_hours < max_age_hours

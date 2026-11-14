"""Talking to IRSA, the archive that hosts both SPHEREx and WISE images.

Two jobs:
  search_images()    which images (of a collection or a whole mission) cover a sky position?
  download_cutout()  fetch a small piece of one image

Knowing what the rows mean for each telescope is left to spherex.py and wise.py.
"""

import csv
import gzip
import io
import json
import threading
import time

import requests

from . import config
from .cache import cache_file, is_fresh, only_one_builder, save_text


class ArchiveError(Exception):
    """IRSA could not be reached or returned something unusable."""


_session = requests.Session()
_session.headers["User-Agent"] = "spherex-blink-viewer"
# Limits how many requests are in flight at once, across the whole server.
_slots = threading.BoundedSemaphore(config.MAX_ARCHIVE_CONNECTIONS)

# The columns of IRSA's answer that we keep.
_KEPT_COLUMNS = ["obs_id", "obs_collection", "energy_bandpassname", "dataproduct_subtype", "t_min", "s_ra", "s_dec", "access_url"]


def _get(url: str, params: dict, timeout: int = 120, tries: int = 4) -> requests.Response:
    """GET with retries, because IRSA occasionally answers 502 under load."""
    problem = "no attempt made"
    for attempt in range(tries):
        try:
            with _slots:
                response = _session.get(url, params=params, timeout=timeout)
            if response.status_code == 200:
                return response
            problem = f"HTTP {response.status_code}"
            if 400 <= response.status_code < 500:
                break  # "no such file" or "bad request" will not get better by asking again
        except requests.RequestException as error:
            problem = type(error).__name__
        time.sleep(1.5 * (attempt + 1))
    raise ArchiveError(f"The image archive could not provide this ({problem})")


def is_archive_image_url(url: str) -> bool:
    """Guard so the server only ever fetches SPHEREx or WISE images from IRSA."""
    return url.startswith(config.IRSA_DATA_PREFIXES) and url.endswith(".fits") and "?" not in url


def search_images(where, ra: float, dec: float, cache_hours: float) -> list[dict]:
    """Every science image that covers the position.

    `where` says which images to search: one IRSA collection name ("neowiser"),
    a list of them, or a dict of other search filters such as
    {"FACILITY": "SPHEREx", ...}, which matches every release of a mission,
    including ones that did not exist when this code was written.

    Each row is a dict with the columns in _KEPT_COLUMNS (all strings).
    Answers are reused for `cache_hours`. If IRSA is down when an old answer
    expires, the old answer is used rather than failing.
    """
    path = _search_cache_file(where, ra, dec)
    # If several visitors open the same new target together, ask IRSA once.
    with only_one_builder(path):
        if is_fresh(path, cache_hours):
            return json.loads(path.read_text())
        return _search_images(where, ra, dec, path)


def _search_images(where, ra: float, dec: float, path) -> list[dict]:
    """The work behind search_images(): ask IRSA and save the answer."""
    if isinstance(where, dict):
        filters = where
    else:
        filters = {"COLLECTION": where}  # a list becomes COLLECTION=a&COLLECTION=b
    try:
        response = _get(
            config.IRSA_SEARCH_URL,
            params={
                **filters,
                "POS": f"circle {ra} {dec} 0.01",
                "RESPONSEFORMAT": "csv",
                "MAXREC": 20000,
            },
        )
    except ArchiveError:
        if path.exists():
            return json.loads(path.read_text())  # stale, but better than nothing
        raise
    rows = [
        {column: row.get(column, "") for column in _KEPT_COLUMNS}
        for row in csv.DictReader(io.StringIO(response.text))
        if row.get("dataproduct_subtype") == "science"
        and is_archive_image_url(row.get("access_url", ""))
    ]
    save_text(path, json.dumps(rows))
    return rows


def searched_at(where, ra: float, dec: float) -> float | None:
    """When the archive was last asked about this position (Unix time), if ever."""
    path = _search_cache_file(where, ra, dec)
    return path.stat().st_mtime if path.exists() else None


def _search_cache_file(where, ra: float, dec: float):
    return cache_file("searches", f"{json.dumps(where, sort_keys=True)}:{ra:.5f}:{dec:.5f}", "json")


def download_cutout(image_url: str, ra: float, dec: float, width_deg: float) -> bytes:
    """A FITS file holding just the region around (ra, dec) of one image."""
    if not is_archive_image_url(image_url):
        raise ArchiveError("Not a SPHEREx or WISE image on IRSA")
    params = {"center": f"{ra},{dec}", "size": f"{width_deg}deg"}
    content = _get(image_url, params=params).content
    if content[:2] == b"\x1f\x8b":  # WISE cutouts arrive gzip-compressed
        content = gzip.decompress(content)
    return content

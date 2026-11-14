"""Talking to IRSA, the archive that hosts both SPHEREx and WISE images.

Two jobs:
  search_images()    which images in a collection cover a sky position?
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
from .cache import cache_file, is_fresh


class ArchiveError(Exception):
    """IRSA could not be reached or returned something unusable."""


_session = requests.Session()
_session.headers["User-Agent"] = "spherex-blink-viewer"
# Limits how many requests are in flight at once, across the whole server.
_slots = threading.BoundedSemaphore(config.MAX_ARCHIVE_CONNECTIONS)

# The columns of IRSA's answer that we keep.
_KEPT_COLUMNS = ["obs_id", "energy_bandpassname", "dataproduct_subtype", "t_min", "s_ra", "s_dec", "access_url"]


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
        except requests.RequestException as error:
            problem = type(error).__name__
        time.sleep(1.5 * (attempt + 1))
    raise ArchiveError(f"The image archive did not answer after {tries} tries ({problem})")


def is_archive_image_url(url: str) -> bool:
    """Guard so the server only ever fetches SPHEREx or WISE images from IRSA."""
    return url.startswith(config.IRSA_DATA_PREFIXES) and url.endswith(".fits") and "?" not in url


def search_images(collection: str, ra: float, dec: float, cache_hours: float) -> list[dict]:
    """Every science image in an IRSA collection that covers the position.

    Each row is a dict with the columns in _KEPT_COLUMNS (all strings).
    """
    path = cache_file("searches", f"{collection}:{ra:.5f}:{dec:.5f}", "json")
    if is_fresh(path, cache_hours):
        return json.loads(path.read_text())

    response = _get(
        config.IRSA_SEARCH_URL,
        params={
            "COLLECTION": collection,
            "POS": f"circle {ra} {dec} 0.01",
            "RESPONSEFORMAT": "csv",
            "MAXREC": 20000,
        },
    )
    rows = [
        {column: row.get(column, "") for column in _KEPT_COLUMNS}
        for row in csv.DictReader(io.StringIO(response.text))
        if row.get("dataproduct_subtype") == "science"
        and is_archive_image_url(row.get("access_url", ""))
    ]
    path.write_text(json.dumps(rows))
    return rows


def download_cutout(image_url: str, ra: float, dec: float, width_deg: float) -> bytes:
    """A FITS file holding just the region around (ra, dec) of one image."""
    if not is_archive_image_url(image_url):
        raise ArchiveError("Not a SPHEREx or WISE image on IRSA")
    params = {"center": f"{ra},{dec}", "size": f"{width_deg}deg"}
    content = _get(image_url, params=params).content
    if content[:2] == b"\x1f\x8b":  # WISE cutouts arrive gzip-compressed
        content = gzip.decompress(content)
    return content

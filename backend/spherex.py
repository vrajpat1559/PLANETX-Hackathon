"""SPHEREx: finding its exposures and reading its image files."""

import re
import warnings

import numpy as np
from astropy.time import Time
from astropy.wcs import WCS

from . import archive, config


def search_filter():
    """What to ask the archive for: every SPHEREx release, unless pinned in config."""
    return config.SPHEREX_COLLECTIONS or config.SPHEREX_SEARCH


def find_exposures(ra: float, dec: float, max_age_hours: float | None = None) -> list[dict]:
    """Every SPHEREx exposure that covers the position, oldest first.

    Each exposure is a dict: id, detector ("D1".."D6"), mjd, date, url,
    collection. The archive is asked again once the saved answer is older than
    `max_age_hours` (default config.SEARCH_CACHE_HOURS), so new data shows up.
    """
    if max_age_hours is None:
        max_age_hours = config.SEARCH_CACHE_HOURS
    rows = archive.search_images(search_filter(), ra, dec, max_age_hours)

    best: dict[tuple, dict] = {}
    for row in rows:
        detector = row["energy_bandpassname"].replace("SPHEREx-", "")
        # Only the six-detector spectral images; guards against any other kind
        # of SPHEREx product a future release might add.
        if detector not in config.DETECTORS or "/level2/" not in row["access_url"]:
            continue
        exposure = {
            "id": row["obs_id"],
            "detector": detector,
            "mjd": float(row["t_min"]),
            "date": Time(float(row["t_min"]), format="mjd").strftime("%Y-%m-%d %H:%M"),
            "url": row["access_url"],
            "collection": row.get("obs_collection", ""),
        }
        # The same exposure can be in a quick release and a later data release.
        key = (exposure["id"], detector)
        if key not in best or release_rank(exposure["collection"]) > release_rank(best[key]["collection"]):
            best[key] = exposure
    return sorted(best.values(), key=lambda exposure: exposure["mjd"])


def release_rank(collection: str) -> tuple:
    """Which release of an exposure to prefer: data releases beat quick releases,
    and newer beats older (spherex_dr2 > spherex_dr1 > spherex_qr3 > spherex_qr2)."""
    match = re.search(r"_(dr|qr)(\d+)$", collection)
    return (match.group(1) == "dr", int(match.group(2))) if match else (False, 0)


def read_cutout(hdul, ra: float, dec: float) -> dict:
    """Pull a usable image out of a SPHEREx cutout file.

    Returns {"brightness" (MJy/sr), "grid" (its coordinate system),
    "wavelength_um", "bandwidth_um"}. The wavelength is the one recorded exactly
    at (ra, dec): SPHEREx's filters change colour across the detector, so every
    exposure sees the target at a different wavelength.
    """
    image_hdu = hdul["IMAGE"]
    brightness = clean_brightness(
        image_hdu.data, hdul["ZODI"].data, hdul["FLAGS"].header, hdul["FLAGS"].data
    )
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        grid = WCS(image_hdu.header)
    wavelength, bandwidth = wavelength_at(image_hdu.header, hdul, image_hdu.data.shape, ra, dec)
    return {
        "brightness": brightness,
        "grid": grid,
        "wavelength_um": wavelength,
        "bandwidth_um": bandwidth,
    }


def clean_brightness(image, zodi, flags_header, flags) -> np.ndarray:
    """Brightness with the sky glow removed and bad pixels dealt with.

    Shared by the IRSA path (read_cutout) and the S3 path (s3.py), which hand
    over the same three arrays cut from the same file.
    """
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        brightness = image.astype("float32")
        # Remove the smooth glow of sunlight scattered by dust in the solar system.
        brightness -= zodi.astype("float32")

        brightness[_flagged(flags_header, flags, config.BAD_PIXEL_FLAGS)] = np.nan
        saturated = _flagged(flags_header, flags, config.SATURATED_FLAGS) & np.isnan(brightness)
        if saturated.any() and np.isfinite(brightness).any():
            brightness[saturated] = np.nanmax(brightness)
    return brightness


def _flagged(header, flags, flag_names: list[str]) -> np.ndarray:
    """True where a pixel carries any of the named flags (e.g. "HOT").

    The file itself says which bit means what: header MSKN0010 = 'HOT' goes
    with MSKM0010 = 1024, and so on.
    """
    wanted_bits = 0
    for name_keyword in header["MSKN*"]:
        if header[name_keyword] in flag_names:
            wanted_bits |= int(header[name_keyword.replace("MSKN", "MSKM")])
    return (flags & wanted_bits) != 0


def wavelength_at(image_header, hdul, shape, ra: float, dec: float) -> tuple[float, float]:
    """Wavelength and bandwidth (microns) the exposure recorded at a sky position.

    `hdul` must contain the WCS-WAVE lookup table; `shape` is the image's (rows, columns).
    """
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        x, y = WCS(image_header).world_to_pixel_values(ra, dec)
        height, width = shape
        if not (0 <= x < width and 0 <= y < height):
            return float("nan"), float("nan")
        spectral = WCS(image_header, fobj=hdul, key="W")
        wavelength, bandwidth = spectral.pixel_to_world_values(x, y)
    return float(wavelength), float(bandwidth)

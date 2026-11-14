"""SPHEREx: finding its exposures and reading its image files."""

import warnings

import numpy as np
from astropy.time import Time
from astropy.wcs import WCS

from . import archive, config


def find_exposures(ra: float, dec: float) -> list[dict]:
    """Every SPHEREx exposure that covers the position, oldest first.

    Each exposure is a dict: id, detector ("D1".."D6"), mjd, date, url.
    """
    rows = archive.search_images(config.COLLECTION, ra, dec, config.SEARCH_CACHE_HOURS)
    exposures = [
        {
            "id": row["obs_id"],
            "detector": row["energy_bandpassname"].replace("SPHEREx-", ""),
            "mjd": float(row["t_min"]),
            "date": Time(float(row["t_min"]), format="mjd").strftime("%Y-%m-%d %H:%M"),
            "url": row["access_url"],
        }
        for row in rows
    ]
    return sorted(exposures, key=lambda exposure: exposure["mjd"])


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

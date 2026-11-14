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
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        image_hdu = hdul["IMAGE"]
        brightness = image_hdu.data.astype("float32")
        # Remove the smooth glow of sunlight scattered by dust in the solar system.
        brightness -= hdul["ZODI"].data.astype("float32")

        brightness[_flagged(hdul["FLAGS"], config.BAD_PIXEL_FLAGS)] = np.nan
        saturated = _flagged(hdul["FLAGS"], config.SATURATED_FLAGS) & np.isnan(brightness)
        if saturated.any() and np.isfinite(brightness).any():
            brightness[saturated] = np.nanmax(brightness)

        grid = WCS(image_hdu.header)
        wavelength, bandwidth = _wavelength_at(hdul, grid, ra, dec)
    return {
        "brightness": brightness,
        "grid": grid,
        "wavelength_um": wavelength,
        "bandwidth_um": bandwidth,
    }


def _flagged(flags_hdu, flag_names: list[str]) -> np.ndarray:
    """True where a pixel carries any of the named flags (e.g. "HOT").

    The file itself says which bit means what: header MSKN0010 = 'HOT' goes
    with MSKM0010 = 1024, and so on.
    """
    header = flags_hdu.header
    wanted_bits = 0
    for name_keyword in header["MSKN*"]:
        if header[name_keyword] in flag_names:
            wanted_bits |= int(header[name_keyword.replace("MSKN", "MSKM")])
    return (flags_hdu.data & wanted_bits) != 0


def _wavelength_at(hdul, grid: WCS, ra: float, dec: float) -> tuple[float, float]:
    """Wavelength and bandwidth (microns) the exposure recorded at a sky position."""
    x, y = grid.world_to_pixel_values(ra, dec)
    height, width = hdul["IMAGE"].data.shape
    if not (0 <= x < width and 0 <= y < height):
        return float("nan"), float("nan")
    spectral = WCS(hdul["IMAGE"].header, fobj=hdul, key="W")
    wavelength, bandwidth = spectral.pixel_to_world_values(x, y)
    return float(wavelength), float(bandwidth)

"""WISE: an older infrared telescope that gives us 15 years of history.

WISE photographed the whole sky in 2010, and again every six months from 2014
to 2024 (the "NEOWISE" years). SPHEREx has only been observing since 2025, so
putting WISE images in front of the SPHEREx ones stretches the time span from
about one year to about fifteen. A star that shifts one pixel between SPHEREx
visits has moved twenty-odd pixels since 2010.

WISE's two bands sit inside SPHEREx's wavelength range:
  W1  3.4 microns  (like SPHEREx detector D4)
  W2  4.6 microns  (like SPHEREx detectors D5 and D6)
"""

import warnings

import numpy as np
from scipy.ndimage import maximum_filter
from astropy.time import Time
from astropy.wcs import WCS

from . import archive, config
from .visits import group_into_visits, spread_out

# Brightness of a zero-magnitude star in each band, in janskys (WISE documentation).
_ZERO_MAGNITUDE_JY = {"W1": 309.54, "W2": 171.787}
# Used only if a file is missing its own calibration value.
_DEFAULT_MAGZP = {"W1": 20.5, "W2": 19.5}
# The 2010 image blends two passes (spring and autumn 2010); 1 July 2010 is the middle.
_MID_2010_MJD = 55378.0


def band_for_detector(detector: str) -> str:
    """The WISE band closest in wavelength to a SPHEREx detector."""
    return "W2" if detector in ("D5", "D6") else "W1"


def find_visits(ra: float, dec: float) -> list[dict]:
    """WISE's visits to the position, oldest first.

    Each visit is {"label", "date", "mjd", "urls": {"W1": [...], "W2": [...]}}.
    The first one is the year 2010 (a single ready-made deep image per band);
    the rest are NEOWISE visits, each a set of short exposures to be stacked.
    """
    visits = []

    deep_2010 = _tiles_by_band(
        archive.search_images(config.WISE_2010_COLLECTION, ra, dec, config.WISE_SEARCH_CACHE_HOURS)
    )
    if deep_2010:
        visits.append({"label": "WISE 2010", "date": "2010", "mjd": _MID_2010_MJD, "urls": deep_2010})

    exposures = [
        {"band": row["energy_bandpassname"], "mjd": float(row["t_min"]), "url": row["access_url"]}
        for row in archive.search_images(config.NEOWISE_COLLECTION, ra, dec, config.WISE_SEARCH_CACHE_HOURS)
        if row["t_min"] and row["energy_bandpassname"] in _ZERO_MAGNITUDE_JY
    ]
    exposures.sort(key=lambda exposure: exposure["mjd"])
    for visit in group_into_visits(exposures):
        start = Time(visit[0]["mjd"], format="mjd").to_datetime()
        visits.append(
            {
                "label": f"WISE {start.strftime('%b %Y')}",
                "date": start.strftime("%Y-%m-%d"),
                "mjd": visit[0]["mjd"],
                "urls": {
                    band: spread_out(
                        [e["url"] for e in visit if e["band"] == band],
                        config.WISE_MAX_EXPOSURES_PER_VISIT,
                    )
                    for band in _ZERO_MAGNITUDE_JY
                },
            }
        )
    return visits


def read_cutout(hdul) -> dict:
    """Pull an image out of a WISE file, converted to SPHEREx's units (MJy/sr)."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        grid = WCS(hdul[0].header)
    return to_brightness(hdul[0].header, hdul[0].data, grid)


def to_brightness(header, pixels: np.ndarray, grid: WCS) -> dict:
    """WISE pixel values -> {"brightness" (MJy/sr), "grid"}.

    `grid` is the coordinate system of `pixels`, which may be a piece cut out
    of the full image the header describes.
    """
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        band = f"W{header['BAND']}"

        # WISE pixels count "DN". The file's MAGZP says how bright one DN is.
        magzp = header.get("MAGZP", _DEFAULT_MAGZP[band])
        jy_per_dn = _ZERO_MAGNITUDE_JY[band] * 10 ** (-magzp / 2.5)
        pixel_area_sr = grid.proj_plane_pixel_area().to_value("sr")
        mjy_per_sr_per_dn = jy_per_dn / 1e6 / pixel_area_sr

        brightness = pixels.astype("float32") * np.float32(mjy_per_sr_per_dn)
        _fill_saturated_cores(brightness)
    return {"brightness": brightness, "grid": grid}


def _fill_saturated_cores(brightness: np.ndarray) -> None:
    """Fill the empty centres of very bright stars (changes the array in place).

    WISE leaves overflowed pixels blank. A blank pixel whose neighbours are
    hundreds of times brighter than the sky noise is a star's core, so it gets
    the value of its brightest neighbour. Blank pixels in ordinary sky stay blank.
    """
    blank = ~np.isfinite(brightness)
    if not blank.any() or blank.all():
        return
    sky = np.nanmedian(brightness)
    noise = 1.4826 * np.nanmedian(np.abs(brightness - sky))
    brightest_neighbour = maximum_filter(np.where(blank, -np.inf, brightness), size=7)
    core = blank & (brightest_neighbour - sky > 300 * noise)
    brightness[core] = brightest_neighbour[core]


def _tiles_by_band(rows: list[dict]) -> dict:
    """The 2010 sky is cut into square tiles that overlap a little at the edges.

    A target near an edge sits on two tiles (four at a corner), and each one
    shows only part of the picture. Using all of them fills the picture in.
    """
    urls = {}
    for band in _ZERO_MAGNITUDE_JY:
        tiles = sorted(row["access_url"] for row in rows if row["energy_bandpassname"] == band)
        if tiles:
            urls[band] = tiles
    return urls



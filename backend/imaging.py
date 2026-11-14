"""Turning raw exposures into images that can be compared.

Every exposure is taken at a different angle and position, so raw frames do not
line up. This module:

  1. puts each exposure on one shared north-up grid   (align_exposure)
  2. combines all exposures of a visit into one clean image   (stack_exposures)

It works the same for SPHEREx and WISE; only reading the file differs, and that
lives in spherex.py and wise.py.

Images are returned as 2-D arrays of brightness in MJy/sr with the background
removed (empty sky is about 0). Row 0 is the north edge, column 0 the east
edge, so they can be drawn on screen as they are. Missing pixels are NaN.
"""

import io
import logging
import warnings
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from reproject import reproject_interp

from . import archive, config, s3, spherex, wise
from .cache import cache_file

log = logging.getLogger("uvicorn.error")


def sky_grid(ra: float, dec: float, fov_deg: float) -> tuple[WCS, int]:
    """The shared north-up grid for a target: its coordinate system and width in pixels."""
    pixel_deg = config.OUTPUT_PIXEL_ARCSEC / 3600
    size = int(round(fov_deg / pixel_deg))
    grid = WCS(naxis=2)
    grid.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    grid.wcs.crval = [ra, dec]
    grid.wcs.crpix = [(size + 1) / 2, (size + 1) / 2]
    grid.wcs.cdelt = [-pixel_deg, pixel_deg]  # negative: east is to the left
    return grid, size


def align_exposure(image_url: str, ra: float, dec: float, fov_deg: float) -> dict:
    """One exposure on the shared grid.

    Returns {"image", "wavelength_um"}. The wavelength is NaN for WISE, whose
    bands are fixed.
    """
    key = f"{image_url}:{ra:.5f}:{dec:.5f}:{fov_deg:.3f}:{config.OUTPUT_PIXEL_ARCSEC}"
    path = cache_file("exposures", key, "npz")
    if path.exists():
        with np.load(path) as saved:
            return {name: saved[name] for name in saved.files}

    target_grid, size = sky_grid(ra, dec, fov_deg)
    try:
        # Ask for extra margin so a rotated exposure still fills the corners.
        cutout = _read_cutout(image_url, ra, dec, fov_deg * 1.5)
    except s3.NoOverlap:
        cutout = None  # the exposure misses the picture entirely

    if cutout is None:
        image = np.full((size, size), np.nan)
    else:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            image, _ = reproject_interp(
                (cutout["brightness"], cutout["grid"]), target_grid, shape_out=(size, size)
            )

    image = image.astype("float32")
    if np.isfinite(image).any():
        image -= np.nanmedian(image)  # whatever background is left over
    image = image[::-1]  # FITS stores the south row first; flip so north is on top

    result = {
        "image": image,
        "wavelength_um": np.float32((cutout or {}).get("wavelength_um", np.nan)),
    }
    np.savez(path, **result)
    return result


def _read_cutout(image_url: str, ra: float, dec: float, width_deg: float) -> dict:
    """The region around (ra, dec) of one exposure, before alignment.

    SPHEREx is read from Amazon S3 when possible (about 1-2 s); WISE, and any
    SPHEREx file S3 cannot serve, go through IRSA's cutout service (about 10 s).
    """
    is_spherex = image_url.startswith(config.IRSA_SPHEREX_PREFIX)
    if is_spherex and config.USE_S3:
        try:
            return s3.read_cutout(image_url, ra, dec, width_deg)
        except s3.NoOverlap:
            raise
        except Exception as error:  # any S3 or parsing problem: use IRSA instead
            log.warning("S3 read failed for %s (%s); falling back to IRSA", image_url, error)

    raw = archive.download_cutout(image_url, ra, dec, width_deg)
    with fits.open(io.BytesIO(raw)) as hdul:
        if is_spherex:
            return spherex.read_cutout(hdul, ra, dec)
        return wise.read_cutout(hdul)


def stack_exposures(image_urls: list[str], ra: float, dec: float, fov_deg: float) -> dict:
    """Combine many exposures into one image by taking the median at each pixel.

    The median ignores one-off glitches (cosmic rays, bad pixels) and beats down
    noise, so faint objects appear that no single exposure shows.
    Returns {"image", "used"} where `used` is how many exposures went in.
    """
    key = f"{ra:.5f}:{dec:.5f}:{fov_deg:.3f}:{config.OUTPUT_PIXEL_ARCSEC}:" + ",".join(sorted(image_urls))
    path = cache_file("stacks", key, "npz")
    if path.exists():
        with np.load(path) as saved:
            return {"image": saved["image"], "used": int(saved["used"])}

    def try_align(url: str):
        try:
            return align_exposure(url, ra, dec, fov_deg)["image"]
        except archive.ArchiveError:
            return None  # one lost exposure should not sink the whole stack

    with ThreadPoolExecutor(config.STACK_WORKERS) as pool:
        results = list(pool.map(try_align, image_urls))
    downloaded = [image for image in results if image is not None]
    # An exposure can touch the search circle yet miss the picture entirely.
    images = [image for image in downloaded if np.isfinite(image).any()]
    if not images:
        raise archive.ArchiveError("None of the exposures for this visit could be loaded")

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # pixels that are NaN in every exposure
        stacked = np.nanmedian(np.stack(images), axis=0).astype("float32")

    # Only remember the stack if every download worked, so a temporary archive
    # hiccup is retried next time.
    if len(downloaded) == len(image_urls):
        np.savez(path, image=stacked, used=len(images))
    return {"image": stacked, "used": len(images)}

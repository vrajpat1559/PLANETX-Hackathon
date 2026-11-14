"""SPHEREx Blink web server.

This file only defines the web addresses (routes). The real work lives in:
  targets.py   what the user typed  ->  a sky position
  archive.py   searching and downloading from IRSA
  spherex.py   SPHEREx: its exposure list and file format
  wise.py      WISE: 2010-2024 history from an older telescope
  visits.py    grouping exposures into visits
  imaging.py   aligning and stacking images

Run from the repo root:   uvicorn backend.main:app --reload
"""

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import archive, config, imaging, spherex, targets, wise
from .visits import describe_visit, group_into_visits

app = FastAPI(title="SPHEREx Blink")

# The same three query parameters describe "which patch of sky" everywhere.
RaParam = Query(ge=0, le=360, description="Right ascension, degrees")
DecParam = Query(ge=-90, le=90, description="Declination, degrees")
FovParam = Query(
    config.DEFAULT_FOV_DEG,
    ge=config.MIN_FOV_DEG,
    le=config.MAX_FOV_DEG,
    description="Field of view (width of the picture), degrees",
)


@app.exception_handler(archive.ArchiveError)
def archive_unavailable(request, error):
    return JSONResponse({"detail": str(error)}, status_code=502)


@app.get("/api/config")
def get_config():
    """What the frontend needs to know to build its menus."""
    return {
        "collection": config.COLLECTION,
        "detectors": {
            name: {"min_um": low, "max_um": high, "wise_band": wise.band_for_detector(name)}
            for name, (low, high) in config.DETECTORS.items()
        },
        "fov": {
            "min": config.MIN_FOV_DEG,
            "max": config.MAX_FOV_DEG,
            "default": config.DEFAULT_FOV_DEG,
        },
        "pixel_arcsec": config.OUTPUT_PIXEL_ARCSEC,
    }


@app.get("/api/resolve")
def resolve(q: str = Query(min_length=1, max_length=80)):
    """Turn an object name or typed coordinates into RA/Dec in degrees."""
    try:
        return targets.resolve(q)
    except targets.TargetNotFound as error:
        raise HTTPException(404, str(error))
    except targets.LookupUnavailable as error:
        raise HTTPException(502, str(error))


@app.get("/api/observations")
def observations(ra: float = RaParam, dec: float = DecParam):
    """Everything SPHEREx has at this position: the visits, and each exposure."""
    visits = group_into_visits(spherex.find_exposures(ra, dec))
    exposures = [
        {**exposure, "visit": index}
        for index, visit in enumerate(visits)
        for exposure in visit
    ]
    return {
        "ra": ra,
        "dec": dec,
        "collection": config.COLLECTION,
        "visits": [describe_visit(index, visit) for index, visit in enumerate(visits)],
        "exposures": exposures,
    }


@app.get("/api/stack")
def stack(
    visit: int = Query(ge=0),
    detector: str = Query(pattern="^D[1-6]$"),
    ra: float = RaParam,
    dec: float = DecParam,
    fov: float = FovParam,
):
    """All exposures of one visit in one detector, combined into a single image."""
    visits = group_into_visits(spherex.find_exposures(ra, dec))
    if visit >= len(visits):
        raise HTTPException(404, "No such visit")
    urls = [e["url"] for e in visits[visit] if e["detector"] == detector]
    if not urls:
        raise HTTPException(404, f"No {detector} exposures in this visit")

    result = imaging.stack_exposures(urls, ra, dec, fov)
    return _image_response(result["image"], {"X-Exposures-Used": result["used"]})


@app.get("/api/exposure")
def exposure(url: str, ra: float = RaParam, dec: float = DecParam, fov: float = FovParam):
    """A single exposure, aligned to the same grid as the stacks."""
    if not archive.is_archive_image_url(url):
        raise HTTPException(400, "url must be a SPHEREx image on IRSA")
    result = imaging.align_exposure(url, ra, dec, fov)
    if not np.isfinite(result["image"]).any():
        raise HTTPException(404, "This exposure has no valid pixels at the position")
    return _image_response(
        result["image"], {"X-Wavelength-Um": f"{float(result['wavelength_um']):.4f}"}
    )


@app.get("/api/wise/visits")
def wise_visits(ra: float = RaParam, dec: float = DecParam):
    """The older WISE telescope's visits to this position (2010-2024)."""
    return [
        {
            "index": index,
            "label": visit["label"],
            "date": visit["date"],
            "mjd": visit["mjd"],
            "exposures_per_band": {band: len(urls) for band, urls in visit["urls"].items()},
        }
        for index, visit in enumerate(wise.find_visits(ra, dec))
    ]


@app.get("/api/wise/stack")
def wise_stack(
    visit: int = Query(ge=0),
    band: str = Query(pattern="^W[12]$"),
    ra: float = RaParam,
    dec: float = DecParam,
    fov: float = FovParam,
):
    """One WISE visit as a single image, on the same grid and units as SPHEREx."""
    visits = wise.find_visits(ra, dec)
    if visit >= len(visits) or not visits[visit]["urls"].get(band):
        raise HTTPException(404, f"No {band} images for this WISE visit")
    result = imaging.stack_exposures(visits[visit]["urls"][band], ra, dec, fov)
    return _image_response(result["image"], {"X-Exposures-Used": result["used"]})


def _image_response(image: np.ndarray, extra_headers: dict) -> Response:
    """Send an image as raw 32-bit floats (little-endian, top row first).

    The browser receives real brightness values rather than a finished picture,
    so it can subtract, add and re-stretch images without asking the server.
    """
    headers = {
        "X-Image-Size": str(image.shape[0]),
        "Cache-Control": "public, max-age=86400",
        **{name: str(value) for name, value in extra_headers.items()},
    }
    return Response(
        image.astype("<f4").tobytes(),
        media_type="application/octet-stream",
        headers=headers,
    )


@app.get("/")
def index():
    return FileResponse(config.FRONTEND_DIR / "index.html")


app.mount("/", StaticFiles(directory=config.FRONTEND_DIR), name="frontend")

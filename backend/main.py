"""SPHEREx blink viewer backend.

Finds every SPHEREx exposure that covers a sky position (IRSA image search),
cuts out a small region around it (IRSA cutout service), reprojects each
cutout onto one shared north-up grid so frames line up pixel for pixel, and
returns PNGs that the frontend flips between.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import time
from pathlib import Path

import numpy as np
import requests
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from reproject import reproject_interp

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache"
CACHE.mkdir(exist_ok=True)

SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
COLLECTION = "spherex_dr1"
IRSA_DATA_PREFIX = "https://irsa.ipac.caltech.edu/ibe/data/spherex/"
# Sesame name resolvers, fastest first. The main CDS site redirects to a slow
# mirror, so try the Harvard mirror before it.
SESAME_URLS = [
    "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oI/SN?",
    "https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/SN?",
]
PIXEL_ARCSEC = 6.15  # SPHEREx native pixel scale

# Approximate wavelength coverage of the six detectors, in microns.
BANDS = {
    "D1": "0.75-1.1",
    "D2": "1.1-1.6",
    "D3": "1.6-2.4",
    "D4": "2.4-3.8",
    "D5": "3.8-4.4",
    "D6": "4.4-5.0",
}

app = FastAPI(title="SPHEREx Blink")
session = requests.Session()
session.headers["User-Agent"] = "spherex-blink-viewer"


def fetch(url: str, *, params=None, timeout=120, tries=4) -> requests.Response:
    """GET with retries: IRSA intermittently answers 502 under load."""
    last = "no attempt made"
    for attempt in range(tries):
        try:
            r = session.get(url, params=params, timeout=timeout)
            if r.status_code == 200:
                return r
            last = f"HTTP {r.status_code}"
        except requests.RequestException as exc:
            last = type(exc).__name__
        time.sleep(1.5 * (attempt + 1))
    raise HTTPException(502, f"Archive request failed after {tries} tries ({last})")


def cache_path(kind: str, key: str, ext: str) -> Path:
    digest = hashlib.sha1(key.encode()).hexdigest()[:20]
    return CACHE / f"{kind}-{digest}.{ext}"


@app.get("/api/bands")
def bands():
    return BANDS


@app.get("/api/resolve")
def resolve(name: str = Query(min_length=1, max_length=80)):
    """Turn an object name (M31, Vega, ...) into coordinates via CDS Sesame."""
    reached = False
    for base in SESAME_URLS:
        try:
            # Stream and stop at the coordinate line: some mirrors answer
            # quickly but hold the connection open for a long time.
            with session.get(
                base + requests.utils.quote(name), timeout=15, stream=True
            ) as r:
                if r.status_code != 200:
                    continue
                reached = True
                for line in r.iter_lines(decode_unicode=True):
                    if line and line.startswith("%J "):
                        parts = line.split()
                        return {
                            "name": name,
                            "ra": float(parts[1]),
                            "dec": float(parts[2]),
                        }
        except requests.RequestException:
            continue
    if reached:
        raise HTTPException(404, f"Could not find an object named '{name}'")
    raise HTTPException(502, "The name lookup service is not responding")


@app.get("/api/frames")
def frames(
    ra: float = Query(ge=0, le=360),
    dec: float = Query(ge=-90, le=90),
):
    """List every SPHEREx exposure covering the position, oldest first."""
    key = f"{COLLECTION}:{ra:.5f}:{dec:.5f}"
    path = cache_path("frames", key, "json")
    if path.exists():
        return json.loads(path.read_text())

    r = fetch(
        SIA_URL,
        params={
            "COLLECTION": COLLECTION,
            "POS": f"circle {ra} {dec} 0.01",
            "RESPONSEFORMAT": "csv",
            "MAXREC": 2000,
        },
    )
    out = []
    for row in csv.DictReader(io.StringIO(r.text)):
        url = row.get("access_url", "")
        if not url.startswith(IRSA_DATA_PREFIX) or not url.endswith(".fits"):
            continue
        mjd = float(row["t_min"])
        out.append(
            {
                "id": row["obs_id"],
                "band": row["energy_bandpassname"].replace("SPHEREx-", ""),
                "mjd": mjd,
                "date": Time(mjd, format="mjd").strftime("%Y-%m-%d %H:%M"),
                "url": url,
            }
        )
    out.sort(key=lambda f: f["mjd"])
    result = {"ra": ra, "dec": dec, "count": len(out), "frames": out}
    path.write_text(json.dumps(result))
    return result


def target_grid(ra: float, dec: float, size_deg: float):
    """North-up, east-left tangent grid shared by every frame of a target."""
    n = int(np.clip(round(size_deg * 3600 / PIXEL_ARCSEC), 16, 512))
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.cdelt = [-PIXEL_ARCSEC / 3600, PIXEL_ARCSEC / 3600]
    return w, n


def render(url: str, ra: float, dec: float, size_deg: float) -> bytes:
    # Ask for a slightly larger cutout so rotation doesn't leave empty corners.
    r = fetch(url, params={"center": f"{ra},{dec}", "size": f"{size_deg * 1.5}deg"})
    with fits.open(io.BytesIO(r.content)) as hdul:
        hdu = hdul["IMAGE"]
        data = hdu.data.astype("float32")
        # Remove the smooth zodiacal-light glow so faint sources stand out.
        if "ZODI" in hdul and hdul["ZODI"].data is not None:
            data = data - hdul["ZODI"].data.astype("float32")
        wcs_in = WCS(hdu.header)

    wcs_out, n = target_grid(ra, dec, size_deg)
    grid, _ = reproject_interp((data, wcs_in), wcs_out, shape_out=(n, n))

    good = np.isfinite(grid)
    if not good.any():
        raise HTTPException(404, "This exposure has no valid pixels at the position")
    # Per-frame robust normalisation so frames blink at matching brightness.
    med = np.median(grid[good])
    sigma = 1.4826 * np.median(np.abs(grid[good] - med)) or 1.0
    scaled = np.arcsinh((grid - med) / sigma / 3.0)
    lo, hi = np.arcsinh(-1.0), np.arcsinh(40.0)
    img = np.clip((scaled - lo) / (hi - lo), 0, 1)
    img = np.where(good, img, 0)
    img = (img * 255).astype("uint8")[::-1]  # FITS rows run bottom-up

    buf = io.BytesIO()
    Image.fromarray(img, mode="L").save(buf, format="PNG")
    return buf.getvalue()


@app.get("/api/cutout.png")
def cutout(
    url: str,
    ra: float = Query(ge=0, le=360),
    dec: float = Query(ge=-90, le=90),
    size: float = Query(0.25, ge=0.05, le=0.8, description="Field width in degrees"),
):
    # Only ever fetch from the IRSA SPHEREx archive.
    if not url.startswith(IRSA_DATA_PREFIX) or not url.endswith(".fits") or "?" in url:
        raise HTTPException(400, "url must be a SPHEREx image on IRSA")
    path = cache_path("cut", f"{url}:{ra:.5f}:{dec:.5f}:{size:.3f}", "png")
    if not path.exists():
        path.write_bytes(render(url, ra, dec, size))
    return Response(
        path.read_bytes(),
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/")
def index():
    return FileResponse(ROOT / "frontend" / "index.html")


app.mount("/", StaticFiles(directory=ROOT / "frontend"), name="frontend")

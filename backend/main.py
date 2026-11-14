"""SPHEREx blink viewer backend.

Finds every SPHEREx exposure that covers a sky position (IRSA image search),
cuts out a small region around it, reprojects each cutout onto one shared
north-up grid so frames line up pixel for pixel, and returns PNGs that the
frontend flips between.

Cutouts are read straight from the public S3 copy of the archive with HTTP
range requests (only the header and the needed rows are downloaded). IRSA's
own cutout service is kept as a fallback.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from reproject import reproject_interp

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache"
CACHE.mkdir(exist_ok=True)

SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
COLLECTION = "spherex_dr1"
IRSA_DATA_PREFIX = "https://irsa.ipac.caltech.edu/ibe/data/spherex/"
# Public, anonymous mirror of the same files; supports HTTP range requests.
S3_DATA_PREFIX = "https://nasa-irsa-spherex.s3.amazonaws.com/"
# Sesame name resolvers, fastest first. The main CDS site redirects to a slow
# mirror, so try the Harvard mirror before it.
SESAME_URLS = [
    "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oI/SN?",
    "https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/SN?",
]
PIXEL_ARCSEC = 6.15  # SPHEREx native pixel scale
FITS_BLOCK = 2880  # FITS headers and data are padded to this many bytes
HEADER_GUESS = 14 * FITS_BLOCK  # one request usually covers a whole header
ZODI_ROW_STEP = 16  # the zodiacal model is smooth: sample rows, interpolate

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
session.mount("https://", requests.adapters.HTTPAdapter(pool_maxsize=32))
pool = ThreadPoolExecutor(16)  # parallel range requests to S3


def fetch(url: str, *, params=None, headers=None, timeout=120, tries=4):
    """GET with retries: IRSA intermittently answers 502 under load."""
    last = "no attempt made"
    for attempt in range(tries):
        try:
            r = session.get(url, params=params, headers=headers, timeout=timeout)
            if r.status_code in (200, 206):
                return r
            last = f"HTTP {r.status_code}"
        except requests.RequestException as exc:
            last = type(exc).__name__
        if attempt < tries - 1:
            time.sleep(1.5 * (attempt + 1))
    raise HTTPException(502, f"Archive request failed after {tries} tries ({last})")


def is_spherex_url(url: str) -> bool:
    """Only ever fetch plain image files from the IRSA SPHEREx archive."""
    return url.startswith(IRSA_DATA_PREFIX) and url.endswith(".fits") and "?" not in url


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
        if not is_spherex_url(url):
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


def read_range(url: str, start: int, length: int) -> bytes:
    r = fetch(
        url,
        headers={"Range": f"bytes={start}-{start + length - 1}"},
        timeout=30,
        tries=2,
    )
    if r.status_code != 206:
        raise OSError("server ignored the range request")
    return r.content


def read_header(url: str, offset: int, first: bytes = b""):
    """Read the FITS header starting at `offset`.

    Returns the header and the offset of the HDU's data. `first` may hold
    bytes already downloaded from `offset` onwards.
    """
    raw = first or read_range(url, offset, HEADER_GUESS)
    while True:
        for i in range(0, len(raw) - 79, 80):
            if raw[i : i + 8] == b"END     ":
                size = -(-(i + 80) // FITS_BLOCK) * FITS_BLOCK
                header = fits.Header.fromstring(raw[: i + 80].decode("ascii"))
                return header, offset + size
        more = read_range(url, offset + len(raw), HEADER_GUESS)
        if not more:
            raise OSError("FITS header has no END card")
        raw += more


def data_size(header) -> int:
    """Bytes occupied by an HDU's data, including padding."""
    naxis = header.get("NAXIS", 0)
    if naxis == 0:
        return 0
    pixels = 1
    for axis in range(1, naxis + 1):
        pixels *= header[f"NAXIS{axis}"]
    size = abs(header["BITPIX"]) // 8 * header.get("GCOUNT", 1)
    size *= header.get("PCOUNT", 0) + pixels
    return -(-size // FITS_BLOCK) * FITS_BLOCK


def read_pixels(url: str, header, data_start: int, first: int, count: int):
    """Download `count` consecutive float32 pixels of an image HDU."""
    if header["BITPIX"] != -32 or "BSCALE" in header or "BZERO" in header:
        raise OSError("unexpected pixel format")
    raw = read_range(url, data_start + first * 4, count * 4)
    return np.frombuffer(raw, dtype=">f4").astype("float32")


def read_box(url: str, header, data_start: int, box) -> np.ndarray:
    """Download rows y0..y1 in one request and keep columns x0..x1."""
    x0, x1, y0, y1 = box
    width = header["NAXIS1"]
    rows = read_pixels(url, header, data_start, y0 * width, (y1 - y0) * width)
    return rows.reshape(y1 - y0, width)[:, x0:x1]


def read_box_sparse(url: str, header, data_start: int, box) -> np.ndarray:
    """Like read_box for a smooth image, downloading about 20x fewer bytes.

    Fetches only columns x0..x1 of every ZODI_ROW_STEP-th row (one small
    request each, in parallel) and interpolates the rows in between.
    """
    x0, x1, y0, y1 = box
    width = header["NAXIS1"]
    sampled = sorted({*range(y0, y1, ZODI_ROW_STEP), y1 - 1})
    rows = np.stack(
        list(
            pool.map(
                lambda y: read_pixels(
                    url, header, data_start, y * width + x0, x1 - x0
                ),
                sampled,
            )
        )
    )
    if len(sampled) == 1:
        return rows
    pos = np.interp(np.arange(y0, y1), sampled, np.arange(len(sampled)))
    lo = np.minimum(pos.astype(int), len(sampled) - 2)
    frac = (pos - lo)[:, None].astype("float32")
    return rows[lo] * (1 - frac) + rows[lo + 1] * frac


def load_s3(url: str, ra: float, dec: float, size_deg: float):
    """Zodi-subtracted pixels and WCS around the target, read from S3.

    Only the headers and the pixels that cover the field are downloaded,
    instead of the whole 65 MB file.
    """
    s3 = S3_DATA_PREFIX + url[len(IRSA_DATA_PREFIX) :]
    # The first bytes hold the (tiny) primary header and the IMAGE header.
    head = read_range(s3, 0, FITS_BLOCK + HEADER_GUESS)
    primary, offset = read_header(s3, 0, head)
    offset += data_size(primary)
    header, image_start = read_header(s3, offset, head[offset:])
    if header.get("EXTNAME") != "IMAGE":
        raise OSError("IMAGE is not the first extension")

    wcs_full = WCS(header)  # includes the SIP distortion terms
    cx, cy = wcs_full.all_world2pix(ra, dec, 0)
    # Slightly larger than the field so rotation doesn't leave empty corners.
    half = size_deg * 1.5 * 3600 / PIXEL_ARCSEC / 2 + 2
    nx, ny = header["NAXIS1"], header["NAXIS2"]
    x0, x1 = max(0, int(cx - half)), min(nx, int(cx + half) + 2)
    y0, y1 = max(0, int(cy - half)), min(ny, int(cy + half) + 2)
    if x0 >= x1 or y0 >= y1:
        raise HTTPException(404, "This exposure has no valid pixels at the position")
    box = (x0, x1, y0, y1)

    # Download the image rows while walking the headers to find ZODI.
    image = pool.submit(read_box, s3, header, image_start, box)
    offset, hdr = image_start + data_size(header), header
    while hdr.get("EXTNAME") != "ZODI":
        hdr, start = read_header(s3, offset)
        offset = start + data_size(hdr)
    if (hdr["NAXIS1"], hdr["NAXIS2"]) != (nx, ny):
        raise OSError("ZODI shape differs from IMAGE")
    # Remove the smooth zodiacal-light glow so faint sources stand out.
    data = image.result() - read_box_sparse(s3, hdr, start, box)
    # Slicing shifts the reference pixel of both the linear and SIP parts.
    return data, wcs_full[y0:y1, x0:x1]


def load_irsa(url: str, ra: float, dec: float, size_deg: float):
    """Same as load_s3 but through IRSA's (slower) cutout service."""
    # Ask for a slightly larger cutout so rotation doesn't leave empty corners.
    r = fetch(url, params={"center": f"{ra},{dec}", "size": f"{size_deg * 1.5}deg"})
    with fits.open(io.BytesIO(r.content)) as hdul:
        hdu = hdul["IMAGE"]
        data = hdu.data.astype("float32")
        if "ZODI" in hdul and hdul["ZODI"].data is not None:
            data = data - hdul["ZODI"].data.astype("float32")
        return data, WCS(hdu.header)


def load(url: str, ra: float, dec: float, size_deg: float):
    try:
        return load_s3(url, ra, dec, size_deg)
    except HTTPException as exc:
        if exc.status_code == 404:
            raise
    except Exception:  # any S3 or parsing problem: fall back to IRSA
        pass
    return load_irsa(url, ra, dec, size_deg)


def render(url: str, ra: float, dec: float, size_deg: float, loader=load) -> bytes:
    data, wcs_in = loader(url, ra, dec, size_deg)
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
    if not is_spherex_url(url):
        raise HTTPException(400, "url must be a SPHEREx image on IRSA")
    path = cache_path("cut", f"{url}:{ra:.5f}:{dec:.5f}:{size:.3f}", "png")
    if path.exists():
        png = path.read_bytes()
    else:
        png = render(url, ra, dec, size)
        path.write_bytes(png)
    return Response(
        png,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
    )


# html=True serves frontend/index.html at "/".
app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")

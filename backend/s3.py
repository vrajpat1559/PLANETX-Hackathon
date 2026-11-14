"""Reading SPHEREx pixels straight from NASA's public copy of the archive on Amazon S3.

Why: IRSA's cutout service takes about 10 seconds per exposure, because it opens
the whole 65 MB file on its side before cutting out the piece we asked for.
The same files sit in a public S3 bucket that lets us download any byte range,
so we fetch only the headers and the rows that cover our field: a few hundred
kilobytes, in well under two seconds.

A SPHEREx file is a FITS file: a sequence of "HDUs", each a text header
(80-character cards, padded to 2880-byte blocks) followed by binary data:

    PRIMARY   (empty)
    IMAGE     2040 x 2040 float32 brightness            <- rows we need
    FLAGS     2040 x 2040 int32 bit flags, compressed   <- rows we need
    VARIANCE  (skipped)
    ZODI      2040 x 2040 float32 sky glow model        <- sampled rows
    EPSF      (skipped)
    WCS-WAVE  tiny table: wavelength at each pixel      <- all of it

read_cutout() returns exactly what spherex.read_cutout() returns for an IRSA
cutout, so the rest of the pipeline cannot tell the difference. If anything
here fails, imaging.py falls back to IRSA.
"""

import io
import warnings
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests
from astropy.io import fits
from astropy.io.fits.hdu.compressed import _codecs
from astropy.wcs import WCS

from . import config, spherex

BLOCK = 2880                   # FITS pads everything to multiples of this
HEADER_GUESS = 14 * BLOCK      # one request usually holds a whole header
ZODI_ROW_STEP = 16             # the sky-glow model is smooth: sample rows, interpolate

_session = requests.Session()
_session.headers["User-Agent"] = "spherex-blink-viewer"
_session.mount("https://", requests.adapters.HTTPAdapter(pool_maxsize=32))
_pool = ThreadPoolExecutor(16)       # the four pieces of each exposure
# Row downloads get their own pool: they are started from inside _pool tasks,
# and sharing one pool could leave every worker waiting on queued rows.
_row_pool = ThreadPoolExecutor(32)


class NoOverlap(Exception):
    """The exposure does not cover the requested position."""


def s3_url(irsa_url: str) -> str:
    """The S3 address of a SPHEREx file given its IRSA address."""
    return config.S3_SPHEREX_PREFIX + irsa_url[len(config.IRSA_SPHEREX_PREFIX):]


def read_cutout(irsa_url: str, ra: float, dec: float, width_deg: float) -> dict:
    """The region around (ra, dec) of one SPHEREx exposure, read from S3.

    Same return value as spherex.read_cutout(): brightness (MJy/sr, sky glow
    removed, bad pixels NaN), grid (its coordinate system), wavelength_um,
    bandwidth_um.
    """
    url = s3_url(irsa_url)
    hdus = _walk_headers(url)
    image_header, image_start = hdus["IMAGE"]

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        full_grid = WCS(image_header)  # includes the lens-distortion (SIP) terms
        cx, cy = full_grid.all_world2pix(ra, dec, 0)

    # The block of detector pixels that covers the field, with a small margin.
    half = width_deg * 3600 / config.NATIVE_PIXEL_ARCSEC / 2 + 2
    nx, ny = image_header["NAXIS1"], image_header["NAXIS2"]
    x0, x1 = max(0, int(cx - half)), min(nx, int(cx + half) + 2)
    y0, y1 = max(0, int(cy - half)), min(ny, int(cy + half) + 2)
    if x0 >= x1 or y0 >= y1:
        raise NoOverlap()
    box = (x0, x1, y0, y1)

    # The four downloads are independent, so run them at the same time.
    image = _pool.submit(_read_box, url, *hdus["IMAGE"], box)
    zodi = _pool.submit(_read_box_sparse, url, *hdus["ZODI"], box)
    flags = _pool.submit(_read_compressed_rows, url, *hdus["FLAGS"], box)
    wave_table = _pool.submit(_read_hdu_bytes, url, hdus["WCS-WAVE"])

    flags_header = hdus["FLAGS"][0]
    brightness = spherex.clean_brightness(
        image.result(), zodi.result(), flags_header, flags.result()
    )

    # The wavelength lookup table needs to be an HDU astropy can find by name.
    table_file = fits.HDUList.fromstring(_EMPTY_PRIMARY + wave_table.result())
    wavelength, bandwidth = spherex.wavelength_at(
        image_header, table_file, (ny, nx), ra, dec
    )
    return {
        "brightness": brightness,
        # Slicing a WCS shifts its reference pixel, distortion terms included.
        "grid": full_grid[y0:y1, x0:x1],
        "wavelength_um": wavelength,
        "bandwidth_um": bandwidth,
    }


# ---------- reading pieces of a FITS file over HTTP ----------

def _read_range(url: str, start: int, length: int, tries: int = 2) -> bytes:
    """Bytes start..start+length-1 of a file. Fails fast (10 s) so a slow S3
    moment costs one quick retry, then the IRSA fallback, not a long wait."""
    for attempt in range(tries):
        try:
            response = _session.get(
                url, headers={"Range": f"bytes={start}-{start + length - 1}"}, timeout=(5, 10)
            )
            if response.status_code == 206:
                return response.content
            problem = f"S3 answered {response.status_code} to a range request"
        except requests.RequestException as error:
            problem = f"{type(error).__name__} from S3"
    raise OSError(problem)


def _parse_header(url: str, offset: int, first: bytes = b"") -> tuple[fits.Header, int, int]:
    """The header that starts at `offset`: (header, data start, header bytes)."""
    raw = first
    while True:
        for i in range(0, len(raw) - 79, 80):
            if raw[i:i + 8] == b"END     ":
                size = -(-(i + 80) // BLOCK) * BLOCK
                header = fits.Header.fromstring(raw[:i + 80].decode("ascii"))
                return header, offset + size, size
        more = _read_range(url, offset + len(raw), HEADER_GUESS)
        if not more:
            raise OSError("FITS header has no END card")
        raw += more


def _data_size(header: fits.Header) -> int:
    """Bytes of data after a header, padding included."""
    if header.get("NAXIS", 0) == 0:
        return 0
    count = 1
    for axis in range(1, header["NAXIS"] + 1):
        count *= header[f"NAXIS{axis}"]
    size = abs(header["BITPIX"]) // 8 * header.get("GCOUNT", 1) * (header.get("PCOUNT", 0) + count)
    return -(-size // BLOCK) * BLOCK


def _walk_headers(url: str) -> dict:
    """{EXTNAME: (header, data start)} for every HDU, plus where each header starts."""
    first = _read_range(url, 0, BLOCK + HEADER_GUESS)
    hdus, offset, header_starts = {}, 0, {}
    while True:
        chunk = first[offset:] if offset < len(first) else b""
        header, data_start, _ = _parse_header(url, offset, chunk)
        name = header.get("EXTNAME", "PRIMARY")
        hdus[name] = (header, data_start)
        header_starts[name] = offset
        offset = data_start + _data_size(header)
        if name == "WCS-WAVE":
            break
        if name not in ("PRIMARY", "IMAGE", "FLAGS", "VARIANCE", "ZODI", "EPSF"):
            raise OSError(f"unexpected HDU {name}")
    for needed in ("IMAGE", "FLAGS", "ZODI"):
        if needed not in hdus:
            raise OSError(f"{needed} not found")
    hdus["WCS-WAVE"] = (header_starts["WCS-WAVE"], offset)
    return hdus


def _read_hdu_bytes(url: str, span: tuple[int, int]) -> bytes:
    """An entire (small) HDU, header and data, as raw bytes."""
    start, end = span
    return _read_range(url, start, end - start)


def _check_float32(header: fits.Header):
    if header["BITPIX"] != -32 or "BSCALE" in header or "BZERO" in header:
        raise OSError("unexpected pixel format")


def _read_box(url: str, header: fits.Header, data_start: int, box) -> np.ndarray:
    """Rows y0..y1 in one request, keeping columns x0..x1."""
    _check_float32(header)
    x0, x1, y0, y1 = box
    width = header["NAXIS1"]
    raw = _read_range(url, data_start + y0 * width * 4, (y1 - y0) * width * 4)
    return np.frombuffer(raw, dtype=">f4").reshape(y1 - y0, width)[:, x0:x1].astype("float32")


def _read_box_sparse(url: str, header: fits.Header, data_start: int, box) -> np.ndarray:
    """Like _read_box for a smooth image, downloading about 20x fewer bytes.

    Fetches every ZODI_ROW_STEP-th row (columns x0..x1 only, in parallel) and
    fills the rows in between by straight-line interpolation.
    """
    _check_float32(header)
    x0, x1, y0, y1 = box
    width = header["NAXIS1"]
    sampled = sorted({*range(y0, y1, ZODI_ROW_STEP), y1 - 1})

    def row(y):
        raw = _read_range(url, data_start + (y * width + x0) * 4, (x1 - x0) * 4)
        return np.frombuffer(raw, dtype=">f4").astype("float32")

    rows = np.stack(list(_row_pool.map(row, sampled)))
    if len(sampled) == 1:
        return rows
    position = np.interp(np.arange(y0, y1), sampled, np.arange(len(sampled)))
    low = np.minimum(position.astype(int), len(sampled) - 2)
    fraction = (position - low)[:, None].astype("float32")
    return rows[low] * (1 - fraction) + rows[low + 1] * fraction


def _read_compressed_rows(url: str, header: fits.Header, data_start: int, box) -> np.ndarray:
    """Rows y0..y1 (columns x0..x1) of a tile-compressed integer image.

    FLAGS is stored as a table with one compressed tile per image row. Each
    table row is 8 bytes: (compressed length, offset into the "heap" area
    that follows the table). We read the entries for our rows, download that
    stretch of the heap, and decompress each row.
    """
    if (
        header.get("ZCMPTYPE") != "RICE_1"
        or header.get("ZTILE2") != 1
        or header.get("ZTILE1") != header.get("ZNAXIS1")
        or header.get("TFORM1", "")[:2] != "1P"
    ):
        raise OSError("unexpected FLAGS compression")
    x0, x1, y0, y1 = box
    width = header["ZNAXIS1"]
    row_bytes = header["NAXIS1"]
    heap_start = data_start + header.get("THEAP", row_bytes * header["NAXIS2"])

    table = _read_range(url, data_start + y0 * row_bytes, (y1 - y0) * row_bytes)
    entries = np.frombuffer(table, dtype=">i4").reshape(y1 - y0, row_bytes // 4)[:, :2]
    lengths, offsets = entries[:, 0].astype(int), entries[:, 1].astype(int)
    first, last = offsets.min(), (offsets + lengths).max()
    heap = _read_range(url, heap_start + first, last - first)

    params = {header[f"ZNAME{i}"]: header[f"ZVAL{i}"] for i in (1, 2) if f"ZNAME{i}" in header}
    codec = _codecs.Rice1(
        blocksize=params.get("BLOCKSIZE", 32), bytepix=params.get("BYTEPIX", 4), tilesize=width
    )
    heap = np.frombuffer(heap, dtype=np.uint8)
    rows = [
        codec.decode(heap[offset - first:offset - first + length])
        for offset, length in zip(offsets, lengths)
    ]
    return np.stack(rows)[:, x0:x1].astype(np.int64)


def _empty_primary() -> bytes:
    buffer = io.BytesIO()
    fits.PrimaryHDU().writeto(buffer)
    return buffer.getvalue()


_EMPTY_PRIMARY = _empty_primary()

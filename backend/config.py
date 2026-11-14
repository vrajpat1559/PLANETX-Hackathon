"""Every setting in one place.

If a new SPHEREx data release comes out, the only change needed is COLLECTION
(or set the SPHEREX_COLLECTION environment variable and restart).
"""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT / "frontend"
CACHE_DIR = ROOT / ".cache"

# ---------- where the data comes from ----------

# IRSA (NASA's infrared archive at Caltech) hosts the SPHEREx images.
IRSA_SEARCH_URL = "https://irsa.ipac.caltech.edu/SIA"
IRSA_DATA_PREFIXES = (
    "https://irsa.ipac.caltech.edu/ibe/data/spherex/",
    "https://irsa.ipac.caltech.edu/ibe/data/wise/",
)
COLLECTION = os.environ.get("SPHEREX_COLLECTION", "spherex_dr1")

# WISE, the older telescope used for the 2010-2024 history (see wise.py).
WISE_2010_COLLECTION = "wise_allwise"   # one deep image of the sky as it was in 2010
NEOWISE_COLLECTION = "neowiser"         # single exposures, every six months 2014-2024
WISE_SEARCH_CACHE_HOURS = 24 * 365      # the WISE mission has ended; its list never changes
WISE_MAX_EXPOSURES_PER_VISIT = 16

# IRSA answers "502" when hit with too many requests at once.
MAX_ARCHIVE_CONNECTIONS = 4
# How long a "which exposures cover this spot" answer is reused before we ask
# IRSA again. Keeps the tool current as new data arrives.
SEARCH_CACHE_HOURS = 6

# Name lookup (Sesame). The Harvard mirror is faster than the main CDS site.
SESAME_URLS = [
    "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oI/SN?",
    "https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/SN?",
]

# ---------- the instrument ----------

NATIVE_PIXEL_ARCSEC = 6.15

# Wavelength range of each of the six detectors, in microns.
DETECTORS = {
    "D1": (0.75, 1.11),
    "D2": (1.10, 1.63),
    "D3": (1.63, 2.43),
    "D4": (2.42, 3.83),
    "D5": (3.81, 4.42),
    "D6": (4.41, 5.01),
}

# Pixels with any of these problems are thrown away before images are combined.
# The names come from the FLAGS extension of every SPHEREx image.
# Deliberately NOT listed: TRANSIENT and OUTLIER (a moving object can trigger
# them, and moving objects are what we are looking for), SUR_ERROR (set on the
# usable wings of bright stars) and SOURCE ("a known star or galaxy is here").
BAD_PIXEL_FLAGS = ["NONFUNC", "MISSING_DATA", "HOT", "COLD"]

# The very centre of a bright star overflows the detector and arrives empty.
# Those pixels are filled with the brightest value in the exposure, so the star
# looks like a bright star instead of a star with a black hole in it.
SATURATED_FLAGS = ["OVERFLOW"]

# ---------- how we build images ----------

# Output images use pixels half the native size. The nearby stars we care about
# move only about one native pixel per year, so the finer grid keeps small
# shifts visible instead of rounding them away.
OUTPUT_PIXEL_ARCSEC = NATIVE_PIXEL_ARCSEC / 2

MIN_FOV_DEG = 0.05
MAX_FOV_DEG = 0.5
DEFAULT_FOV_DEG = 0.25

# SPHEREx returns to the same patch of sky roughly every six months and takes
# a burst of exposures over a few weeks. Exposures separated by more than this
# many days belong to different visits.
VISIT_GAP_DAYS = 30
# Near the poles a telescope can watch one spot for months without a break.
# Such a long run is cut into pieces of at most this many days.
VISIT_MAX_DAYS = 120

# Catalogue positions are for the year 2000. Fast-moving stars are shifted to
# where they are at this date so they sit in the middle of the picture.
POSITION_EPOCH_YEAR = 2026.0

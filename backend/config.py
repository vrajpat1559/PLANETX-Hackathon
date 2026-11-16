"""Every setting in one place.

New SPHEREx data is picked up automatically: the search covers every SPHEREx
release (see SPHEREX_SEARCH), and answers are refreshed every
SEARCH_CACHE_HOURS. To pin specific releases instead, set the
SPHEREX_COLLECTIONS environment variable and restart.
"""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT / "frontend"
CACHE_DIR = ROOT / ".cache"
# The most disk space the cache may use, in megabytes. When it goes over, the
# files that have gone longest without being used are deleted (see cache.py).
# 1000 MB holds the finished pictures for a few hundred targets.
CACHE_MAX_MB = int(os.environ.get("CACHE_MAX_MB", "1000"))

# ---------- where the data comes from ----------

# IRSA (NASA's infrared archive at Caltech) hosts the SPHEREx images.
IRSA_SEARCH_URL = "https://irsa.ipac.caltech.edu/SIA"
IRSA_DATA_PREFIXES = (
    "https://irsa.ipac.caltech.edu/ibe/data/spherex/",
    "https://irsa.ipac.caltech.edu/ibe/data/wise/",
)

# Which SPHEREx images to search. By default: every release of the mission.
# SPHEREx data comes in two kinds of release, and both are wanted:
#   spherex_qr3, qr4 ...  "Quick Releases", new images added every week,
#                         about a month after they are taken
#   spherex_dr1, dr2 ...  "Data Releases", the same images reprocessed later
# Searching by mission instead of by name means a new release appears in the
# tool by itself, with no code change. Where the same exposure is in two
# releases, the better one is used (see spherex.release_rank).
SPHEREX_SEARCH = {"FACILITY": "SPHEREx", "CALIB": 2, "DPTYPE": "image"}
# Escape hatch: a comma-separated list of collections to use instead,
# e.g. SPHEREX_COLLECTIONS=spherex_dr1,spherex_qr3
SPHEREX_COLLECTIONS = [
    name.strip()
    for name in os.environ.get("SPHEREX_COLLECTIONS", os.environ.get("SPHEREX_COLLECTION", "")).split(",")
    if name.strip()
]

# NASA keeps a public copy of the SPHEREx files on Amazon S3 that allows
# downloading byte ranges, so we read only the pixels we need (see s3.py).
# Same folder layout as IRSA. Set USE_S3=0 to always use IRSA's cutout service.
IRSA_SPHEREX_PREFIX = IRSA_DATA_PREFIXES[0]
S3_SPHEREX_PREFIX = "https://nasa-irsa-spherex.s3.amazonaws.com/"
USE_S3 = os.environ.get("USE_S3", "1") != "0"
# The WISE exposures from 2014-2024 ("NEOWISE") are on S3 as well. Each file is
# only 4 MB, so we download whole frames: about 2 s for a visit, against 15-30 s
# through IRSA's cutout service, which also starts refusing requests (HTTP 503)
# when asked for many cutouts in a row.
IRSA_NEOWISE_PREFIX = "https://irsa.ipac.caltech.edu/ibe/data/wise/neowiser/p1bm_frm/"
S3_NEOWISE_PREFIX = "https://nasa-irsa-wise.s3.us-west-2.amazonaws.com/wise/neowiser/images/p1bm_frm/"
# The 2010 WISE images are 67 MB tiles; from those we read only the rows we need.
IRSA_WISE_2010_PREFIX = "https://irsa.ipac.caltech.edu/ibe/data/wise/allwise/p3am_cdd/"
S3_WISE_2010_PREFIX = "https://nasa-irsa-wise.s3.us-west-2.amazonaws.com/wise/allwise/images/p3am_cdd/"

# WISE, the older telescope used for the 2010-2024 history (see wise.py).
WISE_2010_COLLECTION = "wise_allwise"   # one deep image of the sky as it was in 2010
NEOWISE_COLLECTION = "neowiser"         # single exposures, every six months 2014-2024
WISE_SEARCH_CACHE_HOURS = 24 * 365      # the WISE mission has ended; its list never changes
WISE_MAX_EXPOSURES_PER_VISIT = 16

# IRSA answers "502" when hit with too many requests at once.
MAX_ARCHIVE_CONNECTIONS = 4
# Exposures aligned at the same time when building a stack. Higher than the
# IRSA limit because S3 has no such limit; IRSA calls still queue at 4.
STACK_WORKERS = int(os.environ.get("STACK_WORKERS", "8"))
# How many stacks may be built at the same time (0 = no limit). Each build
# holds its exposures in memory, so a small server (such as Render's free plan,
# 512 MB) sets this to 1; other requests then wait their turn.
STACKS_AT_ONCE = int(os.environ.get("STACKS_AT_ONCE", "0"))
# How long a "which exposures cover this spot" answer is reused before we ask
# IRSA again. Keeps the tool current as new data arrives.
SEARCH_CACHE_HOURS = 6

# Name lookup (Sesame). The Harvard mirror is faster than the main CDS site.
# "SNV" = ask Simbad, then NED, then VizieR; the first one that knows the name wins.
SESAME_URLS = [
    "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oI/SNV?",
    "https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/SNV?",
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
# The most SPHEREx exposures combined into one image. An ordinary visit has
# about 20 per detector; the deep fields at the ecliptic poles have over 1,000.
SPHEREX_MAX_EXPOSURES_PER_VISIT = 40

# Catalogue positions are for the year 2000. Fast-moving stars are shifted to
# where they are at this date so they sit in the middle of the picture.
POSITION_EPOCH_YEAR = 2026.0

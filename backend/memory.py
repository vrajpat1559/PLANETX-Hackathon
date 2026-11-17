"""Keeping the server's memory use down, and visible.

The free hosting plan stops the server if it ever uses more than 512 MB.
Building one image only needs about 150 MB of working space, but on Linux
that space is not handed back when the build is done: Python and the C
library keep it "just in case", in fragments too small to reuse well. Build
after build the server's footprint creeps up until it is stopped.

release() hands the leftovers back after each build. used_mb() says how
much the server holds right now, for the log (the free plan has no memory
graph, so the log is the only place to see it).
"""

import ctypes
import gc
import resource
import sys

_libc = None
if sys.platform == "linux":
    try:
        _libc = ctypes.CDLL("libc.so.6")
    except OSError:
        pass  # a Linux without glibc (Alpine, for one): nothing to trim


def release() -> None:
    """Give memory that is no longer used back to the operating system."""
    gc.collect()                 # drop Python objects nothing refers to any more
    if _libc is not None:
        _libc.malloc_trim(0)     # then return the freed space itself (glibc only)


def used_mb() -> float:
    """How much memory the server holds, in megabytes.

    On Linux this is the current figure. Elsewhere (a Mac or Windows laptop)
    only the highest figure so far is available, which is fine for a log.
    """
    try:
        with open("/proc/self/statm") as file:
            pages = int(file.read().split()[1])
        return pages * resource.getpagesize() / 1e6
    except OSError:
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return peak / 1e6 if sys.platform == "darwin" else peak / 1e3

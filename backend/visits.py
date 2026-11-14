"""Grouping exposures into visits.

SPHEREx comes back to the same patch of sky about every six months and takes a
burst of exposures over a few weeks. One burst is one "visit". Comparing visits
is how you see things move.
"""

from astropy.time import Time

from .config import VISIT_GAP_DAYS, VISIT_MAX_DAYS


def group_into_visits(exposures: list[dict]) -> list[list[dict]]:
    """Split time-sorted exposures wherever there is a long gap.

    Works for any list of dicts that have an "mjd" (the date as a day number).
    """
    visits: list[list[dict]] = []
    for exposure in exposures:
        if visits:
            long_gap = exposure["mjd"] - visits[-1][-1]["mjd"] > VISIT_GAP_DAYS
            too_long = exposure["mjd"] - visits[-1][0]["mjd"] > VISIT_MAX_DAYS
        if not visits or long_gap or too_long:
            visits.append([])
        visits[-1].append(exposure)
    return visits


def describe_visit(index: int, exposures: list[dict]) -> dict:
    """A summary of one visit for the frontend."""
    start = Time(exposures[0]["mjd"], format="mjd")
    end = Time(exposures[-1]["mjd"], format="mjd")
    middle = Time((start.mjd + end.mjd) / 2, format="mjd")

    per_detector: dict[str, int] = {}
    for exposure in exposures:
        per_detector[exposure["detector"]] = per_detector.get(exposure["detector"], 0) + 1

    return {
        "index": index,
        "label": _month_range(start, end),
        "start": start.strftime("%Y-%m-%d"),
        "end": end.strftime("%Y-%m-%d"),
        "mid_mjd": middle.mjd,
        "exposures_per_detector": per_detector,
    }


def _month_range(start: Time, end: Time) -> str:
    """'May 2025', 'Aug-Oct 2025' or 'Dec 2025-Jan 2026'."""
    a, b = start.to_datetime(), end.to_datetime()
    if (a.year, a.month) == (b.year, b.month):
        return a.strftime("%b %Y")
    if a.year == b.year:
        return f"{a.strftime('%b')}-{b.strftime('%b %Y')}"
    return f"{a.strftime('%b %Y')}-{b.strftime('%b %Y')}"

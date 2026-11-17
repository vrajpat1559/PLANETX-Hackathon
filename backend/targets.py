"""Turning what the user typed into a sky position.

Accepts:
  "150.0 2.2"                          decimal degrees
  "08h55m10.831s -7d14m42.53s"         hours/minutes/seconds
  "08 55 10.83 -07 14 42.5"            the same, space separated
  "Barnard's Star"                     an object name (looked up at CDS)
"""

import json
import math
import re

import requests
from astropy import units as u
from astropy.coordinates import SkyCoord

from . import config


class TargetNotFound(Exception):
    pass


class LookupUnavailable(Exception):
    pass


_TWO_NUMBERS = re.compile(r"^([+-]?\d+(?:\.\d+)?)[\s,]+([+-]?\d+(?:\.\d+)?)$")
# Starts with a digit or sign, and holds only what coordinates are written with.
# (Without the first rule, names like "M31" or "HD 1" would pass: m, h, d and s are unit letters.)
_LOOKS_LIKE_COORDINATES = re.compile(r"^[+\-\d][\d\s.:+\-hmsd°'\",]*$", re.IGNORECASE)


def resolve(text: str) -> dict:
    """Returns {"ra", "dec", "label", "note"} with ra/dec in degrees."""
    text = text.strip()

    decimal = _TWO_NUMBERS.match(text)
    if decimal:
        ra, dec = float(decimal.group(1)), float(decimal.group(2))
        if not (0 <= ra <= 360 and -90 <= dec <= 90):
            raise TargetNotFound("RA must be 0 to 360 and Dec -90 to 90 degrees")
        return {"ra": ra, "dec": dec, "label": text, "note": ""}

    if _LOOKS_LIKE_COORDINATES.match(text):
        try:
            position = SkyCoord(text.replace(",", " "), unit=(u.hourangle, u.deg))
        except ValueError:
            raise TargetNotFound(
                f"Could not read '{text}' as coordinates. "
                "Try '08h55m10.8s -7d14m42s' or '133.795 -7.245'."
            ) from None
        return {"ra": float(position.ra.deg), "dec": float(position.dec.deg), "label": text, "note": ""}

    return _saved_examples().get(text.lower()) or _look_up_name(text)


def _saved_examples() -> dict:
    """The example targets' positions, saved by seed.py, so the examples open
    even when the name lookup service is down. {lower-case name: resolve() result}"""
    global _examples
    if _examples is None:
        try:
            _examples = json.loads((config.SEED_DIR / "targets.json").read_text())
        except (OSError, ValueError):
            _examples = {}
    return _examples


_examples = None


def _look_up_name(name: str) -> dict:
    # The catalogues list the Gliese nearby-star catalogue as "GJ 876", not "Gliese 876".
    name = re.sub(r"^gliese\s*", "GJ ", name, flags=re.IGNORECASE)
    for base_url in config.SESAME_URLS:
        try:
            found = _ask_sesame(base_url, name)
        except requests.RequestException:
            continue
        if found:
            return _move_to_today(name, **found)
        # The mirrors share one catalogue: if one does not know the name, none will.
        raise TargetNotFound(f"Could not find an object named '{name}'")
    raise LookupUnavailable("The name lookup service is not responding")


def _ask_sesame(base_url: str, name: str) -> dict | None:
    """Read position (%J) and proper motion (%P) lines from a Sesame reply."""
    found = {}
    # Stream and stop early: some mirrors answer fast but keep the connection open.
    with requests.get(base_url + requests.utils.quote(name), timeout=15, stream=True) as reply:
        reply.raise_for_status()
        for line in reply.iter_lines(decode_unicode=True):
            line = line or ""
            parts = line.split()
            if line.startswith("%J ") and "ra" not in found:
                found["ra"], found["dec"] = float(parts[1]), float(parts[2])
            elif line.startswith("%P ") and "ra" in found:
                found["pm_ra"], found["pm_dec"] = float(parts[1]), float(parts[2])
                break
            elif line.startswith(("%X", "#B", "#=")) and "ra" in found:
                break  # past the place where a %P line would have been
            elif line.startswith("#====Done"):
                break  # end of the reply; do not wait for the server to hang up
    return found if "ra" in found else None


def _move_to_today(name: str, ra: float, dec: float, pm_ra: float = 0.0, pm_dec: float = 0.0) -> dict:
    """Shift a year-2000 catalogue position by the star's proper motion.

    pm_ra and pm_dec are in milliarcseconds per year (pm_ra already includes
    the cos(dec) factor, as catalogues give it).
    """
    years = config.POSITION_EPOCH_YEAR - 2000.0
    shift_ra_arcsec = pm_ra / 1000 * years
    shift_dec_arcsec = pm_dec / 1000 * years
    total_shift = math.hypot(shift_ra_arcsec, shift_dec_arcsec)

    note = ""
    if total_shift > 3:  # more than half a SPHEREx pixel
        ra += shift_ra_arcsec / 3600 / math.cos(math.radians(dec))
        dec += shift_dec_arcsec / 3600
        speed = math.hypot(pm_ra, pm_dec) / 1000
        note = (
            f"This object moves {speed:.1f} arcseconds per year, so the view is centred "
            f"where it should be in {config.POSITION_EPOCH_YEAR:.0f} "
            f"({total_shift:.0f} arcseconds from its year-2000 catalogue position)."
        )
    return {"ra": ra % 360, "dec": dec, "label": name, "note": note}

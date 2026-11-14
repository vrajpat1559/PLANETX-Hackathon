# SPHEREx Blink

A web tool for the PLANETX hackathon challenge: type a sky position, and flip
between NASA SPHEREx images of it taken months apart so anything that moves or
changes brightness stands out.

## Run it

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt     # macOS/Linux: .venv/bin/python
.venv/Scripts/python -m uvicorn backend.main:app --reload
```

Then open http://localhost:8000.

## How it works

SPHEREx returns to each patch of sky about every six months and takes a burst
of exposures over a few weeks. We call one burst a **visit**.

1. **Find the target.** A name is looked up at CDS (Sesame). Fast-moving stars
   are shifted from their year-2000 catalogue position to where they are now.
2. **Find the exposures.** IRSA's image search lists every SPHEREx exposure
   covering the position. We group them into visits.
3. **Build one image per visit.** For the chosen detector, every exposure in
   the visit is cut out, lined up on a shared north-up grid, and combined by
   taking the median. This is much cleaner than any single exposure.
   Pixels are read straight from NASA's public copy of the archive on Amazon
   S3, downloading only what covers the field. IRSA's own cutout service is
   kept as an automatic fallback: it is slower and starts refusing requests
   (HTTP 503) when asked for many cutouts in a row. At most 40 exposures go
   into one image; the deep fields at the ecliptic poles have over 1,000 per
   visit.
4. **Blink.** The browser receives real brightness values (not finished
   pictures), so it can blink, subtract and add images with one shared
   brightness scale. "Highlight changes" paints whatever got brighter since
   the previous image green and whatever got fainter magenta, so a moving
   star shows up as a magenta/green pair.
5. **Add 15 years of history.** SPHEREx only started in 2025, and nearby stars
   move about one pixel between its visits. So the timeline also shows images
   from WISE, an older NASA infrared telescope: one from 2010 and one for each
   visit from 2014 to 2024. They are put on the same grid and converted to the
   same brightness units, so a fast-moving star visibly walks across the frame.
   WISE images are read from S3 as well.

Why combine per visit instead of blinking raw exposures? SPHEREx's filters
change colour across each detector, so the same star is seen at a different
wavelength in every exposure. Raw exposures flicker for that reason alone.

## Where things are

```
backend/
  config.py    every setting (data release, pixel size, which flags are "bad")
  main.py      the web addresses (routes) and nothing else
  targets.py   name or typed coordinates -> RA/Dec
  archive.py   searching and downloading from IRSA
  s3.py        reading only the needed SPHEREx pixels from Amazon S3
  spherex.py   SPHEREx: its exposure list and file format
  wise.py      WISE: its visits (2010-2024) and file format
  visits.py    grouping exposures into visits
  imaging.py   aligning and stacking images
  cache.py     on-disk cache (the .cache/ folder; safe to delete)
frontend/
  index.html   the page
  style.css
  js/app.js        page logic: load, show, play, address bar
  js/api.js        calls to the backend
  js/picture.js    brightness values -> pixels on screen
  js/timeline.js   the row of dots under the picture
  js/starfield.js  the decorative star background
```

## The cache

Finished pictures are kept in `.cache/` so a target that has been viewed once
reloads in about a second. The folder is limited to 1000 MB (`CACHE_MAX_MB`
in `backend/config.py`, or the environment variable of the same name). When
it fills up, the files that have gone longest without being used are deleted,
raw exposures before finished pictures. It is always safe to delete the
whole folder.

## Linking to a view

The address bar always describes the current view, so it can be shared or
embedded:

```
/?ra=269.44627&dec=4.76820&fov=0.25&band=D2&mode=visits&history=some&name=Barnard's Star
/?name=RW Aur
```

## When new data is released

Nothing to do. NASA publishes new SPHEREx images every week in a "quick
release" (`spherex_qr3` today), about a month after they are taken, and
reprocessed "data releases" (`spherex_dr1`, later `dr2` ...) less often. The
tool searches every SPHEREx release at once (`SPHEREX_SEARCH` in
`backend/config.py`), so new weeks and whole new releases appear by
themselves within six hours (`SEARCH_CACHE_HOURS`). Where an exposure is in
two releases, the data release is used.

- `GET /api/observations?...&refresh=true` asks the archive again right away.
- `GET /api/latest` reports the newest week in NASA's archive and when it was
  uploaded, for a "data current as of" label.
- To pin specific releases instead, set `SPHEREX_COLLECTIONS=spherex_dr1,spherex_qr3`.

## Data

Images: [SPHEREx](https://irsa.ipac.caltech.edu/Missions/spherex.html) and
[WISE/NEOWISE](https://irsa.ipac.caltech.edu/Missions/wise.html) at IRSA
(NASA/JPL-Caltech/IPAC). Name lookup: [CDS Sesame](https://cds.unistra.fr/cgi-bin/Sesame).

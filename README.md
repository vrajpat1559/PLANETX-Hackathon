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
   SPHEREx pixels are read straight from NASA's public copy of the archive on
   Amazon S3, downloading only the rows that cover the field (about 2 s per
   exposure instead of about 10 s through IRSA's cutout service, which is kept
   as an automatic fallback and is still used for WISE).
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

## Linking to a view

The address bar always describes the current view, so it can be shared or
embedded:

```
/?ra=269.44627&dec=4.76820&fov=0.25&band=D2&mode=visits&history=some&name=Barnard's Star
/?name=RW Aur
```

## When new data is released

Set `COLLECTION` in `backend/config.py` (or the `SPHEREX_COLLECTION`
environment variable) to the new IRSA collection name and restart. New
exposures inside the current collection are picked up automatically within
six hours.

## Data

Images: [SPHEREx](https://irsa.ipac.caltech.edu/Missions/spherex.html) and
[WISE/NEOWISE](https://irsa.ipac.caltech.edu/Missions/wise.html) at IRSA
(NASA/JPL-Caltech/IPAC). Name lookup: [CDS Sesame](https://cds.unistra.fr/cgi-bin/Sesame).

# SPHEREx Blink

Our entry for the NASA Space Apps 2026 challenge
[Planet X and SPHEREx](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/).

A public web tool that shows NASA SPHEREx images of any patch of sky and lets
you flip ("blink") between exposures taken at different times, so anything that
moves or changes stands out.

## Run it

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn backend.main:app --port 8000
```

Then open http://localhost:8000.

## How it works

1. **Find exposures.** The backend asks the IRSA image search (SIA, collection
   `spherex_dr1`) for every SPHEREx exposure covering the chosen position.
2. **Cut out.** For each exposure it requests a small cutout from IRSA rather
   than downloading the full 65 MB image.
3. **Align.** Each cutout is reprojected onto one shared north-up grid, so the
   same star lands on the same pixel in every frame. The zodiacal-light
   background is subtracted and brightness is normalised per frame.
4. **Blink.** The frontend steps through the frames, or shows the difference
   between a frame and the first one.

Results are cached in `.cache/`, so a frame is slow only the first time.

## Layout

- `backend/main.py` — FastAPI app: `/api/frames`, `/api/cutout.png`, `/api/resolve`
- `frontend/` — plain HTML, CSS and JavaScript, no build step

## Known limits

- Each SPHEREx detector is a linear variable filter, so the exact wavelength at
  a given sky position differs from exposure to exposure within a band. Some
  brightness change between frames is colour, not variability.
- Name lookup only works for fixed objects. Asteroids and comets need an
  ephemeris lookup, which is not built yet.

## Data

SPHEREx data comes from the NASA/IPAC Infrared Science Archive (IRSA).

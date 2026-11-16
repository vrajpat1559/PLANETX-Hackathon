// Turning brightness values into pixels on screen.
//
// An "image" here is a Float32Array of sky brightness, one number per pixel,
// with empty sky at about 0 and missing pixels as NaN.

const MISSING_COLOUR = [40, 20, 20]; // dark red, so gaps do not look like dark sky

// How much the empty sky jitters from pixel to pixel. Everything is drawn
// relative to this, so the same settings work for faint and bright fields.
export function noiseLevel(pixels) {
  const sample = [];
  const stride = Math.max(1, Math.floor(pixels.length / 20000));
  for (let i = 0; i < pixels.length; i += stride) {
    if (Number.isFinite(pixels[i])) sample.push(Math.abs(pixels[i]));
  }
  if (!sample.length) return 1;
  sample.sort((a, b) => a - b);
  // Median absolute value, scaled to match a standard deviation.
  return 1.4826 * sample[Math.floor(sample.length / 2)] || 1;
}

// The "asinh" curve is close to a straight line for faint things and close to
// a logarithm for bright ones, so faint dots and bright stars both show.
function compress(value, noise) {
  return Math.asinh(value / (3 * noise));
}

// Draw an image. `whiteLevel` is how many times the noise counts as pure white.
export function paintImage(context, pixels, size, noise, whiteLevel) {
  const black = compress(-2 * noise, noise);
  const white = compress(whiteLevel * noise, noise);
  paint(context, size, (i) => {
    const value = pixels[i];
    if (!Number.isFinite(value)) return null;
    return (compress(value, noise) - black) / (white - black);
  });
}

// Draw (image - reference). Grey = no change, white = flux increase, black = flux decrease.
export function paintDifference(context, pixels, reference, size, noise, whiteLevel) {
  const full = compress((whiteLevel / 4) * noise, noise);
  paint(context, size, (i) => {
    const change = pixels[i] - reference[i];
    if (!Number.isFinite(change)) return null;
    return 0.5 + (0.5 * compress(change, noise)) / full;
  });
}

// ---------- highlighting changes ----------

const CHANGE_SIGMA = 4;            // a change must be this many times the noise to count
const CHANGE_FRACTION = 0.5;       // ...and at least half of how bright that spot is
const MIN_SPOT_PIXELS = 4;         // tiny blips (cosmic rays, glitches) are ignored
const STEADY_STAR_SIGMA = 100;     // a star this bright (in noise units) in BOTH images...
const STEADY_STAR_REACH = 1;       // ...within this many pixels makes small changes near it not count
const MAX_SPOT_STRETCH = 3;        // spots longer than 3x their width are streaks, not stars
const BRIGHTER = [60, 255, 130];   // green
const FAINTER = [255, 70, 220];    // magenta (green/magenta is safe for colour-blind viewers)

// Draw `pixels` dimmed, with spots that got brighter than in `previous` painted
// green and spots that got fainter painted magenta. Returns how many spots changed.
//
// A moving object shows up as a pair: magenta where it was, green where it is now.
export function paintHighlights(context, pixels, previous, size, noise, whiteLevel) {
  const count = size * size;

  // Change at every pixel, and how much the change jitters for no reason.
  const change = new Float32Array(count);
  for (let i = 0; i < count; i++) change[i] = pixels[i] - previous[i];
  const changeNoise = noiseLevel(change);
  const threshold = CHANGE_SIGMA * changeNoise;

  // Bright stars that are in both images. The telescope is turned a little
  // differently on every visit, so a bright star's shape never quite matches
  // and leaves green/magenta leftovers around it. Near such a star, a change
  // is compared with the star's brightness, not just the pixel's own.
  const steady = steadyStars(pixels, previous, size, STEADY_STAR_SIGMA * changeNoise);

  // +1 brighter, -1 fainter, 0 no real change. A star that is simply a bit
  // sharper or blurrier in one image changes by a small fraction of its
  // brightness; something that appeared or vanished changes by nearly all of it.
  const sign = new Int8Array(count);
  for (let i = 0; i < count; i++) {
    const own = Math.max(Math.abs(pixels[i]), Math.abs(previous[i]));
    const big = Math.abs(change[i]) > threshold;
    const large = Math.abs(change[i]) > CHANGE_FRACTION * Math.max(own, steady[i]);
    if (big && large) sign[i] = change[i] > 0 ? 1 : -1;
  }

  // Group touching pixels with the same sign; keep groups big enough to be real.
  const keep = new Uint8Array(count);
  const seen = new Uint8Array(count);
  let spots = 0;
  for (let start = 0; start < count; start++) {
    if (!sign[start] || seen[start]) continue;
    const group = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop();
      group.push(p);
      const x = p % size, y = (p - x) / size;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const q = ny * size + nx;
          if (!seen[q] && sign[q] === sign[start]) { seen[q] = 1; stack.push(q); }
        }
      }
    }
    if (group.length >= MIN_SPOT_PIXELS && stretch(group, size) <= MAX_SPOT_STRETCH) {
      spots++;
      for (const p of group) keep[p] = 1;
    }
  }

  // Draw the normal picture at 60% brightness, then colour the changed spots.
  const black = compress(-2 * noise, noise);
  const white = compress(whiteLevel * noise, noise);
  context.canvas.width = size;
  context.canvas.height = size;
  const output = context.createImageData(size, size);
  for (let i = 0; i < count; i++) {
    const value = pixels[i];
    let rgb;
    if (keep[i]) {
      rgb = sign[i] > 0 ? BRIGHTER : FAINTER;
    } else if (!Number.isFinite(value)) {
      rgb = MISSING_COLOUR;
    } else {
      const shade = Math.max(0, Math.min(1, (compress(value, noise) - black) / (white - black)));
      const grey = shade * 255 * 0.6;
      rgb = [grey, grey, grey];
    }
    output.data.set([rgb[0], rgb[1], rgb[2], 255], 4 * i);
  }
  context.putImageData(output, 0, 0);
  return spots;
}

// For every pixel: how bright the steady star next to it is, or 0 if there is
// none. "Steady" means at least `minimum` bright in both images (the brightest
// pixel within STEADY_STAR_REACH, in each image, and the dimmer of those two),
// so a star that appeared, vanished or flared is not counted as steady.
function steadyStars(pixels, previous, size, minimum) {
  const r = STEADY_STAR_REACH;
  const result = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let nowPeak = 0, beforePeak = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const j = ny * size + nx;
          if (pixels[j] > nowPeak) nowPeak = pixels[j];          // NaN fails ">" so gaps are skipped
          if (previous[j] > beforePeak) beforePeak = previous[j];
        }
      }
      const both = Math.min(nowPeak, beforePeak);
      if (both > minimum) result[y * size + x] = both;
    }
  }
  return result;
}

// How stretched a group of pixels is: the length of its long side divided by
// its short side (1 = round). Worked out from how the pixels spread around
// their centre, like the principal axes of an ellipse.
function stretch(group, size) {
  let cx = 0, cy = 0;
  for (const p of group) { cx += p % size; cy += Math.floor(p / size); }
  cx /= group.length; cy /= group.length;
  let xx = 0, yy = 0, xy = 0;
  for (const p of group) {
    const dx = (p % size) - cx, dy = Math.floor(p / size) - cy;
    xx += dx * dx; yy += dy * dy; xy += dx * dy;
  }
  const half = (xx + yy) / 2;
  const spread = Math.sqrt(Math.max(0, half * half - (xx * yy - xy * xy)));
  const long = half + spread;
  const short = Math.max(half - spread, group.length / 48); // a pixel has some width even in a 1-pixel line
  return Math.sqrt(long / short);
}

// Shared drawing loop: `shadeOf(i)` returns 0 (black) to 1 (white), or null for missing.
function paint(context, size, shadeOf) {
  context.canvas.width = size;
  context.canvas.height = size;
  const output = context.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const shade = shadeOf(i);
    const grey = shade === null ? 0 : Math.max(0, Math.min(1, shade)) * 255;
    output.data[4 * i] = shade === null ? MISSING_COLOUR[0] : grey;
    output.data[4 * i + 1] = shade === null ? MISSING_COLOUR[1] : grey;
    output.data[4 * i + 2] = shade === null ? MISSING_COLOUR[2] : grey;
    output.data[4 * i + 3] = 255;
  }
  context.putImageData(output, 0, 0);
}

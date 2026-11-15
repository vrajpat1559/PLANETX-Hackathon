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
  const threshold = CHANGE_SIGMA * noiseLevel(change);

  // +1 brighter, -1 fainter, 0 no real change. A star that is simply a bit
  // sharper or blurrier in one image changes by a small fraction of its
  // brightness; something that appeared or vanished changes by nearly all of it.
  const sign = new Int8Array(count);
  for (let i = 0; i < count; i++) {
    const big = Math.abs(change[i]) > threshold;
    const large = Math.abs(change[i]) > CHANGE_FRACTION * Math.max(Math.abs(pixels[i]), Math.abs(previous[i]));
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
    if (group.length >= MIN_SPOT_PIXELS) {
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

// Average several images pixel by pixel, skipping missing values.
export function average(images) {
  const length = images[0].length;
  const result = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let total = 0;
    let count = 0;
    for (const image of images) {
      if (Number.isFinite(image[i])) { total += image[i]; count++; }
    }
    result[i] = count ? total / count : NaN;
  }
  return result;
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

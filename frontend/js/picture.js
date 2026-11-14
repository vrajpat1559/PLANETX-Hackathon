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

// Draw (image - reference). Grey = no change, white = got brighter, black = got fainter.
export function paintDifference(context, pixels, reference, size, noise, whiteLevel) {
  const full = compress((whiteLevel / 4) * noise, noise);
  paint(context, size, (i) => {
    const change = pixels[i] - reference[i];
    if (!Number.isFinite(change)) return null;
    return 0.5 + (0.5 * compress(change, noise)) / full;
  });
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

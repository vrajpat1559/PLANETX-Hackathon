// Drawing the telescope image for display, cleaner than its raw pixels.
//
// SPHEREx pixels are large (6.15 arcseconds), so stretched across a screen each
// one becomes a ~10x10 block. This module redraws the picture for display:
//
//   1. Enlarge it up to 4x with high-quality smoothing (bicubic-style), so
//      stars become round points instead of squares.
//   2. Sharpen it with an "unsharp mask", the classic photography trick: make
//      a blurred copy, and push every pixel away from it. Edges get crisper;
//      tiny differences (sky noise) are left alone so the grain doesn't grow.
//
// This only changes how the picture *looks*. The page's science (Highlight,
// the change counts, the thumbnails) still uses the original pixels, painted
// on the hidden #view canvas. "Pixels" mode shows those raw pixels instead.

const TARGET_SIZE = 1600;   // aim for about this many pixels across after enlarging
const MAX_UPSCALE = 4;
const SHARPEN_BRIGHTEN = 0.65; // how hard to push edges brighter (0 = none)
const SHARPEN_DARKEN = 0.2;    // and darker: kept gentle, or bright stars get dark rings ("halos")
const SHARPEN_RADIUS = 0.9; // blur radius, in original pixels
const NOISE_FLOOR = 3;      // differences smaller than this (out of 255) are noise: leave them

const sky = document.getElementById("sky");
const blurred = document.createElement("canvas");
let smooth = true;

export function setSmooth(on) {
  smooth = on;
}

// Draw `source` (the full-resolution picture) onto the display canvas.
export function drawSky(source) {
  if (!source.width) return;
  const context = sky.getContext("2d", { willReadFrequently: true });

  if (!smooth) {
    sky.width = source.width;
    sky.height = source.height;
    sky.classList.add("pixels");
    context.drawImage(source, 0, 0);
    return;
  }

  sky.classList.remove("pixels");
  const upscale = Math.max(1, Math.min(MAX_UPSCALE, Math.round(TARGET_SIZE / source.width)));
  const width = source.width * upscale, height = source.height * upscale;
  sky.width = width;
  sky.height = height;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, width, height);

  // Canvas blur filters are missing in a few older browsers: then just keep the smooth version.
  if (!("filter" in context)) return;

  blurred.width = width;
  blurred.height = height;
  const soft = blurred.getContext("2d", { willReadFrequently: true });
  soft.filter = `blur(${SHARPEN_RADIUS * upscale}px)`;
  soft.drawImage(sky, 0, 0);
  soft.filter = "none";

  const picture = context.getImageData(0, 0, width, height);
  const out = picture.data;
  const blur = soft.getImageData(0, 0, width, height).data;
  for (let i = 0; i < out.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const difference = out[i + channel] - blur[i + channel];
      if (difference > NOISE_FLOOR || difference < -NOISE_FLOOR) {
        const amount = difference > 0 ? SHARPEN_BRIGHTEN : SHARPEN_DARKEN;
        out[i + channel] = out[i + channel] + amount * difference; // clamped to 0-255 automatically
      }
    }
  }
  context.putImageData(picture, 0, 0);
}

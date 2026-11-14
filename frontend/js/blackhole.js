// The page background: a black hole drawn in chunky pixel-art blocks.
//
// It is decoration, but the shape follows the physics of a real black hole
// (the look made famous by the film Interstellar):
//   - a black "shadow" where no light escapes
//   - a thin bright photon ring just outside it
//   - a flat disk of hot gas, seen almost edge-on, crossing in front
//   - the far side of that disk, bent up over the top and under the bottom
//     by gravity (gravitational lensing)
//   - one side brighter than the other: gas moving toward us looks brighter
//     (Doppler boosting)
//   - inner gas orbiting faster than outer gas (Kepler's law), so the disk swirls
//
// How it is drawn: the sky is worked out on a coarse grid of blocks (one
// number per block), the colours are snapped to a small palette with ordered
// dithering (the classic retro-game trick), then the grid is scaled up with
// no smoothing and every block gets a small bevel so it reads as a block.

const BLOCK_PX = 7;          // size of one block on screen, in CSS pixels
const FRAMES_PER_SECOND = 12; // plenty for a slow swirl, and cheap
// Disk colours from cool to hot. Index 0 is "nothing here" (transparent).
const PALETTE = [
  null,
  [40, 8, 10], [78, 14, 12], [130, 28, 14], [190, 56, 22],
  [255, 122, 80], [255, 172, 108], [255, 222, 168], [255, 246, 226],
];
// A 4x4 Bayer matrix: spreads rounding errors into a fine checker pattern.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

let canvas, context, grid, gridContext, bevel;
let columns = 0, rows = 0, scale = 1;
let animation = null, lastFrame = 0;
const stillOnly = window.matchMedia("(prefers-reduced-motion: reduce)");

// Called once at start and again whenever the window is resized.
export function drawBackground(target) {
  canvas = target;
  scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * scale);
  canvas.height = Math.round(window.innerHeight * scale);
  context = canvas.getContext("2d");

  columns = Math.ceil(window.innerWidth / BLOCK_PX);
  rows = Math.ceil(window.innerHeight / BLOCK_PX);
  grid = document.createElement("canvas");
  grid.width = columns;
  grid.height = rows;
  gridContext = grid.getContext("2d");
  bevel = makeBevel(BLOCK_PX * scale);

  if (stillOnly.matches) { render(0); return; } // no motion for those who asked for none
  if (!animation) animation = requestAnimationFrame(tick);
}

function tick(now) {
  animation = requestAnimationFrame(tick);
  if (document.hidden || now - lastFrame < 1000 / FRAMES_PER_SECOND) return;
  lastFrame = now;
  render(now / 1000);
}

// ---------- the physics picture ----------

function render(seconds) {
  const image = gridContext.createImageData(columns, rows);
  const out = image.data;

  // Where the black hole sits and how big it is, in blocks.
  // Off to the right, in the open space beside the page, with its disk
  // sweeping in behind the panels.
  // On a tall phone screen the page fills the width, so use the top-right corner.
  const portrait = columns < rows;
  const cx = columns * (portrait ? 0.92 : 0.92);
  const cy = rows * (portrait ? 0.02 : 0.5);
  const shadow = Math.max(6, Math.min(columns, rows) * (portrait ? 0.11 : 0.15));
  const tilt = 0.2;                    // how flat the disk looks (0 = edge-on)
  const turn = -0.18;                  // the disk is slightly rotated
  const cosT = Math.cos(turn), sinT = Math.sin(turn);
  const diskInner = shadow * 1.55, diskOuter = shadow * 4.8;

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const r = Math.hypot(dx, dy);
      // Coordinates along (X) and across (Y) the disk.
      const X = dx * cosT + dy * sinT;
      const Y = -dx * sinT + dy * cosT;

      let light = 0;
      let opaque = false;

      // The far side of the disk, lensed into a halo above and below the shadow.
      if (r > shadow && r < shadow * 2.1) {
        const across = Math.abs(Y) / r;                   // 0 at the sides, 1 top and bottom
        const profile = Math.exp(-(((r - shadow * 1.15) / (shadow * 0.35)) ** 2));
        light = Math.max(light, profile * (0.25 + 0.75 * Math.sqrt(across)));
      }
      // The photon ring: light that orbited the hole before escaping.
      if (Math.abs(r - shadow * 1.06) < 0.75) light = Math.max(light, 0.92);

      // The shadow itself.
      if (r <= shadow) { opaque = true; light = 0; }

      // The near side of the disk, seen almost edge-on, in front of everything.
      const u = X, v = Y / tilt;
      const rr = Math.hypot(u, v);
      if (rr > diskInner && rr < diskOuter && (v > 0 || r > shadow)) {
        const heat = (diskInner / rr) ** 1.7;            // hotter closer in
        const doppler = 1 + 0.55 * (-u / rr);            // approaching side is brighter
        // Kepler: angular speed falls off as distance^-1.5, so the inner disk swirls faster.
        const angle = Math.atan2(v, u) + seconds * 0.9 * (diskInner / rr) ** 1.5;
        const streaks = 0.72 + 0.28 * Math.sin(angle * 6 + rr * 0.55);
        const edge = Math.min(1, (diskOuter - rr) / (shadow * 0.8)); // fade the outer rim
        light = Math.max(light, heat * doppler * streaks * edge);
        if (v > 0 && r <= shadow) opaque = false;        // the disk passes in front of the shadow
      }

      // Background stars: a sparse, fixed scatter, a few of them twinkling.
      if (light === 0 && !opaque) {
        const h = hash(x, y);
        if (h < 0.0035) {
          const twinkle = h < 0.001 ? 0.5 + 0.5 * Math.sin(seconds * 2 + h * 9000) : 1;
          light = (0.12 + 0.4 * hash(y, x) ** 2) * twinkle;
          paintStar(out, x, y, light);
          continue;
        }
      }

      const i = (y * columns + x) * 4;
      if (opaque && light === 0) {
        out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 255;
        continue;
      }
      const level = Math.floor(Math.min(1, light) * (PALETTE.length - 1) + BAYER[(y % 4) * 4 + (x % 4)]);
      const colour = PALETTE[Math.min(PALETTE.length - 1, level)];
      if (!colour) continue; // transparent: the page's own background shows through
      out[i] = colour[0]; out[i + 1] = colour[1]; out[i + 2] = colour[2]; out[i + 3] = 255;
    }
  }
  gridContext.putImageData(image, 0, 0);

  // Scale up with hard edges, then shade every filled block with a bevel.
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = false;
  context.globalCompositeOperation = "source-over";
  context.drawImage(grid, 0, 0, columns * BLOCK_PX * scale, rows * BLOCK_PX * scale);
  context.globalCompositeOperation = "source-atop"; // only on blocks already drawn
  context.fillStyle = bevel;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = "source-over";
}

function paintStar(out, x, y, light) {
  const i = (y * columns + x) * 4;
  // Faint blue-white, so stars sit back and the warm disk stands out.
  const v = Math.round(40 + 200 * Math.min(1, light));
  out[i] = Math.round(v * 0.82); out[i + 1] = Math.round(v * 0.9); out[i + 2] = v; out[i + 3] = 255;
}

// A repeatable "random" number for each block, so stars stay put between frames.
function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// One block's shading: a light top-left edge and a dark bottom-right edge.
function makeBevel(size) {
  const tile = document.createElement("canvas");
  tile.width = tile.height = Math.max(2, Math.round(size));
  const t = tile.getContext("2d");
  const edge = Math.max(1, Math.round(size / 7));
  t.fillStyle = "rgba(255, 255, 255, 0.16)";
  t.fillRect(0, 0, tile.width, edge);
  t.fillRect(0, 0, edge, tile.height);
  t.fillStyle = "rgba(0, 0, 0, 0.32)";
  t.fillRect(0, tile.height - edge, tile.width, edge);
  t.fillRect(tile.width - edge, 0, edge, tile.height);
  return context.createPattern(tile, "repeat");
}

// The page background: our solar system in a line, in voxel (blocky) style,
// in front of a twinkling pixel starfield.
//
// - The Sun glows in from the left edge, then Mercury, Venus, Earth (with its
//   Moon going round), Mars, Jupiter (cloud bands), Saturn (spinning ring),
//   Uranus (its ring stands on end, because the planet is tipped over) and
//   Neptune. Sizes are stylised, not to scale: to scale, Mercury would be a
//   speck next to Jupiter.
// - The planets sit along the bottom of the first screen and scroll away with
//   it, while the stars stay put (a parallax effect).
// - Stars twinkle three ways:
//     scintillation: irregular flicker with small colour shifts, the way real
//                    stars shimmer through air
//     glints:        now and then a star's four points stretch out and pull
//                    back, like a flare in a camera lens
//     pixel flicker: some of the tiny pixel stars blink
// - Now and then a star explodes into pixel debris; a new one appears later.
//
// Purely decorative.

const STARS_PER_MEGAPIXEL = 330;
const FLICKER_FRACTION = 0.12;              // share of tiny stars that blink
const SPARKLE_STARS = 22;
const SATURN_RING_SECONDS_PER_TURN = 40;
const MOON_SECONDS_PER_ORBIT = 14;
const EXPLOSION_EVERY_SECONDS = [6, 12];
const EXPLOSION_SECONDS = 2.6;
const REAPPEAR_SECONDS = 8;
const LINE_HEIGHT = 0.952;                  // where the planet line sits, as a share of the screen height

const WHITE = [255, 255, 255], BLUE_WHITE = [200, 215, 255], LAVENDER = [190, 170, 255];

// Colour ramps, dark side to lit side.
const RAMPS = {
  sun: [[170, 50, 10], [225, 100, 18], [255, 160, 40], [255, 210, 100], [255, 245, 200]],
  mercury: [[50, 48, 54], [92, 88, 92], [140, 134, 132], [190, 184, 178]],
  venus: [[110, 72, 36], [170, 122, 66], [222, 180, 116], [246, 222, 172]],
  ocean: [[8, 26, 72], [22, 64, 150], [52, 122, 214], [140, 194, 255]],
  land: [[20, 52, 26], [42, 100, 44], [82, 150, 70], [150, 196, 110]],
  cloud: [[120, 130, 150], [180, 190, 205], [230, 236, 245], [255, 255, 255]],
  moon: [[60, 60, 66], [110, 110, 114], [170, 170, 172], [220, 220, 222]],
  mars: [[72, 22, 14], [140, 50, 28], [200, 90, 52], [236, 148, 106]],
  jupiterLight: [[110, 90, 70], [180, 156, 124], [228, 208, 176], [250, 238, 214]],
  jupiterDark: [[80, 40, 22], [140, 78, 44], [196, 124, 78], [226, 168, 120]],
  saturn: [[100, 82, 46], [170, 142, 86], [222, 196, 136], [246, 230, 182]],
  uranus: [[26, 86, 104], [64, 154, 174], [124, 210, 222], [196, 244, 244]],
  neptune: [[12, 26, 96], [32, 66, 176], [76, 116, 232], [156, 186, 255]],
};

let canvas, context, starLayer, planetLayer, width = 0, height = 0, scale = 1;
let planets = [], flickers = [], sparkles = [], explosions = [], nextExplosion = 0;
let animation = null;
const stillOnly = window.matchMedia("(prefers-reduced-motion: reduce)");

export function drawBackground(target) {
  canvas = target;
  scale = window.devicePixelRatio || 1;
  width = window.innerWidth;
  height = window.innerHeight;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  context = canvas.getContext("2d");

  const random = randomSource(2026);
  starLayer = paintStars(random);
  planets = layOutPlanets();
  planetLayer = paintPlanets();
  sparkles = Array.from({ length: SPARKLE_STARS }, () => newSparkle(random, -10));

  if (stillOnly.matches) { frame(0); return; }
  if (!animation) animation = requestAnimationFrame(tick);
}

function tick(now) {
  animation = requestAnimationFrame(tick);
  // Once a telescope image fills the page this scene is faded out: stop drawing it.
  if (!document.hidden && !document.body.classList.contains("has-image")) frame(now / 1000);
}

// ---------- one frame ----------

function frame(seconds) {
  const c = context;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, canvas.width, canvas.height);
  c.drawImage(starLayer, 0, 0);
  c.setTransform(scale, 0, 0, scale, 0, 0);
  const moving = !stillOnly.matches;

  // Pixel flicker: some tiny stars blink in steps, like pixels turning on and off.
  if (moving) {
    for (const star of flickers) {
      const level = Math.floor((0.5 + 0.5 * Math.sin(seconds * star.speed + star.phase)) * 3) / 3;
      c.fillStyle = `rgba(${star.tint.join(",")}, ${level})`;
      c.fillRect(star.x, star.y, star.size, star.size);
    }
  }

  // Sparkle stars: scintillation and glints.
  for (const s of sparkles) {
    if (s.gone) continue;
    const appear = moving ? Math.min(1, Math.max(0, (seconds - s.born) / 2)) : 1;
    drawSparkle(c, s, moving ? seconds : 0, appear);
  }

  // The planets, scrolled with the page (the stars are not).
  const offset = -window.scrollY;
  if (offset > -height * PLANET_LAYER_SCREENS) {
    c.save();
    c.translate(0, offset);
    const saturn = planets.find((p) => p.name === "saturn");
    const spin = moving ? (seconds / SATURN_RING_SECONDS_PER_TURN) * 2 * Math.PI : 0.6;
    drawRing(c, saturn, spin, "back");
    c.setTransform(1, 0, 0, 1, 0, offset * scale);
    c.drawImage(planetLayer, 0, 0);
    c.setTransform(scale, 0, 0, scale, 0, offset * scale);
    drawRing(c, saturn, spin, "front");
    drawMoon(c, moving ? seconds : 3);
    c.restore();
  }

  if (!moving) return;
  if (seconds >= nextExplosion) {
    const candidates = sparkles.filter((s) => !s.gone && seconds - s.born > 3);
    if (nextExplosion > 0 && candidates.length) {
      const star = candidates[Math.floor(Math.random() * candidates.length)];
      star.gone = true;
      explosions.push({ x: star.x, y: star.y, start: seconds, star });
    }
    const [low, high] = EXPLOSION_EVERY_SECONDS;
    nextExplosion = seconds + low + Math.random() * (high - low);
  }
  for (const boom of explosions) {
    const t = (seconds - boom.start) / EXPLOSION_SECONDS;
    if (t < 1) drawExplosion(c, boom.x, boom.y, t);
    else if (seconds - boom.start > REAPPEAR_SECONDS) {
      Object.assign(boom.star, newSparkle(Math.random, seconds));
      boom.done = true;
    }
  }
  explosions = explosions.filter((boom) => !boom.done);
}

// ---------- stars ----------

function paintStars(random) {
  const layer = document.createElement("canvas");
  layer.width = canvas.width;
  layer.height = canvas.height;
  const s = layer.getContext("2d");
  s.scale(scale, scale);
  flickers = [];
  const count = Math.round((width * height) / 1e6 * STARS_PER_MEGAPIXEL);
  for (let i = 0; i < count; i++) {
    const x = Math.round(random() * width), y = Math.round(random() * height);
    const size = random() < 0.25 ? 3 : 2;
    const tint = random() < 0.3 ? LAVENDER : WHITE;
    if (random() < FLICKER_FRACTION) { // drawn every frame instead, so it can blink
      flickers.push({ x, y, size, tint, speed: 0.5 + random() * 2.5, phase: random() * 6.28 });
      continue;
    }
    s.fillStyle = `rgba(${tint.join(",")}, ${0.45 + random() * 0.55})`;
    s.fillRect(x, y, size, size);
  }
  return layer;
}

function newSparkle(random, born) {
  // Keep sparkles above the planet line, where they are not hidden.
  return {
    x: Math.round(random() * width),
    y: Math.round(random() * height * (LINE_HEIGHT - 0.12)),
    size: 4 + random() * 6,
    // Scintillation: two flicker rates that never quite line up, so it looks irregular.
    rateA: 2 + random() * 3, rateB: 5.3 + random() * 4, phase: random() * 6.28,
    // Glints: each star flares on its own schedule.
    glintEvery: 5 + random() * 9, glintOffset: random() * 14,
    born, gone: false,
  };
}

function drawSparkle(c, s, seconds, appear) {
  const flicker = 0.5 + 0.3 * Math.sin(seconds * s.rateA + s.phase) + 0.2 * Math.sin(seconds * s.rateB + s.phase * 2);
  const light = Math.max(0.15, Math.min(1, flicker)) * appear;
  // The colour wanders a little between white, blue-white and lavender.
  const hue = 0.5 + 0.5 * Math.sin(seconds * 0.9 + s.phase * 3);
  const tint = mix(mix(BLUE_WHITE, WHITE, Math.min(1, hue * 2)), LAVENDER, Math.max(0, hue * 2 - 1)).map(Math.round).join(",");

  // A glint: for about half a second the arms stretch out to three times their length.
  const sinceGlint = (seconds + s.glintOffset) % s.glintEvery;
  const glint = sinceGlint < 0.5 ? Math.sin((sinceGlint / 0.5) * Math.PI) : 0;
  const arm = Math.round(s.size * (1 + 2 * glint));

  const glow = c.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.size * 1.6);
  glow.addColorStop(0, `rgba(${tint}, ${0.3 * light})`);
  glow.addColorStop(1, `rgba(${tint}, 0)`);
  c.fillStyle = glow;
  c.fillRect(s.x - s.size * 1.6, s.y - s.size * 1.6, s.size * 3.2, s.size * 3.2);
  c.fillStyle = `rgba(${tint}, ${light})`;
  c.fillRect(s.x - arm, s.y - 0.5, arm * 2, 1);
  c.fillRect(s.x - 0.5, s.y - arm, 1, arm * 2);
  c.fillStyle = `rgba(255,255,255, ${light})`;
  c.fillRect(s.x - 1.5, s.y - 1.5, 3, 3);
}

function drawExplosion(c, x, y, t) {
  const flash = Math.max(0, 1 - t * 3.5);
  if (flash > 0) {
    c.fillStyle = `rgba(255,255,255, ${flash})`;
    const arm = 10 + 18 * (1 - flash);
    c.fillRect(x - arm, y - 1, arm * 2, 2);
    c.fillRect(x - 1, y - arm, 2, arm * 2);
    c.fillRect(x - 3, y - 3, 6, 6);
  }
  const reach = 6 + 70 * (1 - (1 - t) ** 2.5);
  const colour = t < 0.3 ? "255,245,230" : t < 0.6 ? "255,160,110" : "170,110,255";
  c.fillStyle = `rgba(${colour}, ${(1 - t) ** 1.2})`;
  for (let k = 0; k < 22; k++) {
    const angle = (k / 22) * 2 * Math.PI + (k % 2) * 0.12;
    const distance = reach * (k % 3 === 0 ? 1 : 0.78);
    const size = t < 0.5 ? 3 : 2;
    c.fillRect(Math.round(x + Math.cos(angle) * distance) - size / 2, Math.round(y + Math.sin(angle) * distance) - size / 2, size, size);
  }
  const glow = c.createRadialGradient(x, y, 0, x, y, reach * 0.8);
  glow.addColorStop(0, `rgba(255,170,130, ${0.22 * (1 - t)})`);
  glow.addColorStop(1, "rgba(150,100,255,0)");
  c.fillStyle = glow;
  c.beginPath(); c.arc(x, y, reach * 0.8, 0, 2 * Math.PI); c.fill();
}

// ---------- the planets ----------

function layOutPlanets() {
  const unit = Math.min(width, height * 1.6) / 1250;  // planet sizes follow the screen
  const line = height * LINE_HEIGHT;
  // [name, radius in units, position along the line (0 = left edge, 1 = right)]
  const list = [
    ["mercury", 7, 0.2], ["venus", 12, 0.28], ["earth", 13, 0.37], ["mars", 9, 0.45],
    ["jupiter", 34, 0.57], ["saturn", 27, 0.72], ["uranus", 18, 0.85], ["neptune", 17, 0.95],
  ];
  const result = list.map(([name, r, along]) => ({
    name, radius: Math.round(r * unit),
    // A gentle arc, a little higher in the middle.
    cx: along * width, cy: line - Math.sin(along * Math.PI) * height * 0.02,
  }));
  // The Sun: huge, mostly off the left edge, so only its glowing limb shows.
  result.unshift({ name: "sun", radius: Math.round(height * 0.42), cx: -height * 0.3, cy: line - height * 0.03 });
  for (const p of result) p.block = Math.max(3, Math.round(p.radius / (p.name === "sun" ? 26 : 6)));
  const saturn = result.find((p) => p.name === "saturn");
  Object.assign(saturn, { tilt: 0.26, turn: -0.22 });
  return result;
}

// The planet layer is taller than the screen: the Sun and its glow reach well
// below the first screen, and they scroll up into view. A layer only one screen
// tall cut them off with a hard edge.
const PLANET_LAYER_SCREENS = 2;

function paintPlanets() {
  const layer = document.createElement("canvas");
  layer.width = canvas.width;
  layer.height = canvas.height * PLANET_LAYER_SCREENS;
  const p = layer.getContext("2d");
  p.scale(scale, scale);
  const sun = planets[0];
  // The Sun's glow first, behind everything.
  const glow = p.createRadialGradient(sun.cx, sun.cy, sun.radius * 0.85, sun.cx, sun.cy, sun.radius * 2.1);
  glow.addColorStop(0, "rgba(255,170,60,0.38)");
  glow.addColorStop(1, "rgba(255,120,40,0)");
  p.fillStyle = glow;
  p.fillRect(0, 0, width, height * PLANET_LAYER_SCREENS);
  for (const planet of planets) paintVoxelBall(p, planet);
  // Uranus's faint ring stands almost on end.
  const uranus = planets.find((q) => q.name === "uranus");
  p.strokeStyle = "rgba(170,230,240,0.45)";
  p.lineWidth = Math.max(1, uranus.block * 0.5);
  p.beginPath();
  p.ellipse(uranus.cx, uranus.cy, uranus.radius * 0.35, uranus.radius * 1.7, 0.1, 0, 2 * Math.PI);
  p.stroke();
  return layer;
}

// Which colour ramp a block uses: bands on Jupiter, land and clouds on Earth.
function surface(name, i, j, latitude) {
  if (name === "earth") {
    const n = hash(i + 50, j + 90);
    if (Math.abs(latitude) > 0.82) return RAMPS.cloud;          // ice caps
    return n < 0.18 ? RAMPS.cloud : n < 0.5 ? RAMPS.land : RAMPS.ocean;
  }
  if (name === "jupiter") {
    const band = Math.floor((latitude + 1) * 4.5);
    return band % 2 === 0 ? RAMPS.jupiterLight : RAMPS.jupiterDark;
  }
  return RAMPS[name];
}

function paintVoxelBall(p, planet) {
  const { name, cx, cy, radius, block } = planet;
  const light = name === "sun" ? null : normalise([-0.75, -0.35, 0.56]); // lit from the Sun, on the left
  const steps = Math.ceil(radius / block) + 1;
  for (let j = -steps; j <= steps; j++) {
    for (let i = -steps; i <= steps; i++) {
      const x = (i + 0.5) * block, y = (j + 0.5) * block;
      const d2 = (x * x + y * y) / (radius * radius);
      if (d2 > 1) continue;
      const left = Math.round(cx + i * block), top = Math.round(cy + j * block);
      if (left > width || left + block < 0) continue;
      let shade;
      if (light) {
        const normal = [x / radius, y / radius, Math.sqrt(1 - d2)];
        shade = Math.max(0, dot(normal, light)) * 0.88 + 0.1;
      } else {
        // The Sun glows, brightest in the middle and darker at the edge ("limb
        // darkening"), with a mottled surface of hot and cooler cells.
        shade = 0.5 + 0.5 * (1 - d2) ** 0.35 + (hash(i * 3 + 7, j * 5 + 1) - 0.5) * 0.18;
      }
      shade += (hash(i, j) - 0.5) * 0.14;
      shade = Math.round(Math.min(1, Math.max(0, shade)) * 10) / 10;
      p.fillStyle = rgb(ramp(surface(name, i, j, y / radius), shade));
      p.fillRect(left, top, block + 0.5, block + 0.5);
    }
  }
}

// Saturn's ring: tracks of blocks that travel around the planet.
const RING_TRACKS = [{ at: 1.38, size: 0.5 }, { at: 1.58, size: 0.7 }, { at: 1.72, size: 0.7 }, { at: 1.84, size: 0.55 }];

function drawRing(c, planet, spin, half) {
  const { cx, cy, radius, block, tilt, turn } = planet;
  const cosT = Math.cos(turn), sinT = Math.sin(turn);
  const light = normalise([-0.75, -0.35, 0.56]);
  RING_TRACKS.forEach((track, t) => {
    const count = Math.ceil((2 * Math.PI * track.at * radius) / (block * track.size) * 0.9);
    for (let k = 0; k < count; k++) {
      const angle = (k / count) * 2 * Math.PI + spin * (1.1 - t * 0.05);
      const front = Math.sin(angle) > 0;
      if ((half === "front") !== front) continue;
      const along = Math.cos(angle) * radius * track.at;
      const across = Math.sin(angle) * radius * track.at * tilt;
      const x = cx + along * cosT - across * sinT;
      const y = cy + along * sinT + across * cosT;
      if (!front && Math.hypot(x - cx, y - cy) < radius * 0.98) continue;
      const facing = Math.max(0, dot(normalise([Math.cos(angle), Math.sin(angle) * 0.3, 0.6]), light));
      const texture = hash(k * 3 + t, t * 17 + 1);
      if (texture < 0.03) continue;
      const shade = Math.min(1, 0.22 + facing * 0.72 + (texture - 0.5) * 0.18);
      const size = block * track.size;
      c.fillStyle = rgb(ramp(RAMPS.saturn, shade));
      c.fillRect(Math.round(x - size / 2), Math.round(y - size / 2), Math.ceil(size), Math.ceil(size));
    }
  });
}

// The Moon going round the Earth: hidden while it passes behind.
function drawMoon(c, seconds) {
  const earth = planets.find((p) => p.name === "earth");
  const angle = (seconds / MOON_SECONDS_PER_ORBIT) * 2 * Math.PI;
  const behind = Math.sin(angle) < 0;
  const x = earth.cx + Math.cos(angle) * earth.radius * 2;
  const y = earth.cy + Math.sin(angle) * earth.radius * 0.5;
  if (behind && Math.hypot(x - earth.cx, y - earth.cy) < earth.radius) return;
  const size = Math.max(3, Math.round(earth.radius * 0.45));
  const lit = Math.cos(angle) < 0 ? 0.9 : 0.6;
  c.fillStyle = rgb(ramp(RAMPS.moon, lit));
  c.fillRect(Math.round(x - size / 2), Math.round(y - size / 2), size, size);
}

// ---------- helpers ----------

function ramp(stops, t) {
  const position = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(position), f = position - i;
  return stops[i].map((v, k) => v + (stops[i + 1][k] - v) * f);
}
const mix = (a, b, f) => a.map((v, k) => v + (b[k] - v) * f);
const rgb = ([r, g, b]) => `rgb(${r | 0},${g | 0},${b | 0})`;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function normalise(v) { const n = Math.hypot(...v); return v.map((x) => x / n); }

function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function randomSource(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

// SPHEREx Blink frontend: asks the backend which exposures cover a position,
// loads aligned cutouts, and flips between them.

const PRESETS = [
  { label: "COSMOS field", ra: 150.0, dec: 2.2 },
  { label: "Barnard's Star (fast-moving star)", name: "Barnard's Star" },
  { label: "Orion Nebula", name: "M42" },
  { label: "North Ecliptic Pole (deep field)", ra: 270.0, dec: 66.56 },
];
const PARALLEL_LOADS = 3;
const NEW_EPOCH_GAP_DAYS = 30; // frames further apart than this start a new row

const $ = (id) => document.getElementById(id);
const canvas = $("view");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

const state = {
  target: null,   // { ra, dec, label }
  all: [],        // every exposure covering the target, all bands
  frames: [],     // frames chosen for the current band: { meta, image, pixels, status }
  current: 0,
  timer: null,
  run: 0,         // bumped on every reload so stale loads are ignored
};

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

// ---------- target selection ----------

async function resolveTarget(text) {
  const coords = text.trim().match(/^([+-]?\d+(?:\.\d+)?)[\s,]+([+-]?\d+(?:\.\d+)?)$/);
  if (coords) {
    return { ra: parseFloat(coords[1]), dec: parseFloat(coords[2]), label: text.trim() };
  }
  const hit = await getJSON(`/api/resolve?name=${encodeURIComponent(text.trim())}`);
  return { ra: hit.ra, dec: hit.dec, label: text.trim() };
}

async function go(text) {
  stopBlink();
  try {
    setStatus("Looking up the target…");
    state.target = await resolveTarget(text);
    const { ra, dec } = state.target;
    setStatus(`Searching the SPHEREx archive at RA ${ra.toFixed(4)}°, Dec ${dec.toFixed(4)}°…`);
    const found = await getJSON(`/api/frames?ra=${ra}&dec=${dec}`);
    state.all = found.frames;
    if (!state.all.length) {
      state.frames = [];
      drawTimeline();
      setStatus("SPHEREx has no released images covering this position yet.", true);
      return;
    }
    loadBand();
  } catch (err) {
    setStatus(`Could not load that target: ${err.message}`, true);
  }
}

// Pick `limit` items spread evenly across a time-sorted list.
function spread(list, limit) {
  if (!limit || list.length <= limit) return list;
  const picked = [];
  for (let i = 0; i < limit; i++) {
    picked.push(list[Math.round((i * (list.length - 1)) / (limit - 1))]);
  }
  return [...new Set(picked)];
}

// ---------- frame loading ----------

function loadBand() {
  stopBlink();
  const run = ++state.run;
  const band = $("band").value;
  const size = $("size").value;
  const limit = parseInt($("limit").value, 10);
  const inBand = state.all.filter((f) => f.band === band);
  const chosen = spread(inBand, limit);

  state.frames = chosen.map((meta) => ({ meta, image: null, pixels: null, status: "loading" }));
  state.current = 0;
  drawTimeline();
  if (!chosen.length) {
    setStatus(`No ${band} images here. Try another band (${state.all.length} images exist in total).`, true);
    return;
  }

  const { ra, dec } = state.target;
  let next = 0;
  let done = 0;
  const progress = () =>
    setStatus(
      `${state.target.label}: ${inBand.length} ${band} exposures found, ` +
      `loaded ${done} of ${chosen.length}. First load of each frame takes several seconds.`
    );
  progress();

  const worker = async () => {
    while (next < state.frames.length && run === state.run) {
      const frame = state.frames[next++];
      const src =
        `/api/cutout.png?url=${encodeURIComponent(frame.meta.url)}` +
        `&ra=${ra}&dec=${dec}&size=${size}`;
      try {
        frame.image = await loadImage(src);
        frame.status = "ready";
      } catch {
        frame.status = "failed";
      }
      if (run !== state.run) return;
      done++;
      progress();
      drawTimeline();
      const ready = state.frames.filter((f) => f.status === "ready");
      if (ready.length === 1 || state.frames[state.current].status !== "ready") {
        show(state.frames.indexOf(ready[0]));
      } else if ($("diff").checked) {
        show(state.current); // the reference frame may have just arrived
      }
    }
  };
  for (let i = 0; i < PARALLEL_LOADS; i++) worker();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function pixelsOf(frame) {
  if (!frame.pixels) {
    const off = document.createElement("canvas");
    off.width = frame.image.width;
    off.height = frame.image.height;
    const octx = off.getContext("2d");
    octx.drawImage(frame.image, 0, 0);
    frame.pixels = octx.getImageData(0, 0, off.width, off.height);
  }
  return frame.pixels;
}

// ---------- display ----------

function show(index) {
  const frame = state.frames[index];
  if (!frame || frame.status !== "ready") return;
  state.current = index;
  canvas.width = frame.image.width;
  canvas.height = frame.image.height;

  const reference = state.frames.find((f) => f.status === "ready");
  if ($("diff").checked && reference && reference !== frame) {
    // Grey means unchanged; bright means brighter now, dark means fainter now.
    const a = pixelsOf(frame).data;
    const b = pixelsOf(reference).data;
    const out = ctx.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < a.length; i += 4) {
      const v = Math.max(0, Math.min(255, 128 + (a[i] - b[i]) * 1.5));
      out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
      out.data[i + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
  } else {
    ctx.drawImage(frame.image, 0, 0);
  }

  $("stamp").textContent = `${frame.meta.date} UTC · ${frame.meta.band}`;
  for (const btn of $("timeline").querySelectorAll("button")) {
    btn.classList.toggle("active", Number(btn.dataset.index) === index);
  }
}

function step(direction) {
  const n = state.frames.length;
  for (let k = 1; k <= n; k++) {
    const i = (state.current + direction * k + n * k) % n;
    if (state.frames[i].status === "ready") return show(i);
  }
}

function drawTimeline() {
  const box = $("timeline");
  box.replaceChildren();
  state.frames.forEach((frame, i) => {
    const prev = state.frames[i - 1];
    if (prev && frame.meta.mjd - prev.meta.mjd > NEW_EPOCH_GAP_DAYS) {
      const gap = document.createElement("span");
      gap.className = "gap";
      box.append(gap);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.index = i;
    btn.textContent = frame.meta.date.slice(0, 10);
    btn.title = `${frame.meta.date} UTC, exposure ${frame.meta.id}`;
    btn.className = frame.status === "ready" ? "" : frame.status;
    if (i === state.current && frame.status === "ready") btn.classList.add("active");
    btn.disabled = frame.status !== "ready";
    btn.addEventListener("click", () => { stopBlink(); show(i); });
    box.append(btn);
  });
}

// ---------- blinking ----------

function startBlink() {
  stopBlink();
  const interval = 1100 - $("speed").value * 100; // 1000 ms down to 100 ms
  state.timer = setInterval(() => step(1), interval);
  $("play").textContent = "Pause";
}

function stopBlink() {
  clearInterval(state.timer);
  state.timer = null;
  $("play").textContent = "Blink";
}

// ---------- wiring ----------

async function init() {
  const bands = await getJSON("/api/bands");
  for (const [id, range] of Object.entries(bands)) {
    $("band").add(new Option(`${id} (${range} µm)`, id));
  }
  $("band").value = "D2";

  for (const preset of PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = preset.label;
    btn.addEventListener("click", () => {
      const text = preset.name ?? `${preset.ra} ${preset.dec}`;
      $("target").value = text;
      go(text);
    });
    $("presets").append(btn);
  }

  $("search").addEventListener("submit", (e) => {
    e.preventDefault();
    if ($("target").value.trim()) go($("target").value);
  });
  for (const id of ["band", "size", "limit"]) {
    $(id).addEventListener("change", () => { if (state.all.length) loadBand(); });
  }
  $("play").addEventListener("click", () => (state.timer ? stopBlink() : startBlink()));
  $("prev").addEventListener("click", () => { stopBlink(); step(-1); });
  $("next").addEventListener("click", () => { stopBlink(); step(1); });
  $("speed").addEventListener("input", () => { if (state.timer) startBlink(); });
  $("diff").addEventListener("change", () => show(state.current));
  $("cross").addEventListener("change", () => { $("crosshair").hidden = !$("cross").checked; });

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input[type=text], select")) return;
    if (e.key === "ArrowLeft") { stopBlink(); step(-1); }
    else if (e.key === "ArrowRight") { stopBlink(); step(1); }
    else if (e.key === " ") { e.preventDefault(); state.timer ? stopBlink() : startBlink(); }
  });
}

init();

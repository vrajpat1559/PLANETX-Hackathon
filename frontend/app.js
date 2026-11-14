// SPHEREx Blink frontend: asks the backend which exposures cover a position,
// loads aligned cutouts, and flips between them.

const PRESETS = [
  { label: "COSMOS field", note: "A deep, well-studied patch of distant galaxies", ra: 150.0, dec: 2.2 },
  { label: "Barnard's Star", note: "The fastest-moving star in our sky", name: "Barnard's Star" },
  { label: "Orion Nebula", note: "A bright cloud where new stars are forming", name: "M42" },
  { label: "North Ecliptic Pole", note: "A deep field that SPHEREx revisits most often", ra: 270.0, dec: 66.56 },
];
const PARALLEL_LOADS = 3;
const NEW_EPOCH_GAP_DAYS = 30; // frames further apart than this belong to a new survey pass
const PIXEL_ARCSEC = 6.15;     // SPHEREx native pixel scale, used for the scale bar
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const $ = (id) => document.getElementById(id);
const canvas = $("view");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

const state = {
  target: null,   // { ra, dec, label }
  all: [],        // every exposure covering the target, all bands
  frames: [],     // frames chosen for the current band: { meta, image, pixels, status, chip, tick }
  current: 0,
  timer: null,
  run: 0,         // bumped on every reload so stale loads are ignored
  query: 0,       // bumped on every search so stale lookups are ignored
  last: null,     // { text, label } of the latest search, for "Try again"
  bands: {},      // band id -> wavelength range
};
const loader = { queue: [], active: 0 };

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()).detail;
      if (typeof body === "string") detail = body;
    } catch {}
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return res.json();
}

// ---------- small formatting helpers ----------

// Frame dates arrive as "YYYY-MM-DD HH:MM" (UTC).
function parts(date) {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return { y, m, d, time: date.slice(11, 16) };
}
const dayLabel = (date) => { const p = parts(date); return `${p.d} ${MONTHS[p.m - 1]}`; };
const fullDay = (date) => `${dayLabel(date)} ${parts(date).y}`;

function rangeLabel(first, last) {
  const a = parts(first), b = parts(last);
  if (first.slice(0, 10) === last.slice(0, 10)) return fullDay(first);
  if (a.y !== b.y) return `${fullDay(first)} – ${fullDay(last)}`;
  if (a.m !== b.m) return `${dayLabel(first)} – ${fullDay(last)}`;
  return `${a.d} – ${fullDay(last)}`;
}

function spanLabel(days) {
  if (days < 1) {
    const hours = Math.round(days * 24);
    return hours < 1 ? "under an hour" : `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (days < 60) { const n = Math.round(days); return `${n} day${n === 1 ? "" : "s"}`; }
  const months = Math.round(days / 30.44);
  return `about ${months} months`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------- stage overlays ----------

let busyTimer = null;
let problemAction = null;

// mode: "intro" (first visit), "busy" (waiting), "problem" (nothing to show), "image"
function setMode(mode, info = {}) {
  $("stage").dataset.mode = mode;
  $("intro").hidden = mode !== "intro";
  $("busy").hidden = mode !== "busy";
  $("problem").hidden = mode !== "problem";
  $("hud").hidden = mode !== "image";

  if (mode === "busy") {
    $("busy-title").textContent = info.title;
    $("busy-detail").textContent = info.detail || "";
    if (!busyTimer) {
      const started = Date.now();
      $("busy-elapsed").textContent = "";
      busyTimer = setInterval(() => {
        $("busy-elapsed").textContent = `${Math.round((Date.now() - started) / 1000)} s`;
      }, 1000);
    }
  } else {
    clearInterval(busyTimer);
    busyTimer = null;
  }

  if (mode === "problem") {
    $("problem-title").textContent = info.title;
    $("problem-detail").textContent = info.detail || "";
    problemAction = info.action || null;
    $("problem-action").hidden = !info.action;
    $("problem-action").textContent = info.actionLabel || "";
  }
  if (mode !== "image") {
    canvas.setAttribute("aria-label", "No image loaded yet");
    $("field-note").hidden = true;
  }
}

function setTitle(name, coords) {
  $("target-name").textContent = name;
  $("target-coords").textContent = coords;
}

// ---------- target selection ----------

async function resolveTarget(text) {
  const coords = text.trim().match(/^([+-]?\d+(?:\.\d+)?)[\s,]+([+-]?\d+(?:\.\d+)?)$/);
  if (coords) {
    const ra = parseFloat(coords[1]), dec = parseFloat(coords[2]);
    if (ra < 0 || ra > 360 || dec < -90 || dec > 90) {
      throw new Error("coordinates must be RA 0 to 360 and Dec −90 to +90, in degrees");
    }
    return { ra, dec, label: text.trim() };
  }
  const hit = await getJSON(`/api/resolve?name=${encodeURIComponent(text.trim())}`);
  return { ra: hit.ra, dec: hit.dec, label: text.trim() };
}

async function go(text, label) {
  stopBlink();
  cancelLoads();
  const query = ++state.query;
  state.last = { text, label };
  state.all = [];
  state.frames = [];
  state.target = null;
  $("target").removeAttribute("aria-invalid");
  buildTimeline();
  updateProgress();
  updateBandCounts();
  setTitle(label || text.trim(), "Looking up the position…");
  setMode("busy", { title: "Finding your target…", detail: "Looking up where this is in the sky." });
  setStatus("Looking up the target…");
  if (window.matchMedia("(max-width: 900px)").matches) {
    $("viewer").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  let stage = "lookup";
  try {
    const target = await resolveTarget(text);
    if (query !== state.query) return;
    if (label) target.label = label;
    state.target = target;
    const { ra, dec } = target;
    setTitle(target.label, `RA ${ra.toFixed(4)}°   Dec ${dec >= 0 ? "+" : "−"}${Math.abs(dec).toFixed(4)}°`);

    stage = "search";
    setMode("busy", {
      title: "Searching NASA's archive…",
      detail: "Listing every SPHEREx exposure that covers this spot.",
    });
    setStatus(`Searching the SPHEREx archive at RA ${ra.toFixed(4)}°, Dec ${dec.toFixed(4)}°…`);
    const found = await getJSON(`/api/frames?ra=${ra}&dec=${dec}`);
    if (query !== state.query) return;
    state.all = found.frames;
    updateBandCounts();
    if (!state.all.length) {
      setStatus("SPHEREx has no released images covering this position yet.", true);
      setMode("problem", {
        title: "No images here yet",
        detail: "SPHEREx has no released images covering this position. Try one of the suggested targets.",
      });
      return;
    }
    loadBand();
  } catch (err) {
    if (query !== state.query) return;
    setStatus(`Could not load that target: ${err.message}`, true);
    if (stage === "lookup") {
      $("target").setAttribute("aria-invalid", "true");
      setTitle(label || text.trim(), "Position unknown");
    }
    setMode("problem", {
      title: stage === "lookup" ? "Couldn't find that target" : "The archive search failed",
      detail: stage === "lookup"
        ? `${capitalise(err.message)}. Check the spelling, or enter coordinates such as 150.0 2.2.`
        : `${capitalise(err.message)}. The archive is sometimes busy; it usually works on a second try.`,
      actionLabel: "Try again",
      action: () => go(text, label),
    });
  }
}

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/\.$/, "");

// Pick `limit` items spread evenly across a time-sorted list.
function spread(list, limit) {
  if (!limit || list.length <= limit) return list;
  const picked = [];
  for (let i = 0; i < limit; i++) {
    picked.push(list[Math.round((i * (list.length - 1)) / (limit - 1))]);
  }
  return [...new Set(picked)];
}

// Show how many exposures each band has for the current target.
function updateBandCounts() {
  const counts = {};
  for (const f of state.all) counts[f.band] = (counts[f.band] || 0) + 1;
  for (const option of $("band").options) {
    const base = `${option.value} · ${state.bands[option.value]} µm`;
    option.textContent = state.all.length ? `${base} (${counts[option.value] || 0} images)` : base;
  }
  return counts;
}

// ---------- frame loading ----------

function cancelLoads() {
  state.run++;
  for (const frame of state.frames) {
    if (frame.status === "loading" && frame.img) {
      frame.img.onload = frame.img.onerror = null;
      frame.img.src = ""; // drop the in-flight request
    }
  }
  loader.queue = [];
  loader.active = 0;
}

function loadBand() {
  stopBlink();
  cancelLoads();
  const band = $("band").value;
  const size = $("size").value;
  const limit = parseInt($("limit").value, 10);
  const inBand = state.all.filter((f) => f.band === band);
  const chosen = spread(inBand, limit);

  state.frames = chosen.map((meta) => ({ meta, size, image: null, pixels: null, status: "queued" }));
  state.inBand = inBand.length;
  state.current = 0;
  buildTimeline();
  updateTransport();

  if (!chosen.length) {
    updateProgress();
    setStatus(`No ${band} images here. Try another band (${state.all.length} images exist in total).`, true);
    const counts = updateBandCounts();
    const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    setMode("problem", {
      title: `No ${band} images here`,
      detail: `This spot has ${plural(state.all.length, "image")} in other infrared bands.`,
      actionLabel: `Switch to ${best} (${plural(counts[best], "image")})`,
      action: () => { $("band").value = best; loadBand(); },
    });
    return;
  }

  setMode("busy", {
    title: "Fetching the first image…",
    detail: "Each new image takes about 10 seconds to cut out and align. They appear in the timeline as they arrive.",
  });
  loader.queue = [...state.frames];
  updateProgress();
  pump();
}

function fetchFrame(frame) {
  const { ra, dec } = state.target;
  const src =
    `/api/cutout.png?url=${encodeURIComponent(frame.meta.url)}` +
    `&ra=${ra}&dec=${dec}&size=${frame.size}`;
  frame.status = "loading";
  updateChip(frame);
  return new Promise((resolve) => {
    const img = new Image();
    frame.img = img;
    img.onload = () => { frame.image = img; frame.status = "ready"; resolve(); };
    img.onerror = () => { frame.status = "failed"; resolve(); };
    img.src = src;
  });
}

// Keep up to PARALLEL_LOADS requests in flight until the queue is empty.
function pump() {
  const run = state.run;
  while (loader.active < PARALLEL_LOADS && loader.queue.length) {
    const frame = loader.queue.shift();
    loader.active++;
    fetchFrame(frame).then(() => {
      if (run !== state.run) return;
      loader.active--;
      frameSettled(frame);
      pump();
    });
  }
}

function frameSettled(frame) {
  updateChip(frame);
  updateProgress();
  updateTransport();
  const ready = state.frames.filter((f) => f.status === "ready");
  if (ready.length && (ready.length === 1 || state.frames[state.current].status !== "ready")) {
    show(state.frames.indexOf(ready[0]));
  } else if (ready.length && $("diff").checked) {
    show(state.current); // the reference frame may have just arrived
  }
  const pending = state.frames.some((f) => f.status === "queued" || f.status === "loading");
  if (!ready.length && !pending) {
    setMode("problem", {
      title: "None of the images could be loaded",
      detail: "The archive did not return any of these frames. It is sometimes busy; trying again usually works.",
      actionLabel: "Retry all frames",
      action: () => retry(state.frames),
    });
  }
}

function retry(frames) {
  const failed = frames.filter((f) => f.status === "failed");
  if (!failed.length) return;
  for (const frame of failed) {
    frame.status = "queued";
    frame.pixels = null;
    updateChip(frame);
    loader.queue.push(frame);
  }
  if (!state.frames.some((f) => f.status === "ready")) {
    setMode("busy", { title: "Trying again…", detail: "Each image takes about 10 seconds to cut out and align." });
  }
  updateProgress();
  pump();
}

function updateProgress() {
  const total = state.frames.length;
  const ready = state.frames.filter((f) => f.status === "ready").length;
  const failed = state.frames.filter((f) => f.status === "failed").length;
  const pending = total - ready - failed;

  $("progress").hidden = !total || !pending;
  $("load-hint").hidden = !total || !pending;
  $("retry-failed").hidden = !failed || !total;
  if (!total) return;

  $("progress").setAttribute("aria-valuemax", total);
  $("progress").setAttribute("aria-valuenow", ready + failed);
  $("progress-fill").style.width = `${((ready + failed) / total) * 100}%`;
  $("retry-failed").textContent = `Retry ${plural(failed, "failed frame")}`;

  const band = $("band").value;
  const failedNote = failed ? `, ${failed} failed` : "";
  if (pending) {
    setStatus(
      `${state.target.label}: ${state.inBand} ${band} exposures found, ` +
      `loaded ${ready} of ${total}${failedNote}.`
    );
  } else if (ready) {
    setStatus(
      `${state.target.label}: showing ${ready} of ${state.inBand} ${band} exposures` +
      (failed ? `. ${plural(failed, "frame")} could not be loaded.` : "."),
      false
    );
  } else {
    setStatus(`None of the ${total} ${band} frames could be loaded.`, true);
  }
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

  const diffOn = $("diff").checked;
  const reference = state.frames.find((f) => f.status === "ready");
  if (diffOn && reference && reference !== frame) {
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

  if ($("stage").dataset.mode !== "image") setMode("image");
  $("stamp").textContent = `${frame.meta.date} UTC · ${frame.meta.band}`;
  $("counter").textContent = `${index + 1} / ${state.frames.length}`;
  $("diff-badge").hidden = !diffOn;
  $("diff-badge").textContent = reference === frame ? "Reference frame" : "Difference";
  $("diff-legend").hidden = !diffOn;
  canvas.setAttribute(
    "aria-label",
    `${diffOn && reference !== frame ? "Difference image" : "SPHEREx infrared image"} of ` +
    `${state.target.label}, ${frame.meta.date} UTC, band ${frame.meta.band}`
  );
  drawScale(frame.image.width);

  for (const f of state.frames) {
    const active = f === frame;
    f.chip?.classList.toggle("active", active);
    f.chip?.classList.toggle("reference", diffOn && f === reference);
    if (active) f.chip?.setAttribute("aria-current", "true");
    else f.chip?.removeAttribute("aria-current");
    f.tick?.classList.toggle("active", active);
  }
}

// The scale bar is the largest round length that fits in about a third of the field.
function drawScale(widthPx) {
  const fieldArcmin = (widthPx * PIXEL_ARCSEC) / 60;
  const length = [10, 5, 3, 2, 1, 0.5].find((v) => v <= fieldArcmin * 0.3) || 0.5;
  $("scale-bar").style.width = `${(length / fieldArcmin) * 100}%`;
  $("scale-label").textContent = `${length} arcmin`;
  $("scalebar").setAttribute("aria-label", `Scale bar: ${length} arcminutes`);
  $("field-note").hidden = false;
  $("field-note").textContent = `Field ${fieldArcmin.toFixed(1)}′ across`;
}

function step(direction) {
  const n = state.frames.length;
  for (let k = 1; k <= n; k++) {
    const i = (state.current + direction * k + n * k) % n;
    if (state.frames[i].status === "ready") return show(i);
  }
}

function updateTransport() {
  const ready = state.frames.filter((f) => f.status === "ready").length;
  for (const id of ["prev", "next", "play"]) $(id).disabled = ready < 2;
  if (ready < 2) stopBlink();
}

// ---------- timeline ----------

// Split the frames into survey passes: runs with no gap longer than NEW_EPOCH_GAP_DAYS.
function passes() {
  const groups = [];
  state.frames.forEach((frame, i) => {
    const prev = state.frames[i - 1];
    if (!prev || frame.meta.mjd - prev.meta.mjd > NEW_EPOCH_GAP_DAYS) {
      groups.push({ gap: prev ? frame.meta.mjd - prev.meta.mjd : 0, frames: [] });
    }
    groups[groups.length - 1].frames.push(frame);
  });
  return groups;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function buildTimeline() {
  const box = $("timeline");
  box.replaceChildren();
  $("axis-track").replaceChildren();
  $("timeline-wrap").hidden = !state.frames.length;
  if (!state.frames.length) return;

  const groups = passes();
  const first = state.frames[0].meta;
  const last = state.frames[state.frames.length - 1].meta;
  const span = last.mjd - first.mjd;
  const at = (mjd) => (span ? ((mjd - first.mjd) / span) * 100 : 50);

  $("timeline-summary").textContent =
    `${plural(state.frames.length, "frame")} · ${groups.length} survey pass${groups.length === 1 ? "" : "es"}` +
    (span ? ` · spanning ${spanLabel(span)}` : "");
  $("axis").hidden = !span;
  $("axis-start").textContent = fullDay(first.date);
  $("axis-end").textContent = fullDay(last.date);

  groups.forEach((group, g) => {
    const a = group.frames[0].meta;
    const b = group.frames[group.frames.length - 1].meta;

    // Proportional overview: a band per pass, a tick per frame.
    const band = el("span", "axis-pass");
    band.style.left = `${at(a.mjd)}%`;
    band.style.width = `${at(b.mjd) - at(a.mjd)}%`;
    $("axis-track").append(band);

    if (g > 0) {
      const gap = el("p", "pass-gap");
      gap.append(el("span", null, `${spanLabel(group.gap)} later`));
      box.append(gap);
    }

    const section = el("section", "pass");
    const head = el("header", "pass-head");
    head.append(
      el("span", "pass-name", `Survey pass ${g + 1}`),
      el("span", "pass-dates", rangeLabel(a.date, b.date)),
    );
    const row = el("div", "pass-frames");
    section.append(head, row);
    box.append(section);

    for (const frame of group.frames) {
      const index = state.frames.indexOf(frame);
      const chip = el("button", "chip");
      chip.type = "button";
      chip.dataset.index = index;
      chip.append(el("span", "thumb"), el("span", "chip-day", dayLabel(frame.meta.date)),
                  el("span", "chip-time", parts(frame.meta.date).time));
      chip.addEventListener("click", () => {
        if (frame.status === "failed") retry([frame]);
        else { stopBlink(); show(index); }
      });
      frame.chip = chip;
      row.append(chip);

      const tick = el("span", "axis-tick");
      tick.style.left = `${at(frame.meta.mjd)}%`;
      frame.tick = tick;
      $("axis-track").append(tick);
      updateChip(frame);
    }
  });
}

const STATUS_WORDS = {
  queued: "waiting to load",
  loading: "loading",
  ready: "loaded",
  failed: "failed to load, press to retry",
};

function updateChip(frame) {
  const chip = frame.chip;
  if (!chip) return;
  const index = state.frames.indexOf(frame);
  const active = chip.classList.contains("active");
  chip.className = `chip ${frame.status}${active ? " active" : ""}`;
  chip.disabled = frame.status === "queued" || frame.status === "loading";
  chip.title = frame.status === "failed"
    ? "This frame failed to load. Click to retry."
    : `${frame.meta.date} UTC, exposure ${frame.meta.id}`;
  chip.setAttribute(
    "aria-label",
    `Frame ${index + 1}, ${frame.meta.date} UTC, ${STATUS_WORDS[frame.status]}`
  );
  frame.tick.className = `axis-tick ${frame.status}${frame.tick.classList.contains("active") ? " active" : ""}`;

  const thumb = chip.querySelector(".thumb");
  if (frame.status === "ready" && !thumb.firstChild) {
    const img = new Image();
    img.alt = "";
    img.src = frame.image.src;
    thumb.append(img);
  } else if (frame.status !== "ready") {
    thumb.replaceChildren();
  }
}

// ---------- blinking ----------

const blinkInterval = () => 1100 - $("speed").value * 100; // 1000 ms down to 100 ms

function startBlink() {
  stopBlink();
  state.timer = setInterval(() => step(1), blinkInterval());
  $("play").textContent = "Pause";
  $("play").setAttribute("aria-pressed", "true");
  $("play").classList.add("playing");
}

function stopBlink() {
  clearInterval(state.timer);
  state.timer = null;
  $("play").textContent = "Blink";
  $("play").setAttribute("aria-pressed", "false");
  $("play").classList.remove("playing");
}

function toggleBlink() {
  if (state.timer) stopBlink();
  else if (!$("play").disabled) startBlink();
}

function showSpeed() {
  const perSecond = 1000 / blinkInterval();
  $("speed-out").textContent = `${perSecond.toFixed(perSecond < 3 ? 1 : 0)}/s`;
  $("speed").setAttribute("aria-valuetext", `${perSecond.toFixed(1)} frames per second`);
}

// ---------- wiring ----------

function runPreset(preset) {
  const text = preset.name ?? `${preset.ra} ${preset.dec}`;
  $("target").value = text;
  go(text, preset.label);
}

async function init() {
  for (const preset of PRESETS) {
    const btn = el("button", "preset");
    btn.type = "button";
    btn.append(el("span", "preset-name", preset.label), el("span", "preset-note", preset.note));
    btn.addEventListener("click", () => runPreset(preset));
    $("presets").append(btn);
  }
  $("intro-start").addEventListener("click", () => runPreset(PRESETS[0]));
  $("problem-action").addEventListener("click", () => problemAction?.());
  $("retry-failed").addEventListener("click", () => retry(state.frames));

  $("search").addEventListener("submit", (e) => {
    e.preventDefault();
    if ($("target").value.trim()) go($("target").value);
    else $("target").focus();
  });
  for (const id of ["band", "size", "limit"]) {
    $(id).addEventListener("change", () => { if (state.all.length) loadBand(); });
  }
  $("play").addEventListener("click", toggleBlink);
  $("prev").addEventListener("click", () => { stopBlink(); step(-1); });
  $("next").addEventListener("click", () => { stopBlink(); step(1); });
  $("speed").addEventListener("input", () => { showSpeed(); if (state.timer) startBlink(); });
  $("diff").addEventListener("change", () => {
    $("diff-legend").hidden = !$("diff").checked;
    show(state.current);
  });
  $("cross").addEventListener("change", () => { $("crosshair").hidden = !$("cross").checked; });
  showSpeed();

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target instanceof Element ? e.target : document.body;
    // Leave typing, menus and sliders alone; space on a button presses that button.
    if (t.matches("input[type=text], select, textarea")) return;
    const onControl = t.matches("button, input");
    const onSlider = t.matches("input[type=range]");
    if (e.key === "ArrowLeft" && !onSlider) { stopBlink(); step(-1); }
    else if (e.key === "ArrowRight" && !onSlider) { stopBlink(); step(1); }
    else if (e.key === " " && !onControl) { e.preventDefault(); toggleBlink(); }
    else if (e.key === "d" || e.key === "D") { $("diff").click(); }
    else if (e.key === "c" || e.key === "C") { $("cross").click(); }
  });

  try {
    state.bands = await getJSON("/api/bands");
    for (const id of Object.keys(state.bands)) $("band").add(new Option(id, id));
    $("band").value = "D2";
    updateBandCounts();
  } catch (err) {
    setStatus(`Could not reach the SPHEREx Blink server: ${err.message}`, true);
  }
}

init();

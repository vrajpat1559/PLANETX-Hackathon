// SPHEREx Blink: the page logic.
//
// Flow:  go()   -> find the target and what the telescopes have on it
//        load() -> fetch the images for the chosen band / field / options
//        show() -> draw one of them
//
// Sections below: state, target, building the list of frames, loading,
// display, playing, address bar, wiring.

import { api } from "./api.js";
import { average, noiseLevel, paintDifference, paintImage } from "./picture.js";
import { drawStarfield } from "./starfield.js";
import { drawTimeline, markCurrent } from "./timeline.js";

// The targets named in the challenge.
const PRESETS = [
  { label: "Barnard's Star", target: "Barnard's Star" },
  { label: "Epsilon Indi B", target: "eps Ind B" },
  { label: "WISE 0855", target: "WISE J085510.83-071442.5" },
  { label: "RW Aurigae", target: "RW Aur" },
  { label: "R Draconis", target: "R Dra" },
];
const EXPOSURES_LOADED_AT_ONCE = 3;
const WISE_MOMENTS_IN_SHORT_HISTORY = 5;
const WISE_WAVELENGTH = { W1: "3.4 µm", W2: "4.6 µm" };

const $ = (id) => document.getElementById(id);
const context = $("view").getContext("2d");

// ---------- state ----------

const state = {
  detectors: {},      // "D2" -> { min_um, max_um, wise_band }, from the server
  target: null,       // { ra, dec, label, note }
  visits: [],         // SPHEREx visits to the target
  exposures: [],      // every single SPHEREx exposure, all bands
  wiseVisits: [],     // WISE visits to the target, 2010-2024
  // The images being shown, oldest first. Each frame is
  // { telescope, label, band, detail, mjd, status, pixels, size, fetch }.
  frames: [],
  current: 0,         // index of the frame on screen
  noise: null,        // sky noise of the first frame; every frame is drawn against it
  timer: null,        // play interval
  loadId: 0,          // goes up on every reload so slow old loads are ignored
};

const readyFrames = () => state.frames.filter((frame) => frame.status === "ready");

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

// ---------- target ----------

async function go(text) {
  stop();
  try {
    setStatus("Looking up the target…");
    await openTarget(await api.resolve(text));
  } catch (error) {
    setStatus(`Could not load that target: ${error.message}`, true);
  }
}

async function openTarget(target) {
  state.target = target;
  $("note").textContent = target.note || "";
  $("note").hidden = !target.note;

  setStatus(`Searching the archive at RA ${target.ra.toFixed(4)}°, Dec ${target.dec.toFixed(4)}°…`);
  const [found, wiseVisits] = await Promise.all([
    api.observations(target.ra, target.dec),
    api.wiseVisits(target.ra, target.dec).catch(() => []), // history is a bonus; carry on without it
  ]);
  state.visits = found.visits;
  state.exposures = found.exposures;
  state.wiseVisits = wiseVisits;

  if (!state.exposures.length) {
    state.frames = [];
    drawTimeline(state.frames, 0, pick);
    setStatus("SPHEREx has no released images covering this position yet.", true);
    return;
  }
  load();
}

// ---------- building the list of frames ----------

// One frame per SPHEREx visit: all its exposures in the chosen band, combined.
function visitFrames(detector) {
  const { ra, dec } = state.target;
  const fov = $("fov").value;
  return state.visits
    .filter((visit) => visit.exposures_per_detector[detector])
    .map((visit) => ({
      telescope: "spherex",
      label: visit.label,
      band: spherexBandName(detector),
      detail: `${visit.exposures_per_detector[detector]} exposures combined`,
      mjd: visit.mid_mjd,
      status: "loading",
      fetch: () => api.stack(ra, dec, fov, detector, visit.index),
    }));
}

// One frame per SPHEREx exposure, optionally thinned out to a handful spread over time.
function exposureFrames(detector) {
  const { ra, dec } = state.target;
  const fov = $("fov").value;
  const inBand = state.exposures.filter((exposure) => exposure.detector === detector);
  return spreadOut(inBand, Number($("limit").value)).map((exposure) => ({
    telescope: "spherex",
    label: exposure.date.slice(0, 10),
    band: spherexBandName(detector),
    detail: "",
    mjd: exposure.mjd,
    status: "loading",
    fetch: () => api.exposure(ra, dec, fov, exposure.url),
  }));
}

// Frames from the older WISE telescope, in its band closest to the chosen SPHEREx one.
function historyFrames(detector) {
  if ($("history").value === "off") return [];
  const { ra, dec } = state.target;
  const fov = $("fov").value;
  const band = state.detectors[detector].wise_band;
  const available = state.wiseVisits.filter((visit) => visit.exposures_per_band[band]);
  const limit = $("history").value === "all" ? 0 : WISE_MOMENTS_IN_SHORT_HISTORY;
  return spreadOut(available, limit).map((visit) => ({
    telescope: "wise",
    label: visit.label,
    band: `${band} · ${WISE_WAVELENGTH[band]}`,
    detail: visit.exposures_per_band[band] > 1
      ? `about ${visit.exposures_per_band[band]} exposures combined`
      : "",
    mjd: visit.mjd,
    status: "loading",
    fetch: () => api.wiseStack(ra, dec, fov, band, visit.index),
  }));
}

function spherexBandName(detector) {
  const range = state.detectors[detector];
  return `${detector} · ${range.min_um}–${range.max_um} µm`;
}

// Pick `limit` items evenly spaced through a list (0 = keep everything).
function spreadOut(list, limit) {
  if (!limit || list.length <= limit) return list;
  const picked = new Set();
  for (let i = 0; i < limit; i++) {
    picked.add(list[Math.round((i * (list.length - 1)) / (limit - 1))]);
  }
  return [...picked];
}

// ---------- loading ----------

function load() {
  stop();
  const loadId = ++state.loadId;
  const stillCurrent = () => loadId === state.loadId;
  const detector = $("detector").value;
  const byVisit = $("mode").value === "visits";
  $("limit-label").hidden = byVisit;
  writeAddressBar();

  const fromSpherex = byVisit ? visitFrames(detector) : exposureFrames(detector);
  const fromWise = historyFrames(detector);
  state.frames = [...fromWise, ...fromSpherex];  // shown oldest first
  const queue = [...fromSpherex, ...fromWise];   // but SPHEREx is fetched first
  state.current = state.frames.indexOf(fromSpherex[0]);
  state.noise = null;
  drawTimeline(state.frames, state.current, pick);
  drawScaleBar();

  if (!fromSpherex.length) {
    setStatus(`No ${detector} images here yet. Try another band.`, true);
    return;
  }

  const total = queue.length;
  let finished = 0;
  const report = () => {
    const done = finished === total;
    setStatus(
      `${state.target.label}: loaded ${finished} of ${total} images.` +
      (done ? "" : " An image that has not been requested before takes about 20 seconds.")
    );
  };
  report();

  const worker = async () => {
    while (queue.length && stillCurrent()) {
      const frame = queue.shift();
      try {
        const image = await frame.fetch();
        if (!stillCurrent()) return;
        frame.pixels = image.pixels;
        frame.size = image.size;
        if (image.wavelength) frame.detail = `${image.wavelength.toFixed(2)} µm at the target`;
        frame.status = "ready";
        state.noise ??= noiseLevel(image.pixels);
      } catch {
        if (!stillCurrent()) return;
        frame.status = "failed";
      }
      finished++;
      report();
      drawTimeline(state.frames, state.current, pick);
      afterFrameArrives();
    }
  };
  // Combined images go one at a time: each already uses every archive connection we allow.
  const workers = byVisit ? 1 : EXPOSURES_LOADED_AT_ONCE;
  for (let i = 0; i < workers; i++) worker();
}

function afterFrameArrives() {
  const ready = readyFrames();
  if (ready.length === 1) show(state.frames.indexOf(ready[0]));      // first picture: show it
  else if (ready.length === 2 && !state.timer) play();               // second: start the movie
  else if ($("view-mode").value !== "image") show(state.current);    // these views depend on other frames
}

// ---------- display ----------

// Brightness slider (0-100) -> how many times the sky noise is drawn as white (10 to 10,000).
const whiteLevel = () => 10 ** (1 + (3 * $("brightness").value) / 100);

function show(index) {
  const frame = state.frames[index];
  if (!frame || frame.status !== "ready") return;
  state.current = index;

  const ready = readyFrames();
  const first = ready[0];
  const viewMode = $("view-mode").value;
  let caption;

  if (viewMode === "sum" && ready.length > 1) {
    paintImage(context, average(ready.map((f) => f.pixels)), frame.size, state.noise, whiteLevel());
    caption = `${ready.length} images added together`;
  } else if (viewMode === "difference" && frame !== first) {
    paintDifference(context, frame.pixels, first.pixels, frame.size, state.noise, whiteLevel());
    caption = `${frame.label} minus ${first.label}`;
  } else {
    paintImage(context, frame.pixels, frame.size, state.noise, whiteLevel());
    caption = [frame.label, frame.band, frame.detail].filter(Boolean).join(" · ");
  }

  $("empty").hidden = true;
  $("stamp").hidden = false;
  $("stamp").textContent = caption;
  $("badge").hidden = false;
  $("badge").textContent = frame.telescope === "wise" ? "WISE" : "SPHEREx";
  $("badge").className = `badge ${frame.telescope}`;
  $("crosshair").hidden = !$("cross").checked;
  $("compass").hidden = false;
  markCurrent(state.frames, index);
}

// Move to the next (+1) or previous (-1) frame that has finished loading.
function step(direction) {
  const count = state.frames.length;
  for (let k = 1; k <= count; k++) {
    const index = (state.current + direction * k + count * k) % count;
    if (state.frames[index].status === "ready") return show(index);
  }
}

// A timeline dot was clicked.
function pick(index) {
  stop();
  show(index);
}

// A bar in the corner showing how big 1, 2 or 5 arcminutes is at this zoom.
function drawScaleBar() {
  const fieldArcmin = Number($("fov").value) * 60;
  const length = [5, 2, 1].find((arcmin) => arcmin <= fieldArcmin * 0.2) ?? 1;
  $("scale-bar").style.width = `${(length / fieldArcmin) * $("view").clientWidth}px`;
  $("scale-label").textContent = `${length} arcmin`;
  $("scale").hidden = false;
}

// ---------- playing ----------

function play() {
  stop();
  const milliseconds = 1100 - $("speed").value * 100; // 1000 ms down to 100 ms per image
  state.timer = setInterval(() => step(1), milliseconds);
  $("play").textContent = "Pause";
}

function stop() {
  clearInterval(state.timer);
  state.timer = null;
  $("play").textContent = "Play";
}

// ---------- address bar ----------
// The address always describes the current view, so it can be shared or embedded:
//   /?ra=269.4463&dec=4.7682&fov=0.25&band=D2&name=Barnard's Star

function writeAddressBar() {
  const { ra, dec, label } = state.target;
  const parameters = new URLSearchParams({
    ra: ra.toFixed(5),
    dec: dec.toFixed(5),
    fov: $("fov").value,
    band: $("detector").value,
    mode: $("mode").value,
    history: $("history").value,
    name: label,
  });
  history.replaceState(null, "", `?${parameters}`);
}

function readAddressBar() {
  const parameters = new URLSearchParams(location.search);
  const choose = (id, value) => {
    const allowed = [...$(id).options].some((option) => option.value === value);
    if (allowed) $(id).value = value;
  };
  choose("fov", parameters.get("fov"));
  choose("detector", parameters.get("band"));
  choose("mode", parameters.get("mode"));
  choose("history", parameters.get("history"));

  const ra = parseFloat(parameters.get("ra"));
  const dec = parseFloat(parameters.get("dec"));
  const name = parameters.get("name") || parameters.get("target");
  if (Number.isFinite(ra) && Number.isFinite(dec)) {
    const label = name || `${ra} ${dec}`;
    $("target").value = label;
    openTarget({ ra, dec, label, note: "" }).catch((error) =>
      setStatus(`Could not load that target: ${error.message}`, true));
  } else if (name) {
    $("target").value = name;
    go(name);
  }
}

// ---------- wiring ----------

async function start() {
  drawStarfield($("starfield"));
  window.addEventListener("resize", () => {
    drawStarfield($("starfield"));
    if (state.frames.length) drawScaleBar();
  });

  const settings = await api.config();
  state.detectors = settings.detectors;
  for (const [name, range] of Object.entries(settings.detectors)) {
    $("detector").add(new Option(`${name} · ${range.min_um}–${range.max_um} µm`, name));
  }
  $("detector").value = "D2";
  $("fov").value = String(settings.fov.default);

  for (const preset of PRESETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = preset.label;
    button.addEventListener("click", () => {
      $("target").value = preset.target;
      go(preset.target);
    });
    $("presets").append(button);
  }

  $("search").addEventListener("submit", (event) => {
    event.preventDefault();
    if ($("target").value.trim()) go($("target").value);
  });
  for (const id of ["detector", "fov", "mode", "limit", "history"]) {
    $(id).addEventListener("change", () => { if (state.exposures.length) load(); });
  }
  for (const id of ["view-mode", "brightness"]) {
    $(id).addEventListener("input", () => show(state.current));
  }
  $("play").addEventListener("click", () => (state.timer ? stop() : play()));
  $("prev").addEventListener("click", () => { stop(); step(-1); });
  $("next").addEventListener("click", () => { stop(); step(1); });
  $("speed").addEventListener("input", () => { if (state.timer) play(); });
  $("cross").addEventListener("change", () => show(state.current));

  document.addEventListener("keydown", (event) => {
    if (event.target.matches("input[type=text], select")) return;
    if (event.key === "ArrowLeft") { stop(); step(-1); }
    else if (event.key === "ArrowRight") { stop(); step(1); }
    else if (event.key === " ") { event.preventDefault(); state.timer ? stop() : play(); }
  });

  readAddressBar();
}

start();

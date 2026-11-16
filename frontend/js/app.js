// SPHEREx Blink: the page logic.
//
// Flow:  go()   -> find the target and what the telescopes have on it
//        load() -> fetch the images for the chosen band / field / options
//        show() -> draw one of them
//
// Sections below: state, target, building the list of frames, loading,
// display, playing, address bar, wiring.

import { api } from "./api.js";
import { average, noiseLevel, paintDifference, paintHighlights, paintImage } from "./picture.js";
import { drawBackground } from "./solarsystem.js";
import { drawTimeline, markCurrent } from "./timeline.js";
import { initSkyView, layoutSky, resetSkyView, zoomBy, ZOOM_BUTTON_STEP } from "./skyview.js";
import { drawSky, setSmooth } from "./render.js";

// The targets named in the challenge.
const PRESETS = [
  { label: "Barnard's Star", target: "Barnard's Star" },
  { label: "Epsilon Indi B", target: "eps Ind B" },
  { label: "WISE 0855", target: "WISE J085510.83-071442.5" },
  { label: "RW Aurigae", target: "RW Aur" },
  { label: "R Draconis", target: "R Dra" },
];
const EXPOSURES_LOADED_AT_ONCE = 3;
const VISITS_LOADED_AT_ONCE = 3;
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
  lookupId: 0,        // goes up on every search, so a slow old name lookup cannot win
  loadId: 0,          // goes up on every reload so slow old loads are ignored
  loader: null,       // the load in progress: { loadId, queue, total, finished, running, limit }
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
    const request = ++state.lookupId;
    const target = await api.resolve(text);
    if (request !== state.lookupId) return;  // a newer search has started since
    await openTarget(target);
  } catch (error) {
    setStatus(`Could not load that target: ${error.message}`, true);
  }
}

async function openTarget(target) {
  state.target = target;
  // A new target: back to the landing scene until its first image arrives,
  // with the player bar showing the images as they load.
  document.body.classList.remove("has-image");
  document.body.classList.add("has-target");
  resetSkyView();
  // Clear the previous target's images and caption, and stop any of its
  // downloads that are still running, so nothing stale shows while searching.
  state.loadId++;
  state.frames = [];
  drawTimeline(state.frames, 0, pick);
  $("stamp").hidden = true;
  $("badge").hidden = true;
  $("compass").hidden = true;
  $("note").textContent = target.note || "";
  $("note").hidden = !target.note;

  setStatus(`Searching the archive at RA ${target.ra.toFixed(4)}°, Dec ${target.dec.toFixed(4)}°…`);
  // The WISE history search is slow (IRSA), so SPHEREx images start loading
  // without waiting for it; WISE images join the timeline when it answers.
  const wiseSearch = api.wiseVisits(target.ra, target.dec).catch(() => []); // history is a bonus
  const found = await api.observations(target.ra, target.dec);
  if (state.target !== target) return; // the visitor already picked something else
  state.visits = found.visits;
  state.exposures = found.exposures;
  state.wiseVisits = [];

  if (!state.exposures.length) {
    state.frames = [];
    drawTimeline(state.frames, 0, pick);
    setStatus("SPHEREx has no released images covering this position yet.", true);
    return;
  }
  load();

  const wiseVisits = await wiseSearch;
  if (state.target !== target) return;
  state.wiseVisits = wiseVisits;
  addHistory();
}

// The logo was clicked: forget the target and go back to the landing scene.
// Settings (band, field, WISE on/off) stay as they are.
function goHome() {
  stop();
  state.lookupId++;            // a name lookup still running is ignored
  state.loadId++;              // so are image downloads still running
  state.target = null;         // and openTarget() stops when it sees this
  state.visits = [];
  state.exposures = [];        // settings changes now have nothing to reload
  state.wiseVisits = [];
  state.frames = [];
  drawTimeline(state.frames, 0, pick);
  document.body.classList.remove("has-image", "has-target");
  resetSkyView();
  for (const id of ["stamp", "badge", "compass", "crosshair", "scale", "note"]) $(id).hidden = true;
  $("empty").hidden = false;
  $("target").value = "";
  setStatus("Pick a target to begin.");

  // Drop the target from the address, keep the settings.
  const parameters = new URLSearchParams(location.search);
  for (const key of ["ra", "dec", "name", "target"]) parameters.delete(key);
  const query = parameters.toString();
  history.replaceState(null, "", query ? `?${query}` : location.pathname);
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
  const detector = $("detector").value;
  const byVisit = $("mode").value === "visits";
  $("limit-label").hidden = byVisit;
  writeAddressBar();

  const fromSpherex = byVisit ? visitFrames(detector) : exposureFrames(detector);
  const fromWise = historyFrames(detector); // empty until the WISE search has answered
  state.frames = [...fromWise, ...fromSpherex];  // shown oldest first
  state.current = state.frames.indexOf(fromSpherex[0]);
  state.noise = null;
  drawTimeline(state.frames, state.current, pick);
  drawScaleBar();

  if (!fromSpherex.length) {
    setStatus(`No ${detector} images here yet. Try another band.`, true);
    return;
  }

  // Several images load at once. SPHEREx comes from Amazon S3, which has no
  // connection limit; the server itself keeps IRSA (WISE) requests to a safe number.
  state.loader = {
    loadId,
    queue: [],
    total: 0,
    finished: 0,
    running: 0,
    limit: byVisit ? VISITS_LOADED_AT_ONCE : EXPOSURES_LOADED_AT_ONCE,
  };
  enqueue([...fromSpherex, ...fromWise]); // SPHEREx is fetched first
}

// WISE history arrived after loading started: put it at the start of the timeline.
function addHistory() {
  if (!state.loader || state.frames.some((frame) => frame.telescope === "wise")) return;
  const fromWise = historyFrames($("detector").value);
  if (!fromWise.length) return;
  const showing = state.frames[state.current];
  state.frames = [...fromWise, ...state.frames];
  state.current = state.frames.indexOf(showing);
  drawTimeline(state.frames, state.current, pick);
  enqueue(fromWise);
}

// Add frames to the current load and start workers for them.
function enqueue(frames) {
  const loader = state.loader;
  loader.queue.push(...frames);
  loader.total += frames.length;
  reportProgress();
  while (loader.running < loader.limit && loader.running < loader.queue.length) {
    loader.running++;
    loadWorker(loader);
  }
}

async function loadWorker(loader) {
  const stillCurrent = () => loader.loadId === state.loadId;
  while (loader.queue.length && stillCurrent()) {
    const frame = loader.queue.shift();
    try {
      const image = await frame.fetch();
      if (!stillCurrent()) return;
      frame.pixels = image.pixels;
      frame.size = image.size;
      if (image.wavelength) frame.detail = `${image.wavelength.toFixed(2)} µm at the target`;
      if (image.exposuresUsed > 1) frame.detail = `${image.exposuresUsed} exposures combined`;
      frame.status = "ready";
      state.noise ??= noiseLevel(image.pixels);
    } catch {
      if (!stillCurrent()) return;
      frame.status = "failed";
    }
    loader.finished++;
    reportProgress();
    drawTimeline(state.frames, state.current, pick);
    afterFrameArrives();
  }
  loader.running--;
}

function reportProgress() {
  const { finished, total } = state.loader;
  setStatus(
    `${state.target.label}: loaded ${finished} of ${total} images.` +
    (finished === total ? "" : " New images take a few seconds; older WISE images can take longer.") +
    ($("history").value === "off" ? " WISE history is off: click WISE in the key to turn it on." : "")
  );
}

function afterFrameArrives() {
  const ready = readyFrames();
  if (ready.length === 1) show(state.frames.indexOf(ready[0]));      // first picture: show it
  // No autoplay: flipping only starts when the visitor presses Play (or space).
  else if ($("view-mode").value !== "image") show(state.current);    // these views depend on other frames
}

// ---------- display ----------

// Brightness slider (0-100) -> how many times the sky noise is drawn as white.
// A lower white level makes more of the picture white, so it looks brighter:
// left (0) = 10,000 (dim), middle = about 316, right (100) = 10 (bright).
const whiteLevel = () => 10 ** (4 - (3 * $("brightness").value) / 100);

function show(index) {
  const frame = state.frames[index];
  if (!frame || frame.status !== "ready") return;
  state.current = index;

  const ready = readyFrames();
  const first = ready[0];
  const viewMode = $("view-mode").value;
  let caption;

  // Deep image: average every loaded image from the same telescope. Random
  // noise cancels out (by about the square root of the number of images), so
  // faint stars and galaxies stand out. Mixing telescopes would blur it, since
  // WISE and SPHEREx differ in sharpness and colour.
  const sameTelescope = ready.filter((f) => f.telescope === frame.telescope && f.size === frame.size);
  if (viewMode === "sum" && sameTelescope.length > 1) {
    paintImage(context, average(sameTelescope.map((f) => f.pixels)), frame.size, state.noise, whiteLevel());
    const name = frame.telescope === "wise" ? "WISE" : "SPHEREx";
    caption = `Deep image · ${sameTelescope.length} ${name} images combined`;
  } else if (viewMode === "difference" && frame !== first) {
    paintDifference(context, frame.pixels, first.pixels, frame.size, state.noise, whiteLevel());
    caption = `${frame.label} minus ${first.label}`;
  } else if (viewMode === "highlight" && frame !== first) {
    const previous = ready[ready.indexOf(frame) - 1];
    if (previous.telescope !== frame.telescope || previous.size !== frame.size) {
      // Two telescopes see the sky differently, so every star would "change".
      paintImage(context, frame.pixels, frame.size, state.noise, whiteLevel());
      caption = `${frame.label} · previous image is from another telescope, nothing highlighted`;
    } else {
      const spots = paintHighlights(context, frame.pixels, previous.pixels, frame.size, state.noise, whiteLevel());
      caption = `${frame.label} vs ${previous.label}: ${spots} change${spots === 1 ? "" : "s"} · green flux increase, magenta flux decrease`;
    }
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
  // The image now fills the page (and the landing scene fades away).
  document.body.classList.add("has-image");
  drawSky(context.canvas);  // the picture as displayed: smoothed and sharpened, or raw pixels
  layoutSky();
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
// A bar showing a round length on the sky, sized for the current zoom.
function drawScaleBar() {
  const fieldArcmin = Number($("fov").value) * 60;      // width of the whole picture
  const pictureWidth = $("sky").clientWidth;            // how wide it is drawn, in screen pixels
  if (!pictureWidth) return;
  const visibleArcmin = fieldArcmin * Math.min(1, $("stage").clientWidth / pictureWidth);
  const length = [10, 5, 2, 1, 0.5, 0.25, 0.1].find((arcmin) => arcmin <= visibleArcmin * 0.15) ?? 0.1;
  $("scale-bar").style.width = `${(length / fieldArcmin) * pictureWidth}px`;
  $("scale-label").textContent = length >= 1 ? `${length} arcmin` : `${Math.round(length * 60)} arcsec`;
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


// A random position, spread evenly over the whole sky. (Picking Dec uniformly
// would crowd the poles; taking the arcsine of a uniform number gives every
// patch of sky the same chance.) Returned as "RA Dec" in degrees.
function randomSpot() {
  const ra = Math.random() * 360;
  const dec = (Math.asin(2 * Math.random() - 1) * 180) / Math.PI;
  return `${ra.toFixed(2)} ${dec.toFixed(2)}`;
}

// Animated background art (see the import at the top). Off = plain deep black.
const SHOW_BACKGROUND_ART = true;

async function start() {
  if (SHOW_BACKGROUND_ART) drawBackground($("starfield"));
  window.addEventListener("resize", () => {
    if (SHOW_BACKGROUND_ART) drawBackground($("starfield"));
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
  const surprise = document.createElement("button");
  surprise.type = "button";
  surprise.className = "random";
  surprise.textContent = "Random spot";
  surprise.title = "Jump to a random patch of sky";
  surprise.addEventListener("click", () => {
    const spot = randomSpot();
    $("target").value = spot;
    go(spot);
  });
  $("presets").append(surprise);

  $("home").addEventListener("click", (event) => {
    event.preventDefault();   // reset in place instead of reloading the page
    goHome();
  });
  $("search").addEventListener("submit", (event) => {
    event.preventDefault();
    if ($("target").value.trim()) go($("target").value);
  });
  // WISE in the key doubles as an on/off switch for the WISE history, so it
  // can never be switched off without it showing.
  $("wise-toggle").addEventListener("click", () => {
    $("history").value = $("history").value === "off" ? "some" : "off";
    syncWiseButton();
    if (state.exposures.length) load();
  });
  $("history").addEventListener("change", syncWiseButton);
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
    if (event.key === "Escape") { setDrawer(false); setAbout(false); return; }
    // Leave typing, menus, sliders and the settings drawer alone; space on a
    // button already presses that button.
    if (!(event.target instanceof Element)) return;
    if (event.target.closest("input, select, textarea, #drawer, #about")) return;
    if (event.key === "ArrowLeft") { stop(); step(-1); }
    else if (event.key === "ArrowRight") { stop(); step(1); }
    else if (event.key === " " && !event.target.closest("button")) { event.preventDefault(); state.timer ? stop() : play(); }
  });

  initSkyView(() => { if (state.frames.length) drawScaleBar(); });
  $("zoom-in").addEventListener("click", () => zoomBy(ZOOM_BUTTON_STEP));
  $("zoom-out").addEventListener("click", () => zoomBy(1 / ZOOM_BUTTON_STEP));
  $("render-mode").addEventListener("change", () => {
    setSmooth($("render-mode").value === "smooth");
    show(state.current);
  });

  // The About panel: how it works, what to look for, the mission and the data.
  $("about-toggle").addEventListener("click", () => setAbout(true));
  $("about-close").addEventListener("click", () => setAbout(false));
  $("about").addEventListener("click", (event) => { if (event.target === $("about")) setAbout(false); });

  // The settings drawer: opened by the button in the top bar.
  $("settings-toggle").addEventListener("click", () => setDrawer(!$("drawer").classList.contains("open")));
  $("settings-close").addEventListener("click", () => setDrawer(false));
  document.addEventListener("pointerdown", (event) => {
    if (!$("drawer").classList.contains("open")) return;
    if (!event.target.closest("#drawer, #settings-toggle")) setDrawer(false);
  });

  // The Highlight button in the player bar is a shortcut for View: Highlight changes.
  $("highlight-toggle").addEventListener("click", () => {
    $("view-mode").value = $("view-mode").value === "highlight" ? "image" : "highlight";
    syncHighlightButton();
    show(state.current);
  });
  $("deep-toggle").addEventListener("click", () => {
    $("view-mode").value = $("view-mode").value === "sum" ? "image" : "sum";
    syncHighlightButton();
    show(state.current);
  });
  $("view-mode").addEventListener("input", syncHighlightButton);

  readAddressBar();
  syncHighlightButton();
  syncWiseButton();
}

function syncWiseButton() {
  const on = $("history").value !== "off";
  $("wise-toggle").setAttribute("aria-pressed", String(on));
  $("wise-toggle").classList.toggle("off", !on);
}

function setAbout(open) {
  if ($("about").hidden === !open) return;
  $("about").hidden = !open;
  $("about-toggle").setAttribute("aria-expanded", String(open));
  (open ? $("about-close") : $("about-toggle")).focus({ preventScroll: true });
}

function setDrawer(open) {
  const drawer = $("drawer");
  if (drawer.classList.contains("open") === open) return;
  drawer.classList.toggle("open", open);
  drawer.inert = !open;  // closed: its controls can't be reached with Tab
  $("settings-toggle").setAttribute("aria-expanded", String(open));
  (open ? $("detector") : $("settings-toggle")).focus({ preventScroll: true });
}

// The Deep and Highlight buttons are shortcuts for the View setting; keep them in step with it.
function syncHighlightButton() {
  $("highlight-toggle").setAttribute("aria-pressed", String($("view-mode").value === "highlight"));
  $("deep-toggle").setAttribute("aria-pressed", String($("view-mode").value === "sum"));
  document.body.dataset.view = $("view-mode").value;  // lets the key brighten the Highlight colours
}

start();

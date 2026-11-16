// The telescope image filling the first screen.
//
// The picture is square but screens are wide, so it is scaled to *cover* the
// first screen (full width, top and bottom cropped), like a background photo.
// The top bar and the player float over it, so the target is centred in the
// open area between them, and dragging can bring any part of the picture into
// that open area (the edge may slide under the bars, showing black behind them).
// On top of that the visitor can zoom and pan:
//   Ctrl/Cmd + scroll, or pinch   zoom in or out, toward the point under the cursor
//   the + and - buttons           zoom around the middle of the screen
//   drag                          move around
//   double-click                  back to the starting view
// The crosshair follows the target (the centre of the image), and `onChange`
// lets the page redraw anything that depends on the zoom, such as the scale bar.

const MAX_ZOOM = 12;
const WHEEL_SPEED = 0.0025;
const BUTTON_STEP = 1.6;

const stage = document.getElementById("stage");
const view = document.getElementById("sky"); // the display canvas (js/render.js)
const reticle = document.getElementById("crosshair");

const topBar = document.querySelector(".topbar");
const bottomBar = document.querySelector(".bottom"); // the caption and the player

let zoom = 1, panX = 0, panY = 0;  // pan: how far the image centre is from the open area's centre, in pixels
let onChange = () => {};

export function initSkyView(changed) {
  onChange = changed;
  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("dblclick", resetSkyView);
  // Safari reports trackpad pinches as "gesture" events rather than Ctrl + wheel.
  let lastScale = 1;
  stage.addEventListener("gesturestart", (event) => { event.preventDefault(); lastScale = 1; });
  stage.addEventListener("gesturechange", (event) => {
    event.preventDefault();
    zoomAt(event.clientX, event.clientY, event.scale / lastScale);
    lastScale = event.scale;
  });
  window.addEventListener("resize", layoutSky);
}

// Back to the starting view: whole width, centred on the target.
export function resetSkyView() {
  zoom = 1; panX = 0; panY = 0;
  layoutSky();
}

// Zoom around the middle of the open area (the + and - buttons).
export function zoomBy(factor) {
  const box = stage.getBoundingClientRect();
  const open = openArea();
  zoomAt(box.left + box.width / 2, box.top + (open.top + open.bottom) / 2, factor);
}

// The part of the stage not covered by the top bar or the player, as
// { top, bottom } in pixels from the top of the stage. Before a target is
// picked the player is hidden, so it falls back to the whole stage.
function openArea() {
  const stageBox = stage.getBoundingClientRect();
  const top = topBar.getBoundingClientRect().bottom - stageBox.top;
  const bottomBox = bottomBar.getBoundingClientRect();
  const bottom = bottomBox.height ? bottomBox.top - stageBox.top : stageBox.height;
  if (!(bottom - top > 100)) return { top: 0, bottom: stageBox.height }; // squeezed: use it all
  return { top, bottom };
}

// Size and place the picture for the current zoom and pan. Call after the
// picture changes size, and whenever the window does.
export function layoutSky() {
  if (!view.width) return;
  const stageWidth = stage.clientWidth;
  const open = openArea();
  const centreY = (open.top + open.bottom) / 2, openHeight = open.bottom - open.top;
  const scale = coverScale() * zoom;
  const width = view.width * scale, height = view.height * scale;
  // Sideways: never so far that the picture's edge comes into view.
  // Up and down: far enough that the top edge can reach the top bar and the
  // bottom edge the player, so every part of the picture can be seen.
  const maxX = Math.max(0, (width - stageWidth) / 2), maxY = Math.max(0, (height - openHeight) / 2);
  panX = Math.max(-maxX, Math.min(maxX, panX));
  panY = Math.max(-maxY, Math.min(maxY, panY));

  view.style.width = `${width}px`;
  view.style.height = `${height}px`;
  view.style.transform = `translate(${(stageWidth - width) / 2 + panX}px, ${centreY - height / 2 + panY}px)`;
  reticle.style.left = `${stageWidth / 2 + panX}px`;
  reticle.style.top = `${centreY + panY}px`;
  onChange();
}

// How much the picture is enlarged to just cover the first screen.
function coverScale() {
  return Math.max(stage.clientWidth / view.width, stage.clientHeight / view.height);
}

// Zoom by `factor`, keeping the screen point (x, y) fixed on the sky.
function zoomAt(x, y, factor) {
  const newZoom = Math.max(1, Math.min(MAX_ZOOM, zoom * factor));
  const actual = newZoom / zoom;
  const box = stage.getBoundingClientRect();
  const open = openArea();
  // The point sits `d` from the image centre; after zooming it will sit
  // `d * actual` from it, so move the centre to keep the point still.
  const dx = x - (box.left + box.width / 2 + panX);
  const dy = y - (box.top + (open.top + open.bottom) / 2 + panY);
  panX += dx * (1 - actual);
  panY += dy * (1 - actual);
  zoom = newZoom;
  layoutSky();
}

function onWheel(event) {
  // Plain scrolling scrolls the page. Ctrl/Cmd + scroll zooms; browsers also
  // report trackpad pinches this way (with ctrlKey set).
  if (!(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * WHEEL_SPEED));
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  let lastX = event.clientX, lastY = event.clientY;
  stage.setPointerCapture(event.pointerId);
  stage.classList.add("dragging");
  const move = (e) => {
    panX += e.clientX - lastX;
    panY += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    layoutSky();
  };
  const up = () => {
    stage.classList.remove("dragging");
    stage.removeEventListener("pointermove", move);
    stage.removeEventListener("pointerup", up);
    stage.removeEventListener("pointercancel", up);
  };
  stage.addEventListener("pointermove", move);
  stage.addEventListener("pointerup", up);
  stage.addEventListener("pointercancel", up);
}

export const ZOOM_BUTTON_STEP = BUTTON_STEP;

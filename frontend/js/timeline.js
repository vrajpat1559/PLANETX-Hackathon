// The timeline under the picture: a filmstrip with one small thumbnail per
// image, oldest first. Click a thumbnail to show that image.
//
// Thumbnails are drawn from the brightness values already downloaded for the
// main picture, so they cost no extra requests. Each is drawn once and kept on
// its frame (frame.thumb).

import { noiseLevel, paintImage } from "./picture.js";

const THUMB_WHITE_LEVEL = 60; // a little brighter than the default, so small pictures read well

const strip = document.getElementById("timeline");

// Rebuild the strip. `onPick(index)` is called when a thumbnail is clicked.
export function drawTimeline(frames, currentIndex, onPick) {
  strip.replaceChildren();
  frames.forEach((frame, index) => {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = `film ${frame.telescope} ${frame.status === "ready" ? "" : frame.status}`;
    cell.title = [frame.label, frame.band, frame.detail].filter(Boolean).join(" · ");
    cell.setAttribute("aria-label", `Show ${frame.label}`);
    cell.disabled = frame.status !== "ready";
    cell.addEventListener("click", () => onPick(index));

    const picture = document.createElement("span");
    picture.className = "film-picture";
    if (frame.status === "ready") picture.append(thumbnail(frame));
    const caption = document.createElement("span");
    caption.className = "film-label";
    caption.textContent = frame.label.replace(/^WISE /, "");
    cell.append(picture, caption);
    strip.append(cell);
  });
  markCurrent(frames, currentIndex);
}

// Highlight the thumbnail of the image on screen, and keep it in view.
export function markCurrent(frames, currentIndex) {
  [...strip.children].forEach((cell, index) => {
    const active = index === currentIndex;
    cell.classList.toggle("active", active);
    if (active) cell.setAttribute("aria-current", "true");
    else cell.removeAttribute("aria-current");
  });
  const active = strip.children[currentIndex];
  if (active && strip.scrollWidth > strip.clientWidth) {
    active.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function thumbnail(frame) {
  if (!frame.thumb) {
    const canvas = document.createElement("canvas");
    paintImage(canvas.getContext("2d"), frame.pixels, frame.size, noiseLevel(frame.pixels), THUMB_WHITE_LEVEL);
    frame.thumb = canvas;
  }
  return frame.thumb;
}

// The timeline under the picture: one dot per image, placed by date.

const MIN_GAP_PERCENT = 3.2; // dots closer than this are nudged apart so each can be clicked

const track = document.getElementById("timeline");
const label = document.getElementById("timeline-label");

let positions = []; // where each dot sits along the line, 0-100

// Rebuild every dot. `onPick(index)` is called when a dot is clicked.
export function drawTimeline(frames, currentIndex, onPick) {
  positions = placeByDate(frames);
  track.replaceChildren();
  frames.forEach((frame, index) => {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = `dot ${frame.telescope} ${frame.status === "ready" ? "" : frame.status}`;
    dot.style.left = `${positions[index]}%`;
    dot.title = [frame.label, frame.detail].filter(Boolean).join(" · ");
    dot.disabled = frame.status !== "ready";
    dot.addEventListener("click", () => onPick(index));
    track.append(dot);
  });
  document.getElementById("timeline-start").textContent = frames[0]?.label ?? "";
  document.getElementById("timeline-end").textContent = frames.length > 1 ? frames.at(-1).label : "";
  markCurrent(frames, currentIndex);
}

// Enlarge the dot of the image on screen and write its name above it.
export function markCurrent(frames, currentIndex) {
  [...track.children].forEach((dot, index) => dot.classList.toggle("active", index === currentIndex));
  const frame = frames[currentIndex];
  label.replaceChildren();
  if (!frame || frame.status !== "ready") return;
  const text = document.createElement("span");
  text.textContent = frame.label;
  text.style.left = `${Math.max(8, Math.min(92, positions[currentIndex]))}%`; // keep it on the line
  label.append(text);
}

// Spread frames from 0 to 100 by date, then push apart any that would overlap.
function placeByDate(frames) {
  if (frames.length < 2) return frames.map(() => 50);
  const first = frames[0].mjd;
  const span = frames.at(-1).mjd - first || 1;
  const placed = [];
  for (const frame of frames) {
    const byDate = ((frame.mjd - first) / span) * 100;
    const afterPrevious = placed.length ? placed.at(-1) + MIN_GAP_PERCENT : 0;
    placed.push(Math.max(byDate, afterPrevious));
  }
  const overflow = placed.at(-1) / 100; // nudging may have pushed past the end
  return placed.map((position) => position / Math.max(1, overflow));
}

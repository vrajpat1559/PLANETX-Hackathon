// The decorative star background. Purely for looks: these are not real stars.

const STARS_PER_MEGAPIXEL = 420;
const TINTS = ["255, 255, 255", "255, 255, 255", "190, 215, 255", "255, 214, 190"]; // mostly white

// A small repeatable random-number generator, so the sky looks the same on every visit.
function randomSource(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

export function drawStarfield(canvas) {
  const sharpness = window.devicePixelRatio || 1;
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = width * sharpness;
  canvas.height = height * sharpness;

  const context = canvas.getContext("2d");
  context.scale(sharpness, sharpness);
  context.clearRect(0, 0, width, height);

  const random = randomSource(2025);
  const count = Math.round((width * height) / 1e6 * STARS_PER_MEGAPIXEL);
  for (let i = 0; i < count; i++) {
    const x = random() * width;
    const y = random() * height;
    // Cubing the random number makes faint stars common and bright ones rare, like the real sky.
    const brightness = random() ** 3;
    const radius = 0.4 + brightness * 1.3;
    const tint = TINTS[Math.floor(random() * TINTS.length)];

    context.fillStyle = `rgba(${tint}, ${0.25 + brightness * 0.75})`;
    context.beginPath();
    context.arc(x, y, radius, 0, 2 * Math.PI);
    context.fill();

    if (brightness > 0.55) { // a soft glow around the few brightest
      const glow = context.createRadialGradient(x, y, 0, x, y, radius * 6);
      glow.addColorStop(0, `rgba(${tint}, 0.28)`);
      glow.addColorStop(1, `rgba(${tint}, 0)`);
      context.fillStyle = glow;
      context.beginPath();
      context.arc(x, y, radius * 6, 0, 2 * Math.PI);
      context.fill();
    }
  }
}

// Every call to our backend lives here.

async function request(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    let reason = response.statusText;
    try { reason = (await response.json()).detail || reason; } catch {}
    throw new Error(reason);
  }
  return response;
}

async function getJSON(url) {
  return (await request(url)).json();
}

// Every image request shares one "cancel" switch. cancelImages() flips it, so
// requests for a view the visitor has left are dropped, and the server stops
// building those images instead of finishing them for nobody.
let images = new AbortController();

// Images arrive as raw 32-bit brightness values, top row first.
// Returns { size, pixels, wavelength, exposuresUsed }.
async function getImage(url) {
  const response = await request(url, images.signal);
  const pixels = new Float32Array(await response.arrayBuffer());
  return {
    size: Number(response.headers.get("X-Image-Size")),
    pixels,
    wavelength: Number(response.headers.get("X-Wavelength-Um")) || null,
    exposuresUsed: Number(response.headers.get("X-Exposures-Used")) || null,
  };
}

function query(parameters) {
  return new URLSearchParams(parameters).toString();
}

export const api = {
  // Drop every image request still waiting (a new target, band or setting).
  cancelImages: () => {
    images.abort();
    images = new AbortController();
  },

  config: () => getJSON("/api/config"),

  // How current NASA's SPHEREx archive is -> { newest_week, uploaded, ... }
  latest: () => getJSON("/api/latest"),

  // What the user typed -> { ra, dec, label, note }
  resolve: (text) => getJSON(`/api/resolve?${query({ q: text })}`),

  // -> { visits: [...], exposures: [...] }
  observations: (ra, dec) => getJSON(`/api/observations?${query({ ra, dec })}`),

  // All exposures of one visit in one detector, combined.
  stack: (ra, dec, fov, detector, visit) =>
    getImage(`/api/stack?${query({ ra, dec, fov, detector, visit })}`),

  // The older WISE telescope: its visits (2010-2024), and one visit as an image.
  wiseVisits: (ra, dec) => getJSON(`/api/wise/visits?${query({ ra, dec })}`),
  wiseStack: (ra, dec, fov, band, visit) =>
    getImage(`/api/wise/stack?${query({ ra, dec, fov, band, visit })}`),

  // One single exposure.
  exposure: (ra, dec, fov, url) =>
    getImage(`/api/exposure?${query({ ra, dec, fov, url })}`),
};

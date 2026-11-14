// Every call to our backend lives here.

async function request(url) {
  const response = await fetch(url);
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

// Images arrive as raw 32-bit brightness values, top row first.
// Returns { size, pixels, wavelength, exposuresUsed }.
async function getImage(url) {
  const response = await request(url);
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
  config: () => getJSON("/api/config"),

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

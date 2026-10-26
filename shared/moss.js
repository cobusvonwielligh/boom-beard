// Deterministic moss field shared by rendering and movement.

const smooth = t => t * t * (3 - 2 * t);

function hash01(n) {
  let x = (Math.imul(n, 374761393) ^ 0x5bf03635) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967295;
}

function noiseAt(x, y, freq, seed) {
  const fx = x / freq, fy = y / freq;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = smooth(fx - x0), ty = smooth(fy - y0);
  const at = (i, j) => hash01((Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ seed) | 0);
  const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/** Moss density at fractional tile coordinates, 0..1. */
export function mossValue(x, y) {
  const patch = noiseAt(x, y, 6, 0x6d055);
  const edge = noiseAt(x, y, 1.3, 0x9e3779);
  const v = patch * 0.76 + edge * 0.24;
  if (v <= 0.54) return 0;
  const strength = Math.min(1, (v - 0.54) / 0.3);
  const grain = noiseAt(x, y, 0.34, 0x5eed9);
  const holes = noiseAt(x, y, 0.22, 0x71a55);
  if (holes < 0.24) return 0;
  return Math.max(0, strength - (1 - strength) * 0.8 - (0.5 - grain) * 0.55);
}

/** Whether the centre of a tile belongs to the visible moss field. */
export const mossyTile = (tx, ty) => mossValue(tx + 0.5, ty + 0.5) > 0.18;

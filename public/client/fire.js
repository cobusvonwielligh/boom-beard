const rainbowFireCache = new Map();

export function rainbowFireTones(t) {
  const frame = ((Math.floor(t * 24) % 36) + 36) % 36;
  const hit = rainbowFireCache.get(frame);
  if (hit) return hit;
  const hue = frame * 10;
  const tones = {
    edge: `hsl(${hue} 100% 48%)`,
    mid: `hsl(${(hue + 40) % 360} 100% 62%)`,
    core: `hsl(${(hue + 80) % 360} 100% 84%)`,
    cool: `hsl(${(hue + 120) % 360} 95% 45%)`,
    hue,
    sat: 100,
  };
  rainbowFireCache.set(frame, tones);
  return tones;
}

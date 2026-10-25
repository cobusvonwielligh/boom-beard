import { FUSE_TICKS, UNITS_PER_TILE, playerColor, playerHsl } from '../../shared/constants.js';

const RADAR_BOMB_RADIUS_TILES = 10;
const RADAR_BOMB_LIMIT = 5;
const RADAR_PULSE_MIN_HZ = 1.8;
const RADAR_PULSE_MAX_HZ = 9.8;
const RADAR_BOMB_MIN_SIZE = 9;
const RADAR_BOMB_MAX_SIZE = 17;
const RADAR_BOMB_RED = [255, 51, 77];
const RADAR_BOMB_WHITE = [255, 255, 255];

export function selectRadarBombs(bombs, me) {
  if (!me) return [];
  const radius = RADAR_BOMB_RADIUS_TILES * UNITS_PER_TILE;
  return bombs
    .map(b => ({
      bomb: b,
      distance: Math.hypot(
        (b.tx + 0.5) * UNITS_PER_TILE - me.rx,
        (b.ty + 0.5) * UNITS_PER_TILE - me.ry,
      ),
    }))
    .filter(({ distance }) => distance <= radius)
    .sort((a, b) => a.distance - b.distance || a.bomb.id - b.bomb.id)
    .slice(0, RADAR_BOMB_LIMIT);
}

export function radarBombPulseHz(bomb, tick) {
  const remaining = radarBombFuseFraction(bomb, tick);
  return RADAR_PULSE_MIN_HZ + (RADAR_PULSE_MAX_HZ - RADAR_PULSE_MIN_HZ) * (1 - remaining);
}

export function radarBombFuseFraction(bomb, tick) {
  return Math.max(0, Math.min(1, (bomb.at - tick) / (bomb.fuseTicks || FUSE_TICKS)));
}

export function radarBombSizePx(remaining) {
  const progress = 1 - Math.max(0, Math.min(1, remaining));
  return RADAR_BOMB_MIN_SIZE + (RADAR_BOMB_MAX_SIZE - RADAR_BOMB_MIN_SIZE) * progress;
}

export function radarBombColor(remaining, owner) {
  const elapsed = 1 - Math.max(0, Math.min(1, remaining));
  if (elapsed === 0) return playerColor(owner);
  if (elapsed >= 0.9) return 'rgb(255 255 255)';
  const startHsl = playerHsl(owner);
  const start = hslToRgb(startHsl.h, startHsl.s, startHsl.l);
  const from = elapsed <= 0.8 ? start : RADAR_BOMB_RED;
  const to = elapsed <= 0.8 ? RADAR_BOMB_RED : RADAR_BOMB_WHITE;
  const amount = elapsed <= 0.8 ? elapsed / 0.8 : (elapsed - 0.8) / 0.1;
  const rgb = from.map((channel, i) => Math.round(channel + (to[i] - channel) * amount));
  return `rgb(${rgb.join(' ')})`;
}

export function radarBombPulseAlpha(phase) {
  return 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(phase));
}

function hslToRgb(h, s, l) {
  const hue = h / 60;
  const saturation = s / 100;
  const lightness = l / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const sector = Math.floor(hue);
  const base = sector === 0 ? [chroma, x, 0]
    : sector === 1 ? [x, chroma, 0]
      : sector === 2 ? [0, chroma, x]
        : sector === 3 ? [0, x, chroma]
          : sector === 4 ? [x, 0, chroma]
            : [chroma, 0, x];
  const match = lightness - chroma / 2;
  return base.map(channel => Math.round((channel + match) * 255));
}

import { FUSE_TICKS, UNITS_PER_TILE } from '../../shared/constants.js';

const RADAR_BOMB_RADIUS_TILES = 6;
const RADAR_BOMB_LIMIT = 3;
const RADAR_PULSE_MIN_HZ = 1.8;
const RADAR_PULSE_MAX_HZ = 9.8;

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
  const remaining = Math.max(0, Math.min(1, (bomb.at - tick) / FUSE_TICKS));
  return RADAR_PULSE_MIN_HZ + (RADAR_PULSE_MAX_HZ - RADAR_PULSE_MIN_HZ) * (1 - remaining);
}

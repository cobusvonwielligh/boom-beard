import {
  MAX_BOMBS_CARRIED, MAX_RADIUS, MAX_SHIELDS, MAX_SKATES, MAX_STAMINA_LEVELS,
  PERK, START_BOMBS, START_RADIUS,
} from './constants.js';

export const SHOP_ITEMS = Object.freeze({
  bombs: Object.freeze({
    perk: PERK.BOMB, cost: 1, bundle: 2, cap: MAX_BOMBS_CARRIED - START_BOMBS,
  }),
  fire: Object.freeze({ perk: PERK.FIRE, cost: 1, bundle: 1, cap: MAX_RADIUS - START_RADIUS }),
  speed: Object.freeze({ perk: PERK.SKATE, cost: 1, bundle: 2, cap: MAX_SKATES }),
  shield: Object.freeze({ perk: PERK.SHIELD, cost: 2, bundle: 1, cap: MAX_SHIELDS }),
  stim: Object.freeze({ perk: PERK.STAMINA, cost: 1, bundle: 2, cap: MAX_STAMINA_LEVELS }),
});

export const emptyShopQueue = () => ({ bombs: 0, fire: 0, speed: 0, shield: 0, stim: 0 });

export function normaliseShopQueue(value) {
  const out = emptyShopQueue();
  if (!value || typeof value !== 'object') return out;
  for (const [key, item] of Object.entries(SHOP_ITEMS)) {
    const n = value[key];
    if (Number.isInteger(n) && n > 0) out[key] = Math.min(n, item.cap);
  }
  return out;
}

export function addShopBundle(queue, key) {
  if (!Object.hasOwn(SHOP_ITEMS, key)) return null;
  const item = SHOP_ITEMS[key];
  const next = normaliseShopQueue(queue);
  if (next[key] + item.bundle > item.cap) return null;
  next[key] += item.bundle;
  return next;
}

export const hasQueuedShopItems = queue =>
  Object.values(normaliseShopQueue(queue)).some(Boolean);

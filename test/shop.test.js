import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BOMBS_CARRIED, MAX_RADIUS, MAX_SHIELDS, MAX_SKATES, MAX_STAMINA_LEVELS,
  PERK, START_BOMBS, START_RADIUS,
} from '../shared/constants.js';
import {
  SHOP_ITEMS, addShopBundle, emptyShopQueue, normaliseShopQueue,
} from '../shared/shop.js';

test('shop catalog matches the existing perk caps', () => {
  assert.deepEqual(Object.keys(SHOP_ITEMS), ['bombs', 'fire', 'speed', 'shield', 'stim']);
  assert.deepEqual(SHOP_ITEMS.bombs, {
    perk: PERK.BOMB, cost: 1, bundle: 2, cap: MAX_BOMBS_CARRIED - START_BOMBS,
  });
  assert.deepEqual(SHOP_ITEMS.fire,
    { perk: PERK.FIRE, cost: 1, bundle: 1, cap: MAX_RADIUS - START_RADIUS });
  assert.deepEqual(SHOP_ITEMS.speed,
    { perk: PERK.SKATE, cost: 1, bundle: 1, cap: 3 });
  assert.equal(MAX_SKATES, 3);
  assert.deepEqual(SHOP_ITEMS.shield,
    { perk: PERK.SHIELD, cost: 2, bundle: 1, cap: MAX_SHIELDS });
  assert.deepEqual(SHOP_ITEMS.stim,
    { perk: PERK.STAMINA, cost: 1, bundle: 2, cap: MAX_STAMINA_LEVELS });
});

test('shop queue normalization returns a fresh, capped, integer-only queue', () => {
  const source = {
    bombs: 9, fire: 4, speed: 9, shield: 2, stim: 3, extra: 99,
    negative: -1,
  };
  const queue = normaliseShopQueue(source);

  assert.deepEqual(queue, { bombs: 4, fire: 4, speed: 3, shield: 2, stim: 3 });
  assert.notEqual(queue, source);
  assert.deepEqual(source, {
    bombs: 9, fire: 4, speed: 9, shield: 2, stim: 3, extra: 99, negative: -1,
  });
  assert.deepEqual(normaliseShopQueue({
    bombs: -1, fire: '2', speed: -1, shield: 1.5, stim: NaN,
  }), emptyShopQueue());
  assert.deepEqual(normaliseShopQueue(null), emptyShopQueue());
  assert.deepEqual(normaliseShopQueue('bad input'), emptyShopQueue());
});

test('shop bundle additions reject unknown keys and never partially exceed a cap', () => {
  assert.equal(addShopBundle(emptyShopQueue(), 'unknown'), null);
  assert.equal(addShopBundle(emptyShopQueue(), 'toString'), null);
  assert.equal(addShopBundle(emptyShopQueue(), '__proto__'), null);

  const full = { bombs: 0, fire: 0, speed: MAX_SKATES, shield: 0, stim: 0 };
  assert.equal(addShopBundle(full, 'speed'), null);
  assert.deepEqual(full, { bombs: 0, fire: 0, speed: MAX_SKATES, shield: 0, stim: 0 });

  assert.deepEqual(addShopBundle(emptyShopQueue(), 'stim'),
    { bombs: 0, fire: 0, speed: 0, shield: 0, stim: 2 });
  assert.deepEqual(addShopBundle(emptyShopQueue(), 'bombs'),
    { bombs: 2, fire: 0, speed: 0, shield: 0, stim: 0 });
  assert.deepEqual(addShopBundle(emptyShopQueue(), 'speed'),
    { bombs: 0, fire: 0, speed: 1, shield: 0, stim: 0 });
  assert.deepEqual(addShopBundle({ speed: 2 }, 'speed'),
    { bombs: 0, fire: 0, speed: 3, shield: 0, stim: 0 });
  assert.equal(addShopBundle({ speed: 3 }, 'speed'), null);
  assert.deepEqual(addShopBundle({ bombs: 2 }, 'bombs'),
    { bombs: 4, fire: 0, speed: 0, shield: 0, stim: 0 });
  assert.equal(addShopBundle({ bombs: 4 }, 'bombs'), null);
});

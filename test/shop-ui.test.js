import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(path.join(ROOT, file), 'utf8');
const has = (source, pattern, message) => assert.ok(pattern.test(source), message);

test('death and intermission shop reuse the approved game assets and palette', async () => {
  const [html, css] = await Promise.all([
    read('public/index.html'), read('public/style.css'),
  ]);
  const shop = html.slice(html.indexOf('<section id="shop"'), html.indexOf('</section>', html.indexOf('<section id="shop"')));

  has(shop, /<h2 id="shopTitle" class="castSm"[^>]*>SHOP<\/h2>/, 'shop title uses cast-gold SHOP');
  assert.doesNotMatch(shop, /QUEUED LOADOUT|shopQueued|data-shop-queued=/,
    'queued counts and their heading are not shown');
  const items = [...shop.matchAll(/data-shop-item="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(items, ['bombs', 'fire', 'speed', 'shield', 'stim'],
    'items follow the top-bar perk order');
  for (const [item, icon, bundle, cost] of [
    ['bombs', '#i-bomb', '+2', 1],
    ['fire', '#i-fire', '+1', 1],
    ['speed', '#i-boot', '+2', 1],
    ['shield', '#i-shield', '+1', 2],
    ['stim', '#i-bolt', '+2', 1],
  ]) {
    has(shop, new RegExp(`data-shop-item="${item}"`), `${item} has a shop button`);
    const itemMarkup = shop.slice(shop.indexOf(`data-shop-item="${item}"`),
      shop.indexOf('</button>', shop.indexOf(`data-shop-item="${item}"`)));
    has(itemMarkup, new RegExp(`<use href="${icon}"`), `${item} uses the existing icon`);
    assert.ok(shop.includes(`<span class="shopBundle">${bundle}</span>`),
      `${item} has the correct bundle size`);
    has(itemMarkup, /class="shopIcon"/, `${item} icon has a glow wrapper`);
    has(itemMarkup, new RegExp(`<span class="shopPrice"><svg[^>]*><use href="#i-coin"\\s*\\/><\\/svg>\\s*${cost}</span>`),
      `${item} displays its gold cost`);
  }
  for (const [item, id, colour] of [
    ['bombs', 'pBombs', '#7e93d6'],
    ['fire', 'pFire', '#ff9b4a'],
    ['speed', 'pSpeed', '#5fd8f0'],
    ['shield', 'pShield', '#5ad1a0'],
    ['stim', 'pStim', '#ffe04a'],
  ]) {
    has(css, new RegExp(`\\.shopItem\\.${item},\\s*#${id}\\s*\\{[^}]*--shop-rim:\\s*${colour};`),
      `${item} HUD stat shares its shop button accent`);
  }
  for (const [item, id, icon] of [
    ['bombs', 'pBombs', '#i-bomb'],
    ['fire', 'pFire', '#i-fire'],
    ['speed', 'pSpeed', '#i-boot'],
    ['shield', 'pShield', '#i-shield'],
    ['stim', 'pStim', '#i-bolt'],
  ]) {
    has(html, new RegExp(`<span[^>]*id="${id}"[^>]*>\\s*<svg><use href="${icon}"`),
      `${item} HUD uses the same SVG as its shop item`);
  }
  has(css, /\.pip\s*\{[^}]*color:\s*var\(--shop-rim,\s*var\(--gold\)\)/s,
    'HUD power-up icons use their matching shop accent');
  has(css, /\.pip \.n\s*\{[^}]*color:\s*var\(--shop-rim,\s*var\(--gold\)\)/s,
    'only the current stat number uses the shop accent');
  has(css, /\.pip \.cap\s*\{[^}]*color:\s*#9fabbd/s,
    'the stat cap stays muted');
  has(css, /\.pip\.on svg\s*\{[^}]*var\(--shop-glow\)/s,
    'upgraded stat icons glow with their matching shop accent');
  assert.doesNotMatch(css, /\.pip\.max \.n\s*\{[^}]*color:\s*var\(--gold\)/s,
    'a maxed stat number keeps its shop accent');
  assert.doesNotMatch(css, /\.pip:not\(\.on\):not\(\.heart\)\s*\{[^}]*opacity:\s*0\.5/s,
    'base power-up stats are not dimmed away from their shop accent');
  has(shop, /<svg id="shopCoin"[^>]*><use href="#i-coin"/,
    'wallet uses the existing coin icon');
  has(shop, /<use href="#i-coin"/, 'prices use the existing coin icon');
  has(shop, /powerups are activated on next spawn/,
    'the shop explains when upgrades take effect');
  has(css, /#shopTitle\s*\{[^}]*font-size:\s*20px/s, 'shop title is enlarged');
  has(css, /\.card\.small:not\(\.round\) #shop\s*\{[^}]*margin-bottom:\s*18px/s,
    'shop leaves a vertical gap before respawn');
  has(css, /\.shopItem\s*\{[^}]*box-shadow:[^;]*0 5px 14px/s,
    'shop buttons have a visible drop shadow');
  has(css, /\.shopItem\s*\{[^}]*border:\s*1px solid #000;/s,
    'shop buttons have a thin black outline');
  has(css, /\.shopIcon\s*>\s*svg\s+use,\s*\.pip:not\(\.heart\)\s+svg\s+use\s*\{[^}]*stroke:\s*#000;[^}]*stroke-width:\s*0\.7/s,
    'shop and HUD power-up icons have a thin black outline');
  has(css, /\.card\.small:has\(#shop:not\(\[hidden\]\)\)\s*\{[^}]*width:\s*min\(360px,\s*calc\(100vw - 24px\)\)/s,
    'the shop dialog widens to fit five full-width buttons and stays within the viewport');
  has(css, /\.shopWallet #shopCoin\.empty\s*\{[^}]*grayscale\(1\)/s,
    'an empty wallet coin is grayscale');
  has(css, /\.coinStat \.coin,\s*\.shopWallet #shopCoin\s*\{[^}]*width:\s*13px;[^}]*height:\s*13px;[^}]*color:\s*var\(--gold\);[^}]*filter:\s*drop-shadow\(0 1px 0 #0008\) drop-shadow\(0 0 5px #edc24e4d\)/s,
    'the shop wallet coin matches the player-stats coin size, color and glow');
  has(css, /\.card\.small:not\(\.round\) #shop\s*\{[^}]*margin-top:\s*-2px/s,
    'death-shop header has the same 18px top inset as the Leave button bottom inset');
  has(css, /\.shopIcon\s*\{[^}]*top:\s*-4px/s,
    'powerup icons sit closer to the top button border');
  has(css, /\.shopItem::after\s*\{[^}]*inset:\s*0;[^}]*animation:\s*shopButtonShine 24s linear var\(--shop-shine-delay\) infinite;/s,
    'the shine overlays the entire button on a slower loop');
  for (const [index, delay] of [[1, '0s'], [2, '3.2s'], [3, '6.4s'], [4, '9.6s'], [5, '12.8s']]) {
    has(css, new RegExp(`\\.shopItem:nth-child\\(${index}\\)\\s*\\{[^}]*--shop-shine-delay:\\s*${delay.replace('.', '\\.')}\\s*;`),
      `button ${index} starts its shine after the previous button`);
  }
  has(css, /1%\s*\{\s*opacity:\s*0\.3;\s*\}\s*13\.333%\s*\{\s*background-position:\s*-130% 0;\s*opacity:\s*0\.3;/,
    'the full-button shine is reduced to one-third intensity and takes 3.2 seconds');
  has(css, /13\.334%,\s*100%\s*\{\s*background-position:\s*-130% 0;\s*opacity:\s*0\s*;/,
    'each button gets one sweep per 24-second sequence and stays dark for the rest of the loop');
  has(css, /\.shopIcon\s*\{[^}]*animation:\s*shopIconGlow/s,
    'powerup icons have an animated glow');
  has(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.shopIcon\s*\{[^}]*animation:\s*none;[\s\S]*?\.shopItem::after\s*\{[^}]*animation:\s*none;/,
    'the icon glow and button shine honor reduced motion');
  for (const colour of [
    '#2b3550', '#3f4e74', '#7e93d6',
    '#5a2416', '#8c3a1f', '#ff9b4a',
    '#123f4e', '#1b6076', '#5fd8f0',
    '#15402f', '#1d6347', '#5ad1a0',
    '#4a4212', '#75671d', '#ffe04a',
  ]) {
    assert.ok(css.includes(colour), `missing approved shop/perk colour ${colour}`);
  }
});

test('shop controls use authoritative state and existing sounds without auto-respawn', async () => {
  const [html, css, main, sfx] = await Promise.all([
    read('public/index.html'), read('public/style.css'),
    read('public/client/main.js'), read('public/client/audio/sfx.js'),
  ]);
  assert.doesNotMatch(html, /autoRow|autoRespawn/, 'the auto-respawn control is removed');
  assert.doesNotMatch(main, /AUTO_KEY|autoRespawn|autoRow/,
    'auto-respawn preference and behavior are removed');
  assert.doesNotMatch(css, /#autoRow\b/, 'auto-respawn styles are removed');
  has(main, /t:\s*'shop'/, 'client requests private shop state');
  has(main, /t:\s*'shopbuy'/, 'client sends item purchases');
  has(main, /onShop:\s*handleShopMessage/, 'client consumes authoritative shop responses');
  has(main, /playAtUnits\('pickup'/, 'accepted purchases reuse pickup audio');
  has(main, /play\('warn'\)/, 'rejections reuse warning audio');
  has(main, /shopCoin'\)\.classList\.toggle\('empty',\s*wallet === 0\)/,
    'the wallet coin changes state at zero gold');
  has(main, /queued \+ item\.bundle > item\.cap/,
    'queue caps remain enforced after hiding queue counts');
  has(main, /function renderGearStats\(me\)[\s\S]*shopVisible \? shopSnapshot\?\.pending/s,
    'the stat bar previews server-confirmed queued upgrades');
  const shopHandler = main.slice(main.indexOf('function handleShopMessage'), main.indexOf('const net'));
  has(shopHandler, /renderGearStats\(world\.me\(\)\)/,
    'a shop response immediately refreshes the stat-bar preview');
  has(sfx, /pickup\(c,\s*out,\s*t,\s*level,\s*\{\s*perk\s*\}\s*=\s*\{\}\)/,
    'pickup voice accepts the perk identity');
  assert.doesNotMatch(sfx, /\bshop\s*:/, 'the shop adds no new sound voice');
});

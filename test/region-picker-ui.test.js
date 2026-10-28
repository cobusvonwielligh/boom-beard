import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegionPicker } from '../public/client/region-picker.js';
import { REGIONS } from '../shared/regions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(path.join(ROOT, file), 'utf8');

class Element {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.disabled = false;
    this.hidden = false;
    this._text = '';
    this.className = '';
    this.style = {};
    this.open = false;
    this.showCount = 0;
    this.ownerDocument = documentStub;
  }

  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  click() { return this.listeners.click?.(); }
  showModal() { this.open = true; this.showCount++; }
  close() { this.open = false; }
}

class FastPongSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    FastPongSocket.instances.push(this);
    setImmediate(() => {
      this.readyState = 1;
      this.listeners.open?.();
    });
  }

  addEventListener(name, callback) { this.listeners[name] = callback; }
  send(body) {
    const { c } = JSON.parse(body);
    setImmediate(() => this.listeners.message?.({
      data: JSON.stringify({ t: 'pong', c }),
    }));
  }
  close() { this.readyState = 3; }
}

const documentStub = {
  createElement: tag => new Element(tag),
  defaultView: { location: { origin: 'https://boombeard.co.za' } },
};

function elements() {
  return {
    root: new Element('div'),
    dialog: new Element('dialog'),
    confirmButton: new Element('button'),
    cancelButton: new Element('button'),
    refreshButton: new Element('button'),
    statusMessage: new Element('p'),
    progressTrack: Object.assign(new Element('div'), { hidden: true }),
    progressFill: new Element('div'),
  };
}

const regions = REGIONS;

const status = region => ({
  region,
  map: region === 'us' ? 'twins' : 'arena',
  humanPlayers: 3,
  bots: 2,
  maxPlayers: 16,
});

const successfulFetch = async url => ({
  ok: true,
  json: async () => status(url.includes('boombeard.co.za') ? 'za' : 'us'),
});

async function waitForProbes(refreshButton) {
  const deadline = Date.now() + 5000;
  while (refreshButton.disabled && Date.now() < deadline) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(refreshButton.disabled, false, 'region probes finish');
}

test('landing page places a labeled region dialog after the play controls', async () => {
  const html = await read('public/index.html');
  const dialogStart = html.indexOf('<dialog');
  const picker = html.indexOf('id="regionPicker"');
  assert.ok(dialogStart >= 0);
  assert.ok(picker > dialogStart, 'picker belongs inside the dialog');
  assert.match(html, /id="regionDialog"[^>]*aria-labelledby="regionDialogHeading"/);
  assert.match(html, /id="regionDialogHeading"[^>]*>\s*Choose your region\s*</);
  assert.match(html, /id="regionConfirm"/);
  assert.match(html, /id="regionCancel"/);
  assert.match(html, /id="regionProgress"[^>]*role="progressbar"/);
  assert.match(html, /id="regionProgressFill"/);
  assert.match(html, /id="regionRefresh"[^>]*aria-label="Refresh region status and ping"/);
  assert.ok(html.indexOf('id="regionConfirm"') < html.indexOf('id="regionCancel"'));
  assert.match(html, /id="regionStatus"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html, /geoPrivacyDisclosure/);
  assert.doesNotMatch(html, /Choose your waters|South Africa server ready/);
});

test('every connection attempt opens the dialog and saves only a confirmed choice', async () => {
  const {
    root, dialog, confirmButton, cancelButton, refreshButton, statusMessage,
    progressTrack, progressFill,
  } = elements();
  let saved = null;
  const picker = createRegionPicker({
    root, dialog, confirmButton, cancelButton, regions,
    refreshButton, statusMessage, progressTrack, progressFill,
    store: { get: () => saved, set: (_key, value) => { saved = value; } },
    fetchImpl: successfulFetch,
    WebSocketImpl: FastPongSocket,
    pingGapMs: 0,
    now: () => 0,
  });

  const firstChoice = picker.chooseRegion();
  await waitForProbes(refreshButton);
  assert.equal(dialog.open, true);
  assert.equal(progressTrack.hidden, true);
  assert.ok(['za', 'us'].includes(picker.selectedRegion()));
  assert.match(root.children.find(child => child.attributes['data-region'] === 'us').textContent,
    /MAP · Twins/);
  const buttons = root.children.filter(child => child.tagName === 'BUTTON');
  buttons[1].click();
  const confirming = confirmButton.click();
  assert.equal(progressTrack.hidden, false);
  assert.equal(progressTrack.attributes['aria-valuenow'], '16');
  assert.equal(progressTrack.attributes['aria-valuetext'], 'Checking United States…');
  assert.equal(statusMessage.textContent, 'Checking United States…');
  await confirming;
  assert.equal(await firstChoice, 'us');
  assert.equal(saved, 'us');
  assert.equal(dialog.open, true);
  assert.equal(picker.isHoldingForConnect(), true);
  assert.equal(progressTrack.hidden, false);
  assert.equal(progressTrack.attributes['aria-valuenow'], '55');
  assert.equal(statusMessage.textContent, 'Connecting to United States…');
  picker.setConnectionState('connecting');
  assert.equal(progressTrack.attributes['aria-valuenow'], '68');
  assert.equal(statusMessage.textContent, 'Opening the game connection…');
  picker.setConnectionState('open');
  assert.equal(progressTrack.attributes['aria-valuenow'], '86');
  assert.equal(statusMessage.textContent, 'Connection established. Loading the island…');
  picker.setConnectionState('welcome');
  assert.equal(progressTrack.attributes['aria-valuenow'], '100');
  assert.equal(statusMessage.textContent, 'Island ready. Entering now…');
  picker.setConnectionState('reconnecting in 0.5s');
  assert.equal(progressTrack.hidden, true);
  assert.equal(progressFill.style.width, '0%');
  assert.equal(statusMessage.textContent, 'Connection interrupted: reconnecting in 0.5s.');
  assert.equal(refreshButton.disabled, true);
  await picker.close();
  assert.equal(dialog.open, false);
  assert.equal(progressTrack.hidden, true);
  assert.equal(progressFill.style.width, '0%');
  assert.equal(statusMessage.textContent, '');

  const canceledChoice = picker.chooseRegion();
  await waitForProbes(refreshButton);
  assert.equal(dialog.open, true);
  assert.equal(dialog.showCount, 2);
  assert.equal(picker.selectedRegion(), 'us');
  await cancelButton.click();
  assert.equal(await canceledChoice, null);
  assert.equal(saved, 'us');
  picker.stop();
});

test('a failed final region check clears progress and keeps its reason visible', async () => {
  const {
    root, dialog, confirmButton, cancelButton, refreshButton, statusMessage,
    progressTrack, progressFill,
  } = elements();
  const requests = new Map();
  const picker = createRegionPicker({
    root, dialog, confirmButton, cancelButton, refreshButton, statusMessage,
    progressTrack, progressFill, regions,
    store: { get: () => 'za', set() {} },
    fetchImpl: async url => {
      const regionId = url.includes('boombeard.co.za') ? 'za' : 'us';
      const requestCount = (requests.get(regionId) ?? 0) + 1;
      requests.set(regionId, requestCount);
      if (regionId === 'za' && requestCount > 1) return { ok: false, status: 503 };
      return { ok: true, json: async () => status(regionId) };
    },
    WebSocketImpl: FastPongSocket,
    pingGapMs: 0,
    now: () => 0,
  });

  const choice = picker.chooseRegion();
  await waitForProbes(refreshButton);
  const confirming = confirmButton.click();
  assert.equal(progressTrack.hidden, false);
  await confirming;
  assert.equal(progressTrack.hidden, true);
  assert.equal(progressFill.style.width, '0%');
  assert.equal(statusMessage.textContent, 'South Africa: Region status unavailable (HTTP 503).');
  await cancelButton.click();
  assert.equal(await choice, null);
  picker.stop();
});

test('double-clicking an online region confirms the selection', async () => {
  const {
    root, dialog, confirmButton, cancelButton, refreshButton, statusMessage,
    progressTrack, progressFill,
  } = elements();
  const picker = createRegionPicker({
    root, dialog, confirmButton, cancelButton, refreshButton, statusMessage,
    progressTrack, progressFill, regions,
    store: { get: () => null, set() {} },
    fetchImpl: successfulFetch,
    WebSocketImpl: FastPongSocket,
    pingGapMs: 0,
    now: () => 0,
  });

  const choice = picker.chooseRegion();
  await waitForProbes(refreshButton);
  const unitedStates = root.children.find(button => button.attributes['data-region'] === 'us');
  assert.equal(unitedStates.disabled, false, 'region probes finish before the card is clicked');
  unitedStates.click();
  root.children.find(button => button.attributes['data-region'] === 'us').click();

  let timeout;
  const selected = await Promise.race([
    choice,
    new Promise(resolve => { timeout = setTimeout(() => resolve('not selected'), 5000); }),
  ]);
  clearTimeout(timeout);
  assert.equal(selected, 'us');
  assert.equal(dialog.open, true);
  assert.equal(picker.isHoldingForConnect(), true);
  await picker.close();
  picker.stop();
});

test('cards show local flags, latency, online capacity, and offline state without a footer', async () => {
  const {
    root, dialog, confirmButton, cancelButton, refreshButton, statusMessage,
    progressTrack, progressFill,
  } = elements();
  const picker = createRegionPicker({
    root, dialog, confirmButton, cancelButton, refreshButton, statusMessage, regions,
    progressTrack, progressFill,
    store: { get: () => null, set() {} },
    fetchImpl: async url => url.includes('boombeard.co.za')
      ? { ok: true, json: async () => status('za') }
      : { ok: false, status: 503 },
    WebSocketImpl: FastPongSocket,
    pingGapMs: 0,
    now: () => 0,
  });

  const choice = picker.chooseRegion();
  await waitForProbes(refreshButton);
  const buttons = root.children.filter(child => child.tagName === 'BUTTON');
  const southAfrica = buttons.find(button => button.attributes['data-region'] === 'za');
  const unitedStates = buttons.find(button => button.attributes['data-region'] === 'us');
  const flag = southAfrica.children.find(child => child.tagName === 'IMG');
  const details = southAfrica.children.find(child => child.className === 'regionDetails');
  const ping = details.children.find(child => child.className.includes('ping'));

  assert.equal(flag.attributes.src, '/assets/img/flag-south-africa-round-xs.png');
  assert.equal(flag.attributes.alt, 'South Africa flag');
  assert.match(southAfrica.textContent, /South Africa/);
  assert.match(southAfrica.textContent, /MAP · Arena/);
  assert.match(southAfrica.textContent, /5\/16 players/);
  assert.equal(southAfrica.attributes['aria-label'],
    'South Africa, Arena map, 0 milliseconds, 5 of 16 players online');
  assert.match(ping.className, /pingGood|pingFair|pingPoor/);
  assert.match(unitedStates.textContent, /OFFLINE/);
  assert.equal(unitedStates.disabled, true);
  assert.doesNotMatch(root.textContent, /server ready|waters/i);
  await cancelButton.click();
  assert.equal(await choice, null);
  picker.stop();
});

test('region metadata uses the supplied PNG flag assets', async () => {
  const southAfrica = await readFile(path.join(ROOT, 'public/assets/img/flag-south-africa-round-xs.png'));
  const unitedStates = await readFile(path.join(ROOT, 'public/assets/img/flag-united-states-icons-round-64px.png'));
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(REGIONS.find(region => region.id === 'za').flag,
    '/assets/img/flag-south-africa-round-xs.png');
  assert.equal(REGIONS.find(region => region.id === 'us').flag,
    '/assets/img/flag-united-states-icons-round-64px.png');
  assert.deepEqual(Buffer.from(southAfrica.slice(0, 8)), pngSignature);
  assert.deepEqual(Buffer.from(unitedStates.slice(0, 8)), pngSignature);
});

test('picker styles preserve focus and use the requested ping colors responsively', async () => {
  const css = await read('public/style.css');
  const index = await read('public/index.html');
  assert.match(css, /\.regionDialog::backdrop/);
  assert.match(css, /\.regionOption:focus-visible/);
  assert.match(css, /\.regionPing\.pingGood/);
  assert.match(css, /\.regionPing\.pingFair/);
  assert.match(css, /\.regionPing\.pingPoor/);
  assert.match(css, /\.regionPing\s*\{[^}]*animation:\s*regionPingUpdate/s);
  assert.match(css, /@keyframes\s+regionPingUpdate\s*\{[^}]*filter:\s*blur\(2px\)/s);
  assert.doesNotMatch(css.match(/@keyframes\s+regionPingUpdate\s*\{[^}]*\}/s)?.[0] || '',
    /translateY/);
  assert.match(css, /\.regionFlag\s*\{[^}]*width:\s*26px[^}]*height:\s*26px[^}]*object-fit:\s*contain/s);
  assert.match(css, /\.goldAction\s*\{[^}]*var\(--gold-lit\)[\s\S]*?var\(--gold-deep\)/s);
  assert.match(index, /id="play"[^>]*class="goldAction"/);
  assert.match(index, /id="regionConfirm"[^>]*class="goldAction"/);
  assert.match(css, /#regionCancel\s*\{[^}]*width:\s*auto[^}]*margin-top:\s*0/s);
  assert.match(css, /#regionRefresh/);
  assert.match(css, /\.sub-split\s*\{[^}]*linear-gradient\([^}]*#6d101e[^}]*#c4213a[^}]*var\(--gold\)/s);
  const sloganStyle = css.match(/\.sub-split\s*\{[^}]*\}/s)?.[0] || '';
  assert.match(sloganStyle, /-webkit-text-stroke:\s*1px\s+#f6e7a9/);
  assert.match(sloganStyle, /paint-order:\s*stroke fill/);
  assert.doesNotMatch(index, /\.sub-split::after/);
  const sloganLayout = index.slice(index.indexOf('.sub-split {'), index.indexOf('</style>'));
  assert.match(index, /class="sub sub-split"/);
  assert.match(index, /id="play"[^>]*>\s*LET'?S GO!\s*</i);
  assert.match(index, /transform:\s*translateY\(-24px\)/);
  assert.match(index, /width:\s*100%/);
  assert.match(sloganLayout, /display:\s*grid/);
  assert.match(sloganLayout, /grid-template-columns:\s*23%\s+46%\s+31%/);
  assert.match(sloganLayout, /\.sub-split span:first-child\s*\{[^}]*margin-left:\s*10px/);
  assert.match(sloganLayout, /\.sub-split span:first-child\s*\{[^}]*inset-inline-start:\s*-3px/);
  assert.match(sloganLayout, /\.sub-split span:nth-child\(2\)\s*\{[^}]*inset-inline-start:\s*-11px/);
  assert.match(sloganLayout, /\.sub-split span:last-child\s*\{[^}]*inset-inline-start:\s*-10px/);
  assert.doesNotMatch(sloganLayout, /translateX\(/);
  assert.match(css, /#regionPicker\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
  assert.match(css, /\.regionProgressTrack\s*\{[^}]*height:\s*6px/);
  assert.match(css, /\.regionProgressFill\s*\{[^}]*transition:\s*width/);
  assert.match(css, /linear-gradient\(90deg,\s*#2f8f5b,\s*#5ad18a/);
  const reducedMotion = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g)
    ?.find(block => block.includes('.regionProgressFill'));
  assert.match(reducedMotion ?? '', /\.regionProgressFill\s*\{\s*transition:\s*none;\s*\}/);
  assert.match(css, /@media\s*\(max-width:\s*600px\)[\s\S]*?\.regionDialog[\s\S]*?width:/);
});

test('menu footer keeps only the smaller report-a-bug link', async () => {
  const html = await read('public/index.html');
  const css = await read('public/style.css');
  const footer = html.slice(html.indexOf('<p class="menuFoot">'), html.indexOf('</p>', html.indexOf('<p class="menuFoot">')));

  assert.equal((footer.match(/<a\b/g) || []).length, 1);
  assert.match(footer, /class="bug"/);
  assert.match(footer, /report a bug/);
  assert.doesNotMatch(footer, />source</);
  assert.match(css, /\.menuFoot\s*\{[^}]*justify-content:\s*flex-end/s);
  assert.match(css, /\.menuFoot a\.bug\s*\{[^}]*font-size:\s*10px/s);
  assert.match(css, /\.menuFoot svg\s*\{[^}]*width:\s*15px[^}]*height:\s*15px/s);
});

test('refresh re-probes both regions without changing the saved selection', async () => {
  const {
    root, dialog, confirmButton, cancelButton, refreshButton, statusMessage,
    progressTrack, progressFill,
  } = elements();
  let requests = 0;
  const picker = createRegionPicker({
    root, dialog, confirmButton, cancelButton, refreshButton, statusMessage, regions,
    progressTrack, progressFill,
    store: { get: () => 'us', set() {} },
    fetchImpl: async url => {
      requests++;
      return {
        ok: true,
        json: async () => status(url.includes('boombeard.co.za') ? 'za' : 'us'),
      };
    },
    WebSocketImpl: FastPongSocket,
    pingGapMs: 0,
    now: () => 0,
  });

  const choice = picker.chooseRegion();
  await waitForProbes(refreshButton);
  assert.equal(requests, 2);
  assert.equal(picker.selectedRegion(), 'us');
  const socketsBefore = FastPongSocket.instances.length;

  const refreshing = refreshButton.click();
  assert.ok(root.children.filter(child => child.className === 'regionOption')
    .every(button => button.disabled));
  await refreshing;
  assert.equal(requests, 4);
  assert.equal(FastPongSocket.instances.length, socketsBefore + 2);
  assert.equal(picker.selectedRegion(), 'us');
  assert.equal(statusMessage.textContent, '');
  await cancelButton.click();
  assert.equal(await choice, null);
  picker.stop();
});

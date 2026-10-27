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
    this._text = '';
    this.className = '';
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
  };
}

const regions = REGIONS;

const status = region => ({
  region,
  humanPlayers: 3,
  bots: 2,
  maxPlayers: 16,
});

const successfulFetch = async url => ({
  ok: true,
  json: async () => status(url.includes('boombeard.co.za') ? 'za' : 'us'),
});

const flushProbes = () => new Promise(resolve => setTimeout(resolve, 10));

test('landing page places a labeled region dialog after the play controls', async () => {
  const html = await read('public/index.html');
  const dialogStart = html.indexOf('<dialog');
  const picker = html.indexOf('id="regionPicker"');
  assert.ok(dialogStart >= 0);
  assert.ok(picker > dialogStart, 'picker belongs inside the dialog');
  assert.match(html, /id="regionDialog"[^>]*aria-labelledby="regionDialogHeading"/);
  assert.match(html, /id="regionDialogHeading"[^>]*>Choose your region</);
  assert.match(html, /id="regionConfirm"/);
  assert.match(html, /id="regionCancel"/);
  assert.match(html, /id="regionRefresh"[^>]*aria-label="Refresh region status and ping"/);
  assert.ok(html.indexOf('id="regionConfirm"') < html.indexOf('id="regionCancel"'));
  assert.match(html, /id="regionStatus"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html, /geoPrivacyDisclosure/);
  assert.doesNotMatch(html, /Choose your waters|South Africa server ready/);
});

test('every connection attempt opens the dialog and saves only a confirmed choice', async () => {
  const { root, dialog, confirmButton, cancelButton, refreshButton, statusMessage } = elements();
  let saved = null;
  const picker = createRegionPicker({
    root, dialog, confirmButton, cancelButton, regions,
    refreshButton, statusMessage,
    store: { get: () => saved, set: (_key, value) => { saved = value; } },
    fetchImpl: successfulFetch,
    WebSocketImpl: FastPongSocket,
    pingGapMs: 0,
    now: () => 0,
  });

  const firstChoice = picker.chooseRegion();
  await flushProbes();
  assert.equal(dialog.open, true);
  assert.ok(['za', 'us'].includes(picker.selectedRegion()));
  const buttons = root.children.filter(child => child.tagName === 'BUTTON');
  buttons[1].click();
  await confirmButton.click();
  assert.equal(await firstChoice, 'us');
  assert.equal(saved, 'us');
  assert.equal(dialog.open, false);

  const canceledChoice = picker.chooseRegion();
  await flushProbes();
  assert.equal(dialog.open, true);
  assert.equal(dialog.showCount, 2);
  assert.equal(picker.selectedRegion(), 'us');
  await cancelButton.click();
  assert.equal(await canceledChoice, null);
  assert.equal(saved, 'us');
  picker.stop();
});

test('cards show local flags, latency, online capacity, and offline state without a footer', async () => {
  const { root, dialog, confirmButton, cancelButton, refreshButton, statusMessage } = elements();
  const picker = createRegionPicker({
    root, dialog, confirmButton, cancelButton, refreshButton, statusMessage, regions,
    store: { get: () => null, set() {} },
    fetchImpl: async url => url.includes('boombeard.co.za')
      ? { ok: true, json: async () => status('za') }
      : { ok: false, status: 503 },
    WebSocketImpl: FastPongSocket,
    pingGapMs: 0,
    now: () => 0,
  });

  const choice = picker.chooseRegion();
  await flushProbes();
  const buttons = root.children.filter(child => child.tagName === 'BUTTON');
  const southAfrica = buttons.find(button => button.attributes['data-region'] === 'za');
  const unitedStates = buttons.find(button => button.attributes['data-region'] === 'us');
  const flag = southAfrica.children.find(child => child.tagName === 'IMG');
  const details = southAfrica.children.find(child => child.className === 'regionDetails');
  const ping = details.children.find(child => child.className.includes('ping'));

  assert.equal(flag.attributes.src, '/assets/img/flag-south-africa-round-xs.png');
  assert.equal(flag.attributes.alt, 'South Africa flag');
  assert.match(southAfrica.textContent, /South Africa/);
  assert.match(southAfrica.textContent, /5\/16 players/);
  assert.equal(southAfrica.attributes['aria-label'],
    'South Africa, 0 milliseconds, 5 of 16 players online');
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
  assert.match(css, /@keyframes\s+regionPingUpdate/);
  assert.match(css, /\.regionFlag\s*\{[^}]*width:\s*26px[^}]*height:\s*26px[^}]*object-fit:\s*contain/s);
  assert.match(css, /#regionConfirm\s*\{[^}]*var\(--cast\)/s);
  assert.match(css, /#regionCancel\s*\{[^}]*width:\s*auto[^}]*margin-top:\s*0/s);
  assert.match(css, /#regionRefresh/);
  assert.match(css, /\.sub-split\s*\{[^}]*color:\s*#c4213a[^}]*font-size:\s*calc\(14\.5px\s*-\s*1pt\)[^}]*text-shadow:/s);
  assert.match(index, /class="sub sub-split"/);
  assert.match(css, /#regionPicker\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
  assert.match(css, /@media\s*\(max-width:\s*600px\)[\s\S]*?\.regionDialog[\s\S]*?width:/);
});

test('refresh re-probes both regions without changing the saved selection', async () => {
  const { root, dialog, confirmButton, cancelButton, refreshButton, statusMessage } = elements();
  let requests = 0;
  const picker = createRegionPicker({
    root, dialog, confirmButton, cancelButton, refreshButton, statusMessage, regions,
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
  await flushProbes();
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

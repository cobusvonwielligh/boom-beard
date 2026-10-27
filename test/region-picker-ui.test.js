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
  assert.doesNotMatch(html, /geoPrivacyDisclosure/);
  assert.doesNotMatch(html, /Choose your waters|South Africa server ready/);
});

test('every connection attempt opens the dialog and saves only a confirmed choice', async () => {
  const { root, dialog, confirmButton, cancelButton } = elements();
  let saved = null;
  const picker = createRegionPicker({
    root, dialog, confirmButton, cancelButton, regions,
    store: { get: () => saved, set: (_key, value) => { saved = value; } },
    fetchImpl: successfulFetch,
  });

  const firstChoice = picker.chooseRegion();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dialog.open, true);
  assert.ok(['za', 'us'].includes(picker.selectedRegion()));
  const buttons = root.children.filter(child => child.tagName === 'BUTTON');
  buttons[1].click();
  await confirmButton.click();
  assert.equal(await firstChoice, 'us');
  assert.equal(saved, 'us');
  assert.equal(dialog.open, false);

  const canceledChoice = picker.chooseRegion();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dialog.open, true);
  assert.equal(dialog.showCount, 2);
  assert.equal(picker.selectedRegion(), 'us');
  await cancelButton.click();
  assert.equal(await canceledChoice, null);
  assert.equal(saved, 'us');
  picker.stop();
});

test('cards show local flags, latency, online capacity, and offline state without a footer', async () => {
  const { root, dialog, confirmButton, cancelButton } = elements();
  const picker = createRegionPicker({
    root, dialog, confirmButton, cancelButton, regions,
    store: { get: () => null, set() {} },
    fetchImpl: async url => url.includes('boombeard.co.za')
      ? { ok: true, json: async () => status('za') }
      : { ok: false, status: 503 },
  });

  const choice = picker.chooseRegion();
  await new Promise(resolve => setImmediate(resolve));
  const buttons = root.children.filter(child => child.tagName === 'BUTTON');
  const southAfrica = buttons.find(button => button.attributes['data-region'] === 'za');
  const unitedStates = buttons.find(button => button.attributes['data-region'] === 'us');
  const flag = southAfrica.children.find(child => child.tagName === 'IMG');
  const details = southAfrica.children.find(child => child.className === 'regionDetails');
  const ping = details.children.find(child => child.className.includes('ping'));

  assert.equal(flag.attributes.src, '/assets/img/flags/za.svg');
  assert.equal(flag.attributes.alt, 'South Africa flag');
  assert.match(southAfrica.textContent, /South Africa/);
  assert.match(southAfrica.textContent, /3\/16 players/);
  assert.doesNotMatch(southAfrica.textContent, /2 bots/);
  assert.match(ping.className, /pingGood|pingFair|pingPoor/);
  assert.match(unitedStates.textContent, /OFFLINE/);
  assert.equal(unitedStates.disabled, true);
  assert.doesNotMatch(root.textContent, /server ready|waters/i);
  await cancelButton.click();
  assert.equal(await choice, null);
  picker.stop();
});

test('flag assets are self-hosted SVGs with country-specific artwork', async () => {
  const southAfrica = await read('public/assets/img/flags/za.svg');
  const unitedStates = await read('public/assets/img/flags/us.svg');
  assert.match(southAfrica, /<svg[^>]+viewBox="0 0 30 20"/);
  assert.match(southAfrica, /#007a4d/i);
  assert.match(unitedStates, /<svg[^>]+viewBox="0 0 30 20"/);
  assert.match(unitedStates, /#b22234/i);
});

test('picker styles preserve focus and use the requested ping colors responsively', async () => {
  const css = await read('public/style.css');
  assert.match(css, /\.regionDialog::backdrop/);
  assert.match(css, /\.regionOption:focus-visible/);
  assert.match(css, /\.regionPing\.pingGood/);
  assert.match(css, /\.regionPing\.pingFair/);
  assert.match(css, /\.regionPing\.pingPoor/);
  assert.match(css, /#regionPicker\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
  assert.match(css, /@media\s*\(max-width:\s*600px\)[\s\S]*?\.regionDialog[\s\S]*?width:/);
});

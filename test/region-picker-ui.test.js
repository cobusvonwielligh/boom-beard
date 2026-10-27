import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegionPicker } from '../public/client/region-picker.js';

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
  click() { this.listeners.click?.(); }
}

const documentStub = { createElement: tag => new Element(tag) };

function makeRoot() {
  const root = new Element('div');
  root.attributes.id = 'regionPicker';
  return root;
}

const regions = [
  { id: 'za', name: 'South Africa', flag: '🇿🇦', origin: 'https://za.example' },
  { id: 'us', name: 'North America', flag: '🇺🇸', origin: 'https://us.example' },
];

const status = region => ({
  region,
  humanPlayers: 3,
  bots: 2,
  maxPlayers: 16,
});

test('landing page exposes an accessible labeled region-picker group', async () => {
  const html = await read('public/index.html');
  assert.match(html, /id="regionPicker"[^>]*role="group"/);
  assert.match(html, /id="regionPicker"[^>]*aria-label="[^"]+"/);
});

test('picker renders two named buttons with counts, selected state, and offline disablement', async t => {
  const root = makeRoot();
  const picker = createRegionPicker({
    root,
    regions,
    store: { get: () => 'za', set() {} },
    fetchImpl: async url => ({
      ok: true,
      json: async () => status(url.includes('za.example') ? 'za' : 'us'),
    }),
  });
  t.after(() => picker.stop());
  await picker.start();
  const buttons = root.children.filter(child => child.tagName === 'BUTTON');

  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].attributes['data-region'], 'za');
  assert.equal(buttons[1].attributes['data-region'], 'us');
  assert.match(buttons[0].textContent, /🇿🇦.*South Africa/s);
  assert.match(buttons[0].textContent, /3\/16.*2 bots/s);
  assert.equal(buttons[0].attributes['aria-pressed'], 'true');
  assert.equal(buttons[1].attributes['aria-pressed'], 'false');
  assert.equal(buttons.every(button => !button.disabled), true);
  picker.stop();
});

test('local development probes its own ZA server and remote US server', async t => {
  const root = makeRoot();
  root.ownerDocument = {
    ...documentStub,
    defaultView: { location: { origin: 'http://localhost:8080' } },
  };
  const requests = [];
  const picker = createRegionPicker({
    root,
    regions,
    store: { get: () => null, set() {} },
    fetchImpl: async url => {
      requests.push(url);
      const region = url.includes('us.example') ? 'us' : 'za';
      return { ok: true, json: async () => status(region) };
    },
  });
  t.after(() => picker.stop());

  await picker.start();
  assert.ok(requests.includes('http://localhost:8080/region-status'));
  assert.ok(requests.includes('https://us.example/region-status'));
});

test('choosing a region persists the selection and updates pressed styling', async t => {
  const root = makeRoot();
  let saved;
  const picker = createRegionPicker({
    root,
    regions,
    store: { get: () => null, set: (_key, value) => { saved = value; } },
    fetchImpl: async url => ({
      ok: true,
      json: async () => status(url.includes('za.example') ? 'za' : 'us'),
    }),
  });
  t.after(() => picker.stop());
  await picker.start();
  const buttons = root.children.filter(child => child.tagName === 'BUTTON');

  buttons[1].click();

  const updatedButtons = root.children.filter(child => child.tagName === 'BUTTON');
  assert.equal(saved, 'us');
  assert.equal(picker.selectedRegion(), 'us');
  assert.equal(updatedButtons[0].attributes['aria-pressed'], 'false');
  assert.equal(updatedButtons[1].attributes['aria-pressed'], 'true');
  picker.stop();
});

test('a saved offline choice stays selected and blocks joining with its reason visible', async t => {
  const root = makeRoot();
  const picker = createRegionPicker({
    root,
    regions,
    store: { get: () => 'us', set() {} },
    fetchImpl: async url => url.includes('us.example')
      ? { ok: false, status: 503 }
      : { ok: true, json: async () => status('za') },
  });
  t.after(() => picker.stop());
  await picker.start();
  let buttons = root.children.filter(child => child.tagName === 'BUTTON');

  assert.equal(picker.selectedRegion(), 'us');
  assert.equal(buttons[1].attributes['aria-pressed'], 'true');
  assert.equal(buttons[1].disabled, true);
  assert.match(buttons[1].textContent, /OFFLINE/);
  assert.doesNotMatch(buttons[1].textContent, /Network error/i);
  assert.match(buttons[1].attributes.title, /HTTP 503/i);
  assert.equal(await picker.prepareJoin(), null);
  buttons = root.children.filter(child => child.tagName === 'BUTTON');
  assert.equal(picker.selectedRegion(), 'us');
  assert.match(root.textContent, /North America: Region status unavailable \(HTTP 503\)/);
  assert.equal(buttons[1].attributes['aria-pressed'], 'true');
});

test('a late probe cannot repaint a stopped picker', async t => {
  const root = makeRoot();
  const pending = [];
  const picker = createRegionPicker({
    root,
    regions,
    store: { get: () => null, set() {} },
    fetchImpl: url => new Promise(resolve => pending.push({
      region: url.includes('za.example') ? 'za' : 'us',
      resolve,
    })),
  });
  t.after(() => picker.stop());

  const initial = picker.start();
  assert.equal(pending.length, 2);
  const checkingText = root.children.at(-1).textContent;
  picker.stop();
  for (const request of pending) {
    request.resolve({ ok: true, json: async () => status(request.region) });
  }
  await initial;

  assert.match(checkingText, /Checking/);
  assert.equal(root.children.at(-1).textContent, checkingText);
});

test('picker styles show keyboard focus and stack choices on narrow screens', async () => {
  const css = await read('public/style.css');
  assert.match(css, /#regionPicker[^{}]*:focus-visible|\.regionOption:focus-visible/);
  assert.match(css, /@media\s*\(max-width:\s*600px\)[\s\S]*?#regionPicker[\s\S]*?grid-template-columns:\s*1fr/);
});

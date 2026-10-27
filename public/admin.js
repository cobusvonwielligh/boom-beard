import { store } from '/client/store.js';
import { regionIdForOrigin } from '/shared/regions.js';
import { trustKey } from '/shared/region-keys.js';

const $ = id => document.getElementById(id);
const regionId = regionIdForOrigin(location.origin);
const loginView = $('loginView');
const dashboard = $('dashboard');
const loginForm = $('adminLogin');
const loginButton = loginForm.querySelector('button[type="submit"]');
const authMessage = $('authMessage');
const adminNotice = $('adminNotice');
const number = new Intl.NumberFormat();
const dateFormat = new Intl.DateTimeFormat(undefined, {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const state = {
  metrics: [],
  registrations: null,
  geography: null,
  worldMap: [],
  geoMetric: 'hits',
  instance: regionId,
  period: $('registrationPeriod').value,
  search: '',
  from: '',
  to: '',
  sort: 'registered',
  direction: 'desc',
  page: 1,
  pageSize: 25,
  pages: 0,
  total: 0,
};

let metricsTimer = null;
let metricsRequest = 0;
let refreshTimer = null;
let searchTimer = null;

function showLogin(message = '') {
  loginView.hidden = false;
  dashboard.hidden = true;
  authMessage.textContent = message;
  if (metricsTimer) clearInterval(metricsTimer);
  if (refreshTimer) clearInterval(refreshTimer);
  metricsTimer = null;
  refreshTimer = null;
}

function showDashboard() {
  loginView.hidden = true;
  dashboard.hidden = false;
  authMessage.textContent = '';
  startClock();
}

function startClock() {
  const update = () => { $('localClock').textContent = timeFormat.format(new Date()); };
  update();
  if (!startClock.timer) startClock.timer = setInterval(update, 1000);
}

async function responseJson(response) {
  if (response.status === 401) {
    showLogin('Your secure session expired. Verify again to continue.');
    throw new Error('Admin session expired');
  }
  if (!response.ok) {
    let detail = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (typeof body.error === 'string') detail = body.error;
    } catch { /* a non-JSON server response keeps the status as the useful error */ }
    throw new Error(detail);
  }
  return response.status === 204 ? null : response.json();
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'same-origin',
    ...options,
  });
  return responseJson(response);
}

async function unlock() {
  const name = String(store.get('bv.name') ?? '').trim().toLowerCase();
  const deviceToken = store.get(trustKey(regionId, name));
  const password = $('adminPassword').value;
  if (name !== 'cobusvw') {
    throw new Error('Sign in to the game as cobusvw in this browser first.');
  }
  if (!deviceToken) {
    throw new Error('Sign in to the game as cobusvw in this browser before opening the Command Deck.');
  }

  const response = await fetch('/admin/api/login', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, deviceToken, password }),
  });
  if (response.status === 429) {
    const seconds = Number(response.headers.get('Retry-After')) || 1;
    throw new Error(`Too many attempts. Try again in ${seconds} seconds.`);
  }
  if (!response.ok) {
    throw new Error(response.status === 401
      ? 'Access denied. Check the trusted browser and dashboard passphrase.'
      : `Unable to unlock the dashboard (${response.status}).`);
  }
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  authMessage.textContent = '';
  loginButton.disabled = true;
  try {
    await unlock();
    $('adminPassword').value = '';
    showDashboard();
    await refreshDashboard();
    metricsTimer = setInterval(() => loadMetrics().catch(showDashboardError), 10_000);
    refreshTimer = setInterval(() => {
      loadRegistrations().catch(showDashboardError);
      loadGeography().catch(showDashboardError);
      loadPlayers().catch(showDashboardError);
    }, 60_000);
  } catch (error) {
    authMessage.textContent = error.message;
  } finally {
    loginButton.disabled = false;
  }
});

async function checkSession() {
  try {
    const session = await api('/admin/api/session');
    if (!session.ok) {
      showLogin();
      return;
    }
    showDashboard();
    await refreshDashboard();
    metricsTimer = setInterval(() => loadMetrics().catch(showDashboardError), 10_000);
    refreshTimer = setInterval(() => {
      loadRegistrations().catch(showDashboardError);
      loadGeography().catch(showDashboardError);
      loadPlayers().catch(showDashboardError);
    }, 60_000);
  } catch {
    showLogin('The admin service could not be reached. Try again when the server is online.');
  }
}

async function refreshDashboard() {
  await Promise.all([
    loadMetrics().catch(showDashboardError),
    loadRegistrations().catch(showDashboardError),
    loadWorldMap().catch(showDashboardError),
    loadGeography().catch(showDashboardError),
    loadPlayers().catch(showDashboardError),
  ]);
}

function showDashboardError(error) {
  if (dashboard.hidden) return;
  adminNotice.textContent = error.message;
}

async function loadMetrics() {
  const request = ++metricsRequest;
  const instance = state.instance;
  let metrics;
  try {
    metrics = await api(`/admin/api/metrics?region=${encodeURIComponent(instance)}`);
  } catch (error) {
    if (request !== metricsRequest) return;
    throw error;
  }
  if (request !== metricsRequest) return;
  state.metrics = metrics;
  const latest = state.metrics.at(-1);
  if (!latest) return;
  setMetric('cpu', latest.cpuPct, 'cpuPct', '#edc24e');
  setMetric('memory', latest.memoryPct, 'memoryPct', '#70c4ff');
  setMetric('storage', latest.diskPct, 'diskPct', '#67d8ab');
}

function clearMetrics() {
  for (const [id, colour] of [
    ['cpu', '#edc24e'],
    ['memory', '#70c4ff'],
    ['storage', '#67d8ab'],
  ]) {
    $(`${id}Value`).textContent = '--';
    $(`${id}Time`).textContent = 'WAITING FOR SAMPLE';
    drawSparkline($(`${id}Chart`), [], colour);
  }
}

function setMetric(id, value, key, colour) {
  const formatted = Number.isFinite(value) ? value.toFixed(1) : '--';
  $(`${id}Value`).textContent = formatted;
  $(`${id}Time`).textContent = `UPDATED ${timeFormat.format(new Date(state.metrics.at(-1).at))}`;
  drawSparkline($(`${id}Chart`), state.metrics.map(point => point[key]), colour);
}

async function loadRegistrations() {
  state.registrations = await api(
    `/admin/api/registrations?period=${encodeURIComponent(state.period)}`,
  );
  const report = state.registrations;
  $('registrationCurrent').textContent = number.format(report.currentTotal);
  $('registrationDates').textContent = `${report.currentStart} — ${report.currentEnd}`;
  $('registrationStart').textContent = report.days[0]?.date ?? '—';
  $('registrationEnd').textContent = report.days.at(-1)?.date ?? '—';
  const badge = $('registrationChange');
  badge.dataset.direction = report.direction;
  $('changeArrow').textContent = report.direction === 'up' ? '↗'
    : report.direction === 'down' ? '↘' : '→';
  const changeSign = report.change > 0 ? '+' : '';
  const percentSign = report.changePct > 0 ? '+' : '';
  const percent = report.changePct === null ? 'NEW'
    : `${percentSign}${report.changePct.toFixed(1)}%`;
  $('changeValue').textContent =
    `${changeSign}${number.format(report.change)} · ${percent}`;
  $('registrationEmpty').hidden = report.currentTotal > 0;
  drawRegistration(report.days);
}

async function loadWorldMap() {
  state.worldMap = await api('/admin/api/worldmap');
  const group = $('worldCountries');
  group.replaceChildren();
  for (const country of state.worldMap) {
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.classList.add('countryShape');
    shape.dataset.country = country.country;
    shape.setAttribute('d', country.path);
    shape.setAttribute('fill', '#17232f');
    shape.setAttribute('aria-label', country.name);
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = country.name;
    shape.append(title);
    group.append(shape);

    const outline = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    outline.classList.add('countryOutline');
    outline.dataset.country = country.country;
    outline.setAttribute('d', country.outlinePath);
    outline.setAttribute('aria-hidden', 'true');
    group.append(outline);
  }
  renderGeography();
}

async function loadGeography() {
  const period = $('geographyPeriod').value;
  state.geography = await api(`/admin/api/geography?period=${encodeURIComponent(period)}`);
  $('geoHits').textContent = number.format(state.geography.totalHits);
  $('geoRegistrations').textContent = number.format(state.geography.totalRegistrations);
  $('geoCountryCount').textContent = number.format(state.geography.countries.length);
  $('geographyRange').textContent = `${state.geography.from} — ${state.geography.to}`;
  renderGeography();
}

function renderGeography() {
  if (!state.geography || !state.worldMap.length) return;
  const counts = new Map(state.geography.countries.map(item => [item.country, item]));
  const metricValue = item => !item ? 0
    : state.geoMetric === 'hits' ? item.hits
      : state.geoMetric === 'registrations' ? item.registrations
        : item.hits + item.registrations;
  const maximum = Math.max(1, ...state.geography.countries.map(metricValue));
  const top = [...state.geography.countries]
    .sort((a, b) => metricValue(b) - metricValue(a) || a.country.localeCompare(b.country))
    .filter(item => metricValue(item) > 0)
    .slice(0, 5);

  for (const shape of $('worldCountries').querySelectorAll('.countryShape')) {
    const country = state.worldMap.find(item => item.country === shape.dataset.country);
    const countsForCountry = counts.get(shape.dataset.country);
    const value = metricValue(countsForCountry);
    shape.style.fill = value > 0 ? heatColor(Math.log1p(value) / Math.log1p(maximum)) : '#17232f';
    shape.nextElementSibling?.classList.toggle('hasActivity', value > 0);
    const title = shape.querySelector('title');
    if (title && country) {
      title.textContent = countsForCountry
        ? `${country.name}: ${number.format(countsForCountry.hits)} visits, ` +
          `${number.format(countsForCountry.registrations)} registrations`
        : `${country.name}: no resolved activity`;
    }
  }

  $('geographyStatus').hidden = top.length > 0;
  $('geographyStatus').textContent = top.length
    ? ''
    : 'No country-resolved activity yet. New visits and registrations will appear here.';
  renderTopCountries(top);
}

function heatColor(amount) {
  const stops = [
    [35, 62, 88],
    [61, 93, 145],
    [126, 91, 135],
    [209, 113, 64],
    [248, 204, 91],
  ];
  const scaled = Math.max(0, Math.min(1, amount)) * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const rgb = stops[index].map((value, channel) =>
    Math.round(value + (stops[index + 1][channel] - value) * mix));
  return `rgb(${rgb.join(' ')})`;
}

function renderTopCountries(items) {
  const list = $('topCountries');
  list.replaceChildren();
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'topCountry';
    const name = document.createElement('strong');
    name.textContent = item.country;
    const values = document.createElement('span');
    values.textContent = `${number.format(item.hits)} visits · ${number.format(item.registrations)} sign-ups`;
    row.append(name, values);
    list.append(row);
  }
}

async function loadPlayers() {
  const params = new URLSearchParams({
    search: state.search,
    sort: state.sort,
    direction: state.direction,
    page: String(state.page),
    pageSize: String(state.pageSize),
  });
  if (state.from) params.set('from', state.from);
  if (state.to) params.set('to', state.to);
  const report = await api(`/admin/api/players?${params}`);
  state.page = report.page;
  state.pages = report.pages;
  state.total = report.total;
  renderPlayers(report.items);
  updateTableControls();
  adminNotice.textContent = '';
}

function renderPlayers(players) {
  const body = $('playerRows');
  body.replaceChildren();
  if (!players.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 8;
    cell.className = 'tableEmpty';
    cell.textContent = 'No registered players match these filters.';
    row.append(cell);
    body.append(row);
    return;
  }

  for (const player of players) {
    const row = document.createElement('tr');
    const registered = document.createElement('td');
    registered.className = 'dateCell';
    registered.textContent = Number.isFinite(player.created)
      ? dateFormat.format(new Date(player.created)) : '—';
    row.append(registered);

    const name = document.createElement('td');
    name.className = 'playerName';
    name.textContent = player.name;
    row.append(name);

    appendCell(row, `L${player.level}`, 'levelCell', `${player.tier} level`);
    appendCell(row, number.format(player.xp), 'xpCell', 'Lifetime score is XP');
    appendCell(row, number.format(player.kills));
    appendCell(row, number.format(player.deaths));
    appendCell(row, number.format(player.coins));
    appendCell(row,
      `${player.gold} G · ${player.silver} S · ${player.bronze} B`, 'medalsCell', 'Gold, silver, bronze');
    body.append(row);
  }
}

function appendCell(row, value, className = '', title = '') {
  const cell = document.createElement('td');
  cell.textContent = value;
  if (className) cell.className = className;
  if (title) cell.title = title;
  row.append(cell);
}

function updateTableControls() {
  const first = state.total ? (state.page - 1) * state.pageSize + 1 : 0;
  const last = Math.min(state.total, state.page * state.pageSize);
  $('playerCount').textContent = number.format(state.total);
  $('pageInfo').textContent = `${first}–${last} OF ${number.format(state.total)}`;
  $('previousPage').disabled = state.page <= 1;
  $('nextPage').disabled = !state.pages || state.page >= state.pages;
  for (const button of document.querySelectorAll('[data-sort]')) {
    const active = button.dataset.sort === state.sort;
    button.setAttribute('aria-sort', active
      ? state.direction === 'asc' ? 'ascending' : 'descending'
      : 'none');
    button.querySelector('.sortMark').textContent =
      active ? state.direction === 'asc' ? '↑' : '↓' : '';
  }
}

function drawSparkline(canvas, values, colour) {
  const { ctx, width, height } = canvasContext(canvas);
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  if (!values.length) return;
  const valid = values.filter(Number.isFinite);
  if (values.length === 1 && valid.length) {
    const y = height - 5 - (values[0] / 100) * (height - 10);
    ctx.beginPath(); ctx.arc(width - 3, y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = colour; ctx.fill();
    return;
  }
  if (values.length < 2) return;
  const max = Math.max(100, ...valid);
  const step = width / Math.max(1, values.length - 1);
  ctx.strokeStyle = '#ffffff10';
  ctx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    const y = Math.round((height * i) / 3);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }
  ctx.beginPath();
  let started = false;
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) { started = false; return; }
    const x = index * step;
    const y = height - 5 - (value / max) * (height - 10);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.8;
  ctx.shadowColor = colour;
  ctx.shadowBlur = 7;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function drawRegistration(days) {
  const canvas = $('registrationChart');
  const { ctx, width, height } = canvasContext(canvas);
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  if (!days.length) return;
  const pad = { top: 10, right: 7, bottom: 10, left: 7 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...days.map(item => item.count));
  const step = innerW / Math.max(1, days.length - 1);

  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#ffffff10';
  for (let i = 0; i < 4; i++) {
    const y = pad.top + (innerH * i) / 3;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
  }

  const points = days.map((item, index) => ({
    x: pad.left + index * step,
    y: pad.top + innerH - (item.count / max) * innerH,
  }));
  const gradient = ctx.createLinearGradient(0, pad.top, 0, height);
  gradient.addColorStop(0, '#edc24e55');
  gradient.addColorStop(1, '#edc24e00');
  ctx.beginPath();
  ctx.moveTo(points[0].x, height);
  points.forEach(point => ctx.lineTo(point.x, point.y));
  ctx.lineTo(points.at(-1).x, height);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  points.forEach((point, index) => {
    if (!index) ctx.moveTo(point.x, point.y); else ctx.lineTo(point.x, point.y);
  });
  ctx.strokeStyle = '#f2d578';
  ctx.lineWidth = 2;
  ctx.shadowColor = '#edc24e66';
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  if (points.length <= 31) {
    for (const point of points) {
      ctx.beginPath(); ctx.arc(point.x, point.y, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = '#fff0b0'; ctx.fill();
    }
  }
}

function canvasContext(canvas) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return { ctx: null, width: 0, height: 0 };
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.round(rect.width * ratio);
  const height = Math.round(rect.height * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return { ctx: null, width: 0, height: 0 };
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

$('registrationPeriod').addEventListener('change', () => {
  state.period = $('registrationPeriod').value;
  loadRegistrations().catch(showDashboardError);
});

$('instanceSelect').value = state.instance;
$('instanceSelect').addEventListener('change', () => {
  state.instance = $('instanceSelect').value;
  state.metrics = [];
  clearMetrics();
  adminNotice.textContent = '';
  loadMetrics().catch(showDashboardError);
});

$('geographyPeriod').addEventListener('change', () => {
  loadGeography().catch(showDashboardError);
});

document.querySelectorAll('[data-geo-metric]').forEach(button => {
  button.addEventListener('click', () => {
    state.geoMetric = button.dataset.geoMetric;
    for (const option of document.querySelectorAll('[data-geo-metric]')) {
      option.setAttribute('aria-pressed', String(option === button));
    }
    renderGeography();
  });
});

$('playerSearch').addEventListener('input', () => {
  state.search = $('playerSearch').value.trim();
  state.page = 1;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadPlayers().catch(showDashboardError), 180);
});

for (const [id, key] of [['fromDate', 'from'], ['toDate', 'to']]) {
  $(id).addEventListener('change', () => {
    state[key] = $(id).value;
    state.page = 1;
    loadPlayers().catch(showDashboardError);
  });
}

$('clearDates').addEventListener('click', () => {
  $('fromDate').value = '';
  $('toDate').value = '';
  state.from = '';
  state.to = '';
  state.page = 1;
  loadPlayers().catch(showDashboardError);
});

$('pageSize').addEventListener('change', () => {
  state.pageSize = Number($('pageSize').value);
  state.page = 1;
  loadPlayers().catch(showDashboardError);
});

$('previousPage').addEventListener('click', () => {
  if (state.page <= 1) return;
  state.page--;
  loadPlayers().catch(showDashboardError);
});

$('nextPage').addEventListener('click', () => {
  if (state.page >= state.pages) return;
  state.page++;
  loadPlayers().catch(showDashboardError);
});

document.querySelectorAll('[data-sort]').forEach(button => {
  button.addEventListener('click', () => {
    const key = button.dataset.sort;
    state.direction = key === state.sort && state.direction === 'desc' ? 'asc'
      : key === state.sort ? 'desc' : key === 'name' ? 'asc' : 'desc';
    state.sort = key;
    state.page = 1;
    updateTableControls();
    loadPlayers().catch(showDashboardError);
  });
});

$('logoutButton').addEventListener('click', async () => {
  try {
    await api('/admin/api/logout', { method: 'POST' });
    showLogin('Dashboard locked.');
  } catch (error) {
    showDashboardError(error);
  }
});

window.addEventListener('resize', () => {
  if (dashboard.hidden) return;
  state.metrics.length && setMetric('cpu', state.metrics.at(-1).cpuPct, 'cpuPct', '#edc24e');
  state.metrics.length && setMetric('memory', state.metrics.at(-1).memoryPct, 'memoryPct', '#70c4ff');
  state.metrics.length && setMetric('storage', state.metrics.at(-1).diskPct, 'diskPct', '#67d8ab');
  if (state.registrations) drawRegistration(state.registrations.days);
});

checkSession();

import { REGIONS } from '../../shared/regions.js';
import { selectedRegionId } from '../../shared/region-selection.js';

const REGION_STORE_KEY = 'bv.region';

function offlineResult(region, reason) {
  return {
    id: region.id,
    name: region.name,
    flag: region.flag,
    online: false,
    rttMs: null,
    humanPlayers: null,
    bots: null,
    maxPlayers: null,
    reason,
  };
}

function validStatus(status, region) {
  return status !== null
    && typeof status === 'object'
    && status.region === region.id
    && Number.isSafeInteger(status.humanPlayers)
    && status.humanPlayers >= 0
    && Number.isSafeInteger(status.bots)
    && status.bots >= 0
    && Number.isSafeInteger(status.maxPlayers)
    && status.maxPlayers > 0
    && status.humanPlayers + status.bots <= status.maxPlayers;
}

export function pingClass(rttMs) {
  if (!Number.isFinite(rttMs) || rttMs < 0) return '';
  if (rttMs <= 50) return 'pingGood';
  return rttMs <= 99 ? 'pingFair' : 'pingPoor';
}

export async function probeRegion(
  region,
  { fetchImpl = fetch, now = () => performance.now(), timeoutMs = 2000 } = {},
) {
  const controller = new AbortController();
  const startedAt = now();
  let timeoutId;
  const timeoutError = new Error(`Region probe timed out after ${timeoutMs} ms`);
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(timeoutError);
      controller.abort();
    }, timeoutMs);
  });

  let response;
  let status;
  let invalidStatus = false;
  try {
    const request = (async () => {
      const received = await fetchImpl(`${region.origin}/region-status`, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        mode: 'cors',
        signal: controller.signal,
      });
      if (!received || received.ok !== true || typeof received.json !== 'function') {
        return { response: received };
      }
      try {
        return { response: received, status: await received.json() };
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof TypeError) {
          return { response: received, invalidStatus: true };
        }
        throw error;
      }
    })();
    ({ response, status, invalidStatus } = await Promise.race([request, timeout]));
  } catch (error) {
    if (error === timeoutError || error?.name === 'AbortError') {
      return offlineResult(region, 'Region probe timed out.');
    }
    if (error instanceof TypeError) {
      return offlineResult(region, 'Network error while checking this region.');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response || response.ok !== true) {
    const statusCode = Number.isFinite(response?.status) ? ` (HTTP ${response.status})` : '';
    return offlineResult(region, `Region status unavailable${statusCode}.`);
  }
  if (invalidStatus || !validStatus(status, region)) {
    return offlineResult(region, 'Invalid region status response.');
  }

  return {
    id: region.id,
    name: region.name,
    flag: region.flag,
    region: status.region,
    humanPlayers: status.humanPlayers,
    bots: status.bots,
    maxPlayers: status.maxPlayers,
    online: true,
    rttMs: Math.round(now() - startedAt),
    reason: null,
  };
}

export function probeRegions(regions, options) {
  return Promise.all(regions.map(region => probeRegion(region, options)));
}

export function createRegionPicker({
  root,
  dialog,
  confirmButton,
  cancelButton,
  store,
  regions = REGIONS,
  fetchImpl = fetch,
}) {
  if (!root || !dialog || !confirmButton || !cancelButton || !store) {
    throw new TypeError('The region picker requires its dialog, controls, root, and store.');
  }

  const doc = root.ownerDocument ?? document;
  const currentOrigin = doc.defaultView?.location?.origin ?? globalThis.location?.origin;
  const localHostname = currentOrigin ? new URL(currentOrigin).hostname : null;
  const localOrigin = ['localhost', '127.0.0.1', '::1'].includes(localHostname)
    ? currentOrigin : null;
  const probeTargets = localOrigin
    ? regions.map(region => region.id === 'za' ? { ...region, origin: localOrigin } : region)
    : regions;
  let selectedId = null;
  let results = [];
  let generation = 0;
  let resolveChoice = null;
  let rejectChoice = null;

  function render() {
    const buttons = regions.map(region => {
      const result = results.find(item => item.id === region.id);
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'regionOption';
      button.setAttribute('data-region', region.id);
      button.setAttribute('aria-pressed', String(selectedId === region.id));
      button.disabled = !!result && !result.online;

      const flag = doc.createElement('img');
      flag.className = 'regionFlag';
      flag.setAttribute('src', region.flag);
      flag.setAttribute('alt', `${region.name} flag`);

      const title = doc.createElement('span');
      title.className = 'regionName';
      title.textContent = region.name;

      const details = doc.createElement('span');
      details.className = 'regionDetails';
      if (!result) {
        details.textContent = 'CHECKING…';
      } else if (result.online) {
        const ping = doc.createElement('span');
        ping.className = `regionPing ${pingClass(result.rttMs)}`;
        ping.textContent = `${result.rttMs} ms`;
        const online = doc.createElement('span');
        online.className = 'regionOnline';
        online.textContent = `${result.humanPlayers}/${result.maxPlayers} players`;
        details.append(ping, online);
      } else {
        details.textContent = 'OFFLINE';
      }

      button.title = result?.online ? '' : result?.reason || '';
      button.setAttribute('aria-label', !result
        ? `${region.name}, checking server status`
        : result.online
          ? `${region.name}, ${result.rttMs} milliseconds, ${result.humanPlayers} of ` +
            `${result.maxPlayers} players online`
          : `${region.name}, offline`);
      button.append(flag, title, details);
      button.addEventListener('click', () => {
        if (!result?.online) return;
        selectedId = region.id;
        render();
      });
      return button;
    });

    root.replaceChildren(...buttons);
    const selected = results.find(result => result.id === selectedId);
    confirmButton.disabled = !selected?.online;
  }

  function finishChoice(value, error = null) {
    if (!resolveChoice) return;
    const resolve = resolveChoice;
    const reject = rejectChoice;
    resolveChoice = null;
    rejectChoice = null;
    generation++;
    dialog.close();
    if (error) reject(error);
    else resolve(value);
  }

  async function refresh(expectedGeneration) {
    const refreshed = await probeRegions(probeTargets, { fetchImpl });
    if (!resolveChoice || expectedGeneration !== generation) return;
    results = refreshed;
    if (!selectedId) selectedId = selectedRegionId(results);
    render();
  }

  async function confirmSelection() {
    if (!resolveChoice || !selectedId || confirmButton.disabled) return;
    const expectedGeneration = generation;
    const selectedRegion = probeTargets.find(region => region.id === selectedId);
    confirmButton.disabled = true;
    try {
      const latest = await probeRegion(selectedRegion, { fetchImpl });
      if (!resolveChoice || expectedGeneration !== generation) return;
      results = results.map(result => result.id === selectedId ? latest : result);
      render();
      if (!latest.online) return;
      store.set(REGION_STORE_KEY, selectedId);
      finishChoice(selectedId);
    } catch (error) {
      finishChoice(null, error);
    }
  }

  confirmButton.addEventListener('click', confirmSelection);
  cancelButton.addEventListener('click', () => finishChoice(null));
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    finishChoice(null);
  });

  function chooseRegion() {
    if (resolveChoice) return Promise.reject(new Error('A region choice is already open.'));
    const savedId = store.get(REGION_STORE_KEY);
    selectedId = regions.some(region => region.id === savedId) ? savedId : null;
    results = [];
    render();
    dialog.showModal();

    const expectedGeneration = ++generation;
    const choice = new Promise((resolve, reject) => {
      resolveChoice = resolve;
      rejectChoice = reject;
    });
    refresh(expectedGeneration).catch(error => finishChoice(null, error));
    return choice;
  }

  function stop() {
    finishChoice(null);
  }

  render();
  return {
    chooseRegion,
    selectedRegion: () => selectedId,
    stop,
  };
}

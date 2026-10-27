import { REGIONS } from '../../shared/regions.js';
import { selectedRegionId } from '../../shared/region-selection.js';

const POLL_INTERVAL_MS = 30_000;
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
    const status = Number.isFinite(response?.status) ? ` (HTTP ${response.status})` : '';
    return offlineResult(region, `Region status unavailable${status}.`);
  }
  if (invalidStatus) {
    return offlineResult(region, 'Invalid region status response.');
  }
  if (!validStatus(status, region)) {
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
  store,
  regions = REGIONS,
  fetchImpl = fetch,
}) {
  if (!root || !store) throw new TypeError('A root element and region store are required.');

  const doc = root.ownerDocument ?? document;
  const currentOrigin = doc.defaultView?.location?.origin ?? globalThis.location?.origin;
  const localHostname = currentOrigin ? new URL(currentOrigin).hostname : null;
  const localOrigin = ['localhost', '127.0.0.1', '::1'].includes(localHostname)
    ? currentOrigin : null;
  const probeTargets = localOrigin
    ? regions.map(region => region.id === 'za' ? { ...region, origin: localOrigin } : region)
    : regions;
  const savedId = store.get(REGION_STORE_KEY);
  let manualId = regions.some(region => region.id === savedId) ? savedId : null;
  let selectedId = manualId;
  let results = [];
  let pollTimer = null;
  let running = false;
  let generation = 0;
  let refreshSequence = 0;

  const heading = doc.createElement('h2');
  heading.className = 'regionHeading';
  heading.textContent = 'Choose your waters';
  const statusLine = doc.createElement('p');
  statusLine.className = 'regionStatus';
  statusLine.setAttribute('role', 'status');
  statusLine.setAttribute('aria-live', 'polite');

  function updateStatus() {
    const selected = results.find(result => result.id === selectedId);
    statusLine.textContent = selected && !selected.online
      ? `${selected.name}: ${selected.reason}`
      : selected
        ? `${selected.name} server ready.`
        : 'Checking for reachable waters…';
  }

  function render() {
    const buttons = regions.map(region => {
      const result = results.find(item => item.id === region.id);
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'regionOption';
      button.setAttribute('data-region', region.id);
      button.setAttribute('aria-pressed', String(selectedId === region.id));
      button.disabled = !!result && !result.online;

      const title = doc.createElement('span');
      title.className = 'regionName';
      title.textContent = `${region.flag} ${region.name}`;
      const details = doc.createElement('span');
      details.className = 'regionDetails';
      details.textContent = !result
        ? 'Checking…'
        : result.online
          ? `${result.rttMs} ms · ${result.humanPlayers}/${result.maxPlayers} players · ${result.bots} bots`
          : 'OFFLINE';
      button.setAttribute('title', result?.online ? '' : result?.reason || '');
      button.setAttribute('aria-label', !result
        ? `${region.name}, checking server status`
        : result.online
          ? `${region.name}, ${result.rttMs} milliseconds, ${result.humanPlayers} humans of ` +
            `${result.maxPlayers}, ${result.bots} bots`
          : `${region.name}, offline: ${result.reason}`);
      button.append(title, details);
      button.addEventListener('click', () => {
        manualId = region.id;
        selectedId = region.id;
        store.set(REGION_STORE_KEY, region.id);
        updateStatus();
        render();
      });
      return button;
    });

    root.replaceChildren(heading, ...buttons, statusLine);
    updateStatus();
  }

  async function refresh(expectedGeneration = generation) {
    const sequence = ++refreshSequence;
    const refreshed = await probeRegions(probeTargets, { fetchImpl });
    if (!running || expectedGeneration !== generation || sequence !== refreshSequence) return results;
    results = refreshed;
    if (manualId) {
      selectedId = manualId;
    } else {
      selectedId = selectedRegionId(results);
    }
    render();
    return results;
  }

  async function start() {
    if (running) return results;
    running = true;
    const currentGeneration = ++generation;
    const initialProbe = refresh(currentGeneration);
    const showRefreshError = error => {
      if (running && currentGeneration === generation) {
        statusLine.textContent = `Server check failed: ${error.message}`;
      }
    };
    pollTimer = setInterval(() => {
      refresh(currentGeneration).catch(showRefreshError);
    }, POLL_INTERVAL_MS);
    return initialProbe.catch(error => {
      showRefreshError(error);
      return results;
    });
  }

  async function prepareJoin() {
    const currentGeneration = generation;
    const latest = await refresh(currentGeneration);
    if (!running || currentGeneration !== generation) return null;
    const id = selectedRegionId(latest, manualId);
    if (!id) {
      const selected = latest.find(result => result.id === selectedId)
        ?? latest.find(result => !result.online);
      statusLine.textContent = selected?.reason
        ? `${selected.name}: ${selected.reason}`
        : 'No region is reachable right now.';
      return null;
    }
    return id;
  }

  function stop() {
    running = false;
    generation++;
    refreshSequence++;
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
  }

  render();
  return {
    start,
    selectedRegion: () => selectedId,
    prepareJoin,
    stop,
  };
}

import { REGIONS, transportUrls } from '../../shared/regions.js';
import { PING_BURST_GAP_MS, RTT_SAMPLES } from '../../shared/constants.js';
import { MAPS } from '../../shared/maps.js';
import { selectedRegionId } from '../../shared/region-selection.js';
import { startPingBurst } from './ping-burst.js';

const REGION_STORE_KEY = 'bv.region';
const REGION_DOUBLE_CLICK_MS = 450;
const mapsById = new Map(MAPS.map(map => [map.id, map]));
let nextPingId = 0;

class PingProbeError extends Error {}

function abortError() {
  const error = new Error('Region probe was cancelled.');
  error.name = 'AbortError';
  return error;
}

function offlineResult(region, reason) {
  return {
    id: region.id,
    name: region.name,
    flag: region.flag,
    online: false,
    statusReady: false,
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
    && status.humanPlayers + status.bots <= status.maxPlayers
    && (status.map === undefined || mapsById.has(status.map));
}

export function pingClass(rttMs) {
  if (!Number.isFinite(rttMs) || rttMs < 0) return '';
  if (rttMs <= 50) return 'pingGood';
  return rttMs <= 99 ? 'pingFair' : 'pingPoor';
}

export function measureGamePing(region, {
  WebSocketImpl = globalThis.WebSocket,
  now = () => performance.now(),
  timeoutMs = 6000,
  gapMs = PING_BURST_GAP_MS,
  onSample = () => {},
  signal,
} = {}) {
  if (typeof WebSocketImpl !== 'function') {
    return Promise.reject(new PingProbeError('WebSocket is not available for game ping.'));
  }
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    let socket;
    let timeoutId;
    let cancelBurst = null;
    let settled = false;
    const sentAt = new Map();
    const samples = [];

    const cleanup = () => {
      clearTimeout(timeoutId);
      cancelBurst?.();
      signal?.removeEventListener('abort', handleAbort);
      if (socket && socket.readyState < 2) socket.close();
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      const minimum = Math.min(...samples);
      cleanup();
      resolve(minimum);
    };
    const handleAbort = () => fail(abortError());
    const handleMessage = event => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        if (error instanceof SyntaxError) return;
        throw error;
      }
      if (message?.t !== 'pong' || !sentAt.has(message.c)) return;
      const started = sentAt.get(message.c);
      sentAt.delete(message.c);
      try {
        const sample = Math.max(0, Math.round(now() - started));
        samples.push(sample);
        onSample(sample);
        if (samples.length === RTT_SAMPLES) finish();
      } catch (error) {
        fail(error);
      }
    };

    signal?.addEventListener('abort', handleAbort, { once: true });
    timeoutId = setTimeout(() => {
      fail(new PingProbeError(`Game ping timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    try {
      const { ws } = transportUrls(region.origin);
      socket = new WebSocketImpl(ws);
    } catch (error) {
      fail(new PingProbeError(`Could not open game ping socket: ${error.message}`));
      return;
    }

    socket.addEventListener('open', () => {
      if (settled) return;
      cancelBurst = startPingBurst(() => {
        if (settled) return;
        const correlation = `region-ping-${++nextPingId}`;
        sentAt.set(correlation, now());
        try {
          socket.send(JSON.stringify({ t: 'ping', c: correlation }));
        } catch (error) {
          fail(new PingProbeError(`Could not send game ping: ${error.message}`));
        }
      }, { count: RTT_SAMPLES, gapMs });
    });
    socket.addEventListener('message', handleMessage);
    socket.addEventListener('error', () => {
      fail(new PingProbeError('Game ping socket failed.'));
    });
    socket.addEventListener('close', () => {
      if (!settled) fail(new PingProbeError('Game ping socket closed before all samples arrived.'));
    });
  });
}

export async function probeRegion(region, {
  fetchImpl = fetch,
  WebSocketImpl = globalThis.WebSocket,
  now = () => performance.now(),
  timeoutMs = 2000,
  pingTimeoutMs = 6000,
  gapMs = PING_BURST_GAP_MS,
  signal,
  onProbeStatus = () => {},
  onPingSample = () => {},
} = {}) {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  const abortRequest = () => controller.abort();
  signal?.addEventListener('abort', abortRequest, { once: true });
  let timeoutId;
  const timeoutError = new Error(`Region status probe timed out after ${timeoutMs} ms.`);
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(timeoutError);
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
    if (signal?.aborted) throw abortError();
    if (error === timeoutError || error?.name === 'AbortError') {
      return offlineResult(region, 'Region status probe timed out.');
    }
    if (error instanceof TypeError) {
      return offlineResult(region, 'Network error while checking this region.');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortRequest);
  }

  if (!response || response.ok !== true) {
    const statusCode = Number.isFinite(response?.status) ? ` (HTTP ${response.status})` : '';
    return offlineResult(region, `Region status unavailable${statusCode}.`);
  }
  if (invalidStatus || !validStatus(status, region)) {
    return offlineResult(region, 'Invalid region status response.');
  }

  const statusResult = {
    id: region.id,
    name: region.name,
    flag: region.flag,
    region: status.region,
    map: status.map ?? null,
    humanPlayers: status.humanPlayers,
    bots: status.bots,
    maxPlayers: status.maxPlayers,
    statusReady: true,
    online: false,
    rttMs: null,
    reason: null,
  };
  onProbeStatus(statusResult);

  try {
    const rttMs = await measureGamePing(region, {
      WebSocketImpl,
      now,
      timeoutMs: pingTimeoutMs,
      gapMs,
      signal,
      onSample: sample => onPingSample(sample, statusResult),
    });
    return { ...statusResult, online: true, rttMs, reason: null };
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw abortError();
    if (error instanceof PingProbeError) {
      return { ...statusResult, online: false, rttMs: null, reason: error.message };
    }
    throw error;
  }
}

export function probeRegions(regions, options = {}) {
  return Promise.all(regions.map(region => probeRegion(region, {
    ...options,
    onProbeStatus: result => options.onProbeStatus?.(region, result),
    onPingSample: (sample, result) => options.onPingSample?.(region, sample, result),
  })));
}

export function createRegionPicker({
  root,
  dialog,
  confirmButton,
  cancelButton,
  refreshButton,
  statusMessage,
  progressTrack,
  progressFill,
  store,
  regions = REGIONS,
  fetchImpl = fetch,
  WebSocketImpl = globalThis.WebSocket,
  now = () => performance.now(),
  pingTimeoutMs = 2500,
  pingGapMs = PING_BURST_GAP_MS,
}) {
  if (!root || !dialog || !confirmButton || !cancelButton || !refreshButton
    || !statusMessage || !progressTrack || !progressFill || !store) {
    throw new TypeError('The region picker requires its dialog, controls, progress bar, root, and store.');
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
  let refreshGeneration = 0;
  let activeController = null;
  let refreshing = false;
  let holdingForConnect = false;
  let lastRegionClick = null;
  let resolveChoice = null;
  let rejectChoice = null;

  function showConnectionProgress(value, message) {
    progressTrack.hidden = false;
    progressTrack.setAttribute('aria-valuenow', String(value));
    progressTrack.setAttribute('aria-valuetext', message);
    progressFill.style.width = `${value}%`;
    statusMessage.textContent = message;
  }

  function clearConnectionProgress(message = '') {
    progressTrack.hidden = true;
    progressTrack.setAttribute('aria-valuenow', '0');
    progressTrack.setAttribute('aria-valuetext', 'Not started');
    progressFill.style.width = '0%';
    statusMessage.textContent = message;
  }

  function setConnectionState(state) {
    if (!holdingForConnect) return;
    if (state === 'connecting') {
      showConnectionProgress(68, 'Opening the game connection…');
    } else if (state === 'open') {
      showConnectionProgress(86, 'Connection established. Loading the island…');
    } else if (state === 'welcome') {
      showConnectionProgress(100, 'Island ready. Entering now…');
    } else {
      clearConnectionProgress(`Connection interrupted: ${state}.`);
    }
  }

  function render() {
    const buttons = regions.map(region => {
      const result = results.find(item => item.id === region.id);
      const mapName = result?.map ? mapsById.get(result.map)?.name ?? result.map : '';
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'regionOption';
      button.setAttribute('data-region', region.id);
      button.setAttribute('aria-pressed', String(selectedId === region.id));
      button.disabled = holdingForConnect || refreshing || !result?.online;

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
      } else if (result.statusReady) {
        const ping = doc.createElement('span');
        ping.className = `regionPing ${pingClass(result.rttMs)}`;
        ping.textContent = Number.isFinite(result.rttMs)
          ? `${result.rttMs} ms`
          : result.reason ? 'OFFLINE' : 'CHECKING PING…';
        const players = result.humanPlayers + result.bots;
        const online = doc.createElement('span');
        online.className = 'regionOnline';
        online.textContent = `${players}/${result.maxPlayers} players`;
        details.append(ping, online);
        if (mapName) {
          const currentMap = doc.createElement('span');
          currentMap.className = 'regionMap';
          currentMap.textContent = `MAP · ${mapName}`;
          details.append(currentMap);
        }
      } else {
        details.textContent = 'OFFLINE';
      }

      button.title = result?.online ? '' : result?.reason || '';
      button.setAttribute('aria-label', !result
        ? `${region.name}, checking server status`
        : result.statusReady
          ? `${region.name}, ${mapName ? `${mapName} map, ` : ''}${Number.isFinite(result.rttMs)
            ? `${result.rttMs} milliseconds` : 'ping checking'}, ` +
            `${result.humanPlayers + result.bots} of ${result.maxPlayers} players online`
          : `${region.name}, offline`);
      button.append(flag, title, details);
      button.addEventListener('click', () => {
        if (holdingForConnect || refreshing || !result?.online) return;
        const clickedAt = now();
        const elapsed = lastRegionClick?.id === region.id
          ? clickedAt - lastRegionClick.at : Infinity;
        const doubleClick = elapsed >= 0 && elapsed <= REGION_DOUBLE_CLICK_MS;
        lastRegionClick = doubleClick ? null : { id: region.id, at: clickedAt };
        selectedId = region.id;
        statusMessage.textContent = '';
        render();
        if (doubleClick) confirmSelection();
      });
      return button;
    });

    root.replaceChildren(...buttons);
    const selected = results.find(result => result.id === selectedId);
    confirmButton.disabled = holdingForConnect || refreshing || !selected?.online;
    cancelButton.disabled = holdingForConnect;
    refreshButton.disabled = holdingForConnect || refreshing;
  }

  function finishChoice(value, error = null, { closeDialog = true } = {}) {
    if (!resolveChoice) return;
    const resolve = resolveChoice;
    const reject = rejectChoice;
    resolveChoice = null;
    rejectChoice = null;
    generation++;
    refreshGeneration++;
    activeController?.abort();
    activeController = null;
    refreshing = false;
    holdingForConnect = !closeDialog && !error && value !== null;
    if (holdingForConnect) {
      const selectedRegion = regions.find(region => region.id === value);
      showConnectionProgress(55, `Connecting to ${selectedRegion?.name ?? 'your selected region'}…`);
    } else {
      clearConnectionProgress();
    }
    refreshButton.disabled = holdingForConnect;
    refreshButton.setAttribute('aria-busy', 'false');
    if (closeDialog) dialog.close();
    render();
    if (error) reject(error);
    else resolve(value);
  }

  function updateResult(region, result, expectedRefresh) {
    if (!resolveChoice || expectedRefresh !== refreshGeneration) return;
    results = [...results.filter(item => item.id !== region.id), result];
    render();
  }

  function probeOptions(controller, expectedRefresh) {
    return {
      fetchImpl,
      WebSocketImpl,
      now,
      pingTimeoutMs,
      gapMs: pingGapMs,
      signal: controller.signal,
      onProbeStatus: (region, result) => updateResult(region, result, expectedRefresh),
      onPingSample: (region, sample, result) => updateResult(
        region, { ...result, rttMs: sample }, expectedRefresh,
      ),
    };
  }

  async function refreshRegions() {
    if (!resolveChoice) return [];
    const expectedRefresh = ++refreshGeneration;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    refreshing = true;
    refreshButton.disabled = true;
    refreshButton.setAttribute('aria-busy', 'true');
    statusMessage.textContent = 'Refreshing both regions…';
    render();

    try {
      const refreshed = await probeRegions(probeTargets, probeOptions(controller, expectedRefresh));
      if (!resolveChoice || expectedRefresh !== refreshGeneration) return refreshed;
      results = refreshed;
      if (!selectedId) selectedId = selectedRegionId(results);
      render();
      const unavailable = refreshed.filter(result => !result.online);
      statusMessage.textContent = unavailable.length
        ? unavailable.map(result => `${result.name}: ${result.reason}`).join(' ')
        : '';
      return refreshed;
    } catch (error) {
      if (error?.name === 'AbortError' && expectedRefresh !== refreshGeneration) return [];
      throw error;
    } finally {
      if (expectedRefresh === refreshGeneration) {
        activeController = null;
        refreshing = false;
        refreshButton.disabled = false;
        refreshButton.setAttribute('aria-busy', 'false');
        render();
      }
    }
  }

  function reportRefreshFailure(error) {
    statusMessage.textContent = `Unable to refresh regions: ${error.message}`;
    console.error('region picker refresh failed', error);
  }

  async function confirmSelection() {
    if (!resolveChoice || !selectedId || confirmButton.disabled) return;
    const expectedChoice = generation;
    const expectedRefresh = ++refreshGeneration;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    refreshing = true;
    confirmButton.disabled = true;
    refreshButton.disabled = true;
    refreshButton.setAttribute('aria-busy', 'true');
    const selectedRegion = probeTargets.find(region => region.id === selectedId);
    let pingSamples = 0;
    showConnectionProgress(16, `Checking ${selectedRegion.name}…`);
    render();

    try {
      const latest = await probeRegion(selectedRegion, {
        ...probeOptions(controller, expectedRefresh),
        onProbeStatus: result => {
          updateResult(selectedRegion, result, expectedRefresh);
          showConnectionProgress(30, `Checking the connection to ${selectedRegion.name}…`);
        },
        onPingSample: (sample, result) => {
          updateResult(selectedRegion, { ...result, rttMs: sample }, expectedRefresh);
          pingSamples++;
          const progress = 30 + Math.round(18 * Math.min(1, pingSamples / RTT_SAMPLES));
          showConnectionProgress(progress, `Checking the connection to ${selectedRegion.name}…`);
        },
      });
      if (!resolveChoice || expectedChoice !== generation
        || expectedRefresh !== refreshGeneration) return;
      results = [...results.filter(result => result.id !== selectedId), latest];
      render();
      if (!latest.online) {
        clearConnectionProgress(`${selectedRegion.name}: ${latest.reason}`);
        return;
      }
      store.set(REGION_STORE_KEY, selectedId);
      finishChoice(selectedId, null, { closeDialog: false });
    } catch (error) {
      if (error?.name === 'AbortError' && expectedRefresh !== refreshGeneration) return;
      finishChoice(null, error);
    } finally {
      if (expectedRefresh === refreshGeneration) {
        activeController = null;
        refreshing = false;
        refreshButton.disabled = false;
        refreshButton.setAttribute('aria-busy', 'false');
        render();
      }
    }
  }

  confirmButton.addEventListener('click', confirmSelection);
  cancelButton.addEventListener('click', () => finishChoice(null));
  refreshButton.addEventListener('click', () => refreshRegions().catch(reportRefreshFailure));
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (holdingForConnect) return;
    finishChoice(null);
  });

  function chooseRegion() {
    if (resolveChoice) return Promise.reject(new Error('A region choice is already open.'));
    const savedId = store.get(REGION_STORE_KEY);
    holdingForConnect = false;
    lastRegionClick = null;
    selectedId = regions.some(region => region.id === savedId) ? savedId : null;
    results = [];
    clearConnectionProgress();
    render();
    dialog.showModal();

    generation++;
    const choice = new Promise((resolve, reject) => {
      resolveChoice = resolve;
      rejectChoice = reject;
    });
    refreshRegions().catch(reportRefreshFailure);
    return choice;
  }

  function close() {
    if (resolveChoice) {
      finishChoice(null);
      return;
    }
    holdingForConnect = false;
    clearConnectionProgress();
    dialog.close();
    render();
  }

  function stop() {
    close();
  }

  render();
  return {
    chooseRegion,
    refreshRegions,
    selectedRegion: () => selectedId,
    isHoldingForConnect: () => holdingForConnect,
    setConnectionState,
    close,
    stop,
  };
}

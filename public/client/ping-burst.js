import { PING_BURST_GAP_MS, RTT_SAMPLES } from '../../shared/constants.js';

export function startPingBurst(sendPing, {
  count = RTT_SAMPLES,
  gapMs = PING_BURST_GAP_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (typeof sendPing !== 'function') throw new TypeError('sendPing must be a function');
  if (!Number.isSafeInteger(count) || count < 1) throw new RangeError('count must be a positive integer');
  if (!Number.isFinite(gapMs) || gapMs < 0) throw new RangeError('gapMs must be non-negative');

  let sent = 0;
  let timer = null;
  let cancelled = false;

  const sendNext = () => {
    if (cancelled) return;
    timer = null;
    sendPing();
    sent++;
    if (sent < count) timer = setTimeoutImpl(sendNext, gapMs);
  };

  sendNext();
  return () => {
    cancelled = true;
    if (timer !== null) {
      clearTimeoutImpl(timer);
      timer = null;
    }
  };
}

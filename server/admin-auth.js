import crypto from 'node:crypto';
import { sameSecret } from './config.js';

export const ADMIN_SESSION_TTL_MS = 30 * 60_000;
const FAILURE_LIMIT = 5;
const FAILURE_WINDOW_MS = 15 * 60_000;
const LOCK_MS = 15 * 60_000;
const MAX_TRACKED_ADDRESSES = 1000;
const MAX_SESSIONS = 8;

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

export function createAdminAuth({
  accounts,
  adminName = 'cobusvw',
  password = '',
  sessionTtlMs = ADMIN_SESSION_TTL_MS,
  failureLimit = FAILURE_LIMIT,
  failureWindowMs = FAILURE_WINDOW_MS,
  lockMs = LOCK_MS,
  now = Date.now,
} = {}) {
  const enabled = !!accounts?.checkDevice && !!password;
  const sessions = new Map();
  const failures = new Map();
  const expectedName = String(adminName).trim().toLowerCase();

  function sweep(at) {
    for (const [key, expiresAt] of sessions) {
      if (expiresAt <= at) sessions.delete(key);
    }
    for (const [ip, attempt] of failures) {
      if (attempt.lockedUntil <= at && at - attempt.startedAt >= failureWindowMs) failures.delete(ip);
    }
  }

  function fail(ip, at) {
    let attempt = failures.get(ip);
    if (!attempt || at - attempt.startedAt >= failureWindowMs) {
      attempt = { count: 0, startedAt: at, lockedUntil: 0 };
    }
    attempt.count++;
    if (attempt.count >= failureLimit) {
      attempt.count = 0;
      attempt.startedAt = at;
      attempt.lockedUntil = at + lockMs;
    }
    failures.set(ip, attempt);
    if (failures.size > MAX_TRACKED_ADDRESSES) {
      for (const [key, value] of failures) {
        if (value.lockedUntil <= at && at - value.startedAt >= failureWindowMs) failures.delete(key);
        if (failures.size <= MAX_TRACKED_ADDRESSES) break;
      }
      while (failures.size > MAX_TRACKED_ADDRESSES) failures.delete(failures.keys().next().value);
    }
  }

  function login({ name, deviceToken, password: givenPassword, ip } = {}) {
    if (!enabled) return { ok: false };
    const at = now();
    sweep(at);
    const address = typeof ip === 'string' && ip ? ip.slice(0, 128) : 'unknown';
    const attempt = failures.get(address);
    if (attempt?.lockedUntil > at) {
      return { ok: false, retryAfterMs: attempt.lockedUntil - at };
    }

    const normalizedName = typeof name === 'string' ? name.trim().toLowerCase() : '';
    const authorized = normalizedName === expectedName
      && accounts.checkDevice(expectedName, deviceToken)
      && sameSecret(givenPassword, password);
    if (!authorized) {
      fail(address, at);
      return { ok: false };
    }

    failures.delete(address);
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(digest(token), at + sessionTtlMs);
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    return { ok: true, token };
  }

  function check(token) {
    if (!enabled || typeof token !== 'string' || token.length !== 43) return false;
    const at = now();
    const key = digest(token);
    const expiresAt = sessions.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= at) { sessions.delete(key); return false; }
    return true;
  }

  function logout(token) {
    if (typeof token !== 'string' || token.length !== 43) return false;
    return sessions.delete(digest(token));
  }

  return Object.freeze({ enabled, login, check, logout });
}

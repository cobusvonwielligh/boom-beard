/**
 * Validate the same account credentials before region selection and again at the game socket.
 * The socket check remains authoritative; this first check keeps invalid passwords out of the
 * region picker and provides the trusted token the selected region will accept.
 */
export async function authenticateAccount(accounts, name, { password = null, trust = null } = {}) {
  if (!accounts) throw new TypeError('account authentication requires an account store');

  if (trust && await accounts.checkDevice(name, trust)) {
    return { ok: true, trust: null };
  }

  if (!await accounts.has(name)) {
    if (!password) {
      return { ok: false, auth: 'signup', why: `pick a password for "${name}"` };
    }
    const registered = await accounts.register(name, password);
    if (!registered.ok) {
      return { ok: false, auth: 'signup', why: registered.why };
    }
    return { ok: true, trust: registered.token, registered: true };
  }

  if (!password) {
    return { ok: false, auth: 'need', why: `"${name}" needs its password` };
  }

  const waitMs = await accounts.lockedFor(name);
  if (waitMs) return { ok: false, auth: 'wait', why: 'too many attempts', waitMs };

  const checked = await accounts.verify(name, password);
  if (!checked.ok) {
    return {
      ok: false,
      auth: checked.why === 'too many attempts' ? 'wait' : 'bad',
      why: checked.why,
      ...(checked.waitMs ? { waitMs: checked.waitMs } : null),
    };
  }
  return { ok: true, trust: checked.token };
}

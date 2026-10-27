export function signupDigits(count, width = 5) {
  if (!Number.isSafeInteger(count) || count < 0) return '-'.repeat(width);
  return String(count).padStart(width, '0');
}

export async function fetchSignupCount(fetcher = fetch) {
  try {
    const res = await fetcher('/signup-count', { cache: 'no-store' });
    if (!res?.ok) return null;
    const count = (await res.json())?.count;
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

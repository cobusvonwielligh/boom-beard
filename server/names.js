// Identity and language policy shared by the socket boundary and the authoritative room.

/**
 * One canonical key for names. NFKC closes compatibility-character loopholes, whitespace is
 * collapsed, and locale-independent lowercasing makes case variants the same identity.
 */
export const nameKey = value => String(value ?? '')
  .normalize('NFKC')
  .trim()
  .replace(/\s+/gu, ' ')
  .toLowerCase();

/* Deliberately narrow: severe racial, ethnic and homophobic slurs plus the strongest Afrikaans
 * sexual abuse. Ordinary swearing is not here — fuck/shit and fok/kak are explicitly allowed.
 * Patterns are generated with separators permitted between letters, so punctuation is not an
 * escape hatch, while word boundaries avoid matching innocent longer words. */
const BLOCKED = [
  'nigger', 'nigga', 'faggot', 'kike', 'chink', 'wetback',
  'kaffer', 'kafir', 'hotnot', 'hottentot', 'koelie', 'moffie', 'poes',
];

const leetFold = value => String(value ?? '')
  .normalize('NFKD')
  .replace(/\p{M}/gu, '')
  .toLowerCase()
  .replace(/[@4]/g, 'a')
  .replace(/3/g, 'e')
  .replace(/[!1|]/g, 'i')
  .replace(/0/g, 'o')
  .replace(/[5$]/g, 's')
  .replace(/7/g, 't');

const escaped = BLOCKED.map(word => word.split('').join('[^a-z]*')).join('|');
const BLOCKED_RE = new RegExp(`(?:^|[^a-z])(?:${escaped})(?:$|[^a-z])`, 'i');

export const hasBlockedLanguage = value => BLOCKED_RE.test(leetFold(value));

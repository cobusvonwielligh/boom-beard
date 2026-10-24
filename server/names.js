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
 * sexual abuse. Ordinary swearing is not here - fuck/shit and fok/kak are explicitly allowed.
 * Patterns are generated with separators permitted between letters, so punctuation is not an
 * escape hatch, while word boundaries avoid matching innocent longer words. */
const BLOCKED = [
  // English: slurs, then the two words that are stronger than ordinary swearing.
  'nigger', 'nigga', 'faggot', 'fagot', 'kike', 'chink', 'wetback', 'spic', 'gook',
  'coon', 'paki', 'raghead', 'towelhead', 'tranny', 'retard', 'retarded', 'cunt',
  // Afrikaans: apartheid-era racial slurs, then the strongest sexual abuse.
  // Not here on purpose: fok, kak, bliksem, naai, poephol - ordinary swearing, and `hoer`,
  // because stripping the diaeresis off the perfectly innocent `hoër` lands on it.
  'kaffer', 'kafir', 'kafferboetie', 'hotnot', 'hottentot', 'koelie', 'boesman',
  'moffie', 'poes', 'doos', 'piel', 'slet',
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

/**
 * Chat keeps the sentence and loses the word: every blocked word becomes `***`.
 *
 * Blocking the whole message was the old behaviour and it taught nothing - the sender saw
 * "message blocked", the room saw silence, and the second attempt was the same word with a dot
 * in it. A starred word is visible moderation: the joke survives, the slur does not.
 *
 * Masking is per whitespace-separated word, so the stars land where the word was. The folding
 * in `leetFold` changes string length (NFKD, leet digits), which makes index-accurate masking of
 * the original impossible - hence word-at-a-time. A word spread across spaces ("n i g g e r")
 * leaves nothing for any single token to match, so the whole line goes: the re-test after
 * masking is what catches it.
 *
 * Names still get rejected outright rather than starred. A name is an identity other players
 * address, and `***` is not one.
 */
export const maskBlockedLanguage = value => {
  const masked = String(value ?? '')
    .split(/(\s+)/u)
    .map(part => (hasBlockedLanguage(part) ? '***' : part))
    .join('');
  return hasBlockedLanguage(masked) ? '***' : masked;
};

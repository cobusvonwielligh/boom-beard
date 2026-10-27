export const playerIdKey = region => region === 'za' ? 'bv.playerId' : `bv.playerId.${region}`;

const normalizedName = name => String(name ?? '').trim().toLowerCase();

export const trustKey = (_region, name) => `bv.trust.${normalizedName(name)}`;

export const legacyTrustKey = (region, name) => region === 'us'
  ? `bv.trust.us.${normalizedName(name)}`
  : trustKey(region, name);

export function readTrustToken(store, region, name) {
  const key = trustKey(region, name);
  const shared = store.get(key);
  if (shared) return shared;
  const legacyKey = legacyTrustKey(region, name);
  if (legacyKey === key) return null;
  const legacy = store.get(legacyKey);
  if (legacy) store.set(key, legacy);
  return legacy || null;
}

export const playerIdKey = region => region === 'za' ? 'bv.playerId' : `bv.playerId.${region}`;

export const trustKey = (region, name) => region === 'za'
  ? `bv.trust.${String(name ?? '').trim().toLowerCase()}`
  : `bv.trust.${region}.${String(name ?? '').trim().toLowerCase()}`;

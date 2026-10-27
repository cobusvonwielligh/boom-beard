export const REGIONS = Object.freeze([
  Object.freeze({
    id: 'za',
    name: 'South Africa',
    flag: '🇿🇦',
    origin: 'https://boombeard.co.za',
  }),
  Object.freeze({
    id: 'us',
    name: 'North America',
    flag: '🇺🇸',
    origin: 'https://us.boombeard.co.za',
  }),
]);

export function regionIdForOrigin(origin) {
  const hostname = new URL(origin).hostname;
  return REGIONS.find(region => new URL(region.origin).hostname === hostname)?.id ?? 'za';
}

export function regionOrigin(regionId, currentOrigin) {
  const region = REGIONS.find(item => item.id === regionId);
  if (!region) throw new RangeError(`unknown region: ${regionId}`);
  const current = new URL(currentOrigin);
  if (regionId === 'za'
    && ['localhost', '127.0.0.1', '::1'].includes(current.hostname)) {
    return current.origin;
  }
  return region.origin;
}

export function transportUrls(origin) {
  const base = new URL(origin);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new TypeError('unsupported region protocol');
  }
  const secure = base.protocol === 'https:';
  return {
    ws: `${secure ? 'wss:' : 'ws:'}//${base.host}/ws`,
    wt: secure ? `https://${base.host}/wt` : null,
  };
}

import { createRequire } from 'node:module';
import { feature } from 'topojson-client';
import countries from 'i18n-iso-countries';

const require = createRequire(import.meta.url);
const topology = require('world-atlas/countries-110m.json');
const MAP_WIDTH = 960, MAP_HEIGHT = 480;

function project([longitude, latitude]) {
  const x = ((longitude + 180) / 360) * MAP_WIDTH;
  const y = ((90 - latitude) / 180) * MAP_HEIGHT;
  return `${x.toFixed(1)},${y.toFixed(1)}`;
}

function ringPath(ring) {
  if (!ring.length) return '';
  return `M${project(ring[0])}${ring.slice(1).map(point => `L${project(point)}`).join('')}Z`;
}

function geometryPath(geometry) {
  if (geometry.type === 'Polygon') {
    return geometry.coordinates.map(ringPath).join('');
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.flatMap(polygon => polygon.map(ringPath)).join('');
  }
  return '';
}

const WORLD_FEATURES = feature(topology, topology.objects.countries).features
  .map(item => {
    const numeric = String(item.id ?? '').padStart(3, '0');
    const country = countries.numericToAlpha2(numeric)
      ?? countries.getAlpha2Code(item.properties?.name ?? '', 'en');
    const path = geometryPath(item.geometry);
    if (!country || !path) return null;
    return Object.freeze({
      country,
      name: countries.getName(country, 'en') ?? item.properties?.name ?? country,
      path,
    });
  })
  .filter(Boolean);

export function worldMapFeatures() {
  return WORLD_FEATURES;
}

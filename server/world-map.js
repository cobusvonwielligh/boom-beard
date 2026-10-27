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

function ringOutlinePath(ring) {
  if (!ring.length) return '';
  const points = ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]
    ? ring
    : [...ring, ring[0]];
  let path = `M${project(points[0])}`;
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1];
    const point = points[i];
    path += `${Math.abs(point[0] - previous[0]) > 180 ? 'M' : 'L'}${project(point)}`;
  }
  return path;
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

function geometryOutlinePath(geometry) {
  if (geometry.type === 'Polygon') {
    return geometry.coordinates.map(ringOutlinePath).join('');
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.flatMap(polygon => polygon.map(ringOutlinePath)).join('');
  }
  return '';
}

const WORLD_FEATURES = feature(topology, topology.objects.countries).features
  .map(item => {
    const numeric = String(item.id ?? '').padStart(3, '0');
    const country = countries.numericToAlpha2(numeric)
      ?? countries.getAlpha2Code(item.properties?.name ?? '', 'en');
    const path = geometryPath(item.geometry);
    const outlinePath = geometryOutlinePath(item.geometry);
    if (!country || !path || !outlinePath) return null;
    return Object.freeze({
      country,
      name: countries.getName(country, 'en') ?? item.properties?.name ?? country,
      path,
      outlinePath,
    });
  })
  .filter(Boolean);

export function worldMapFeatures() {
  return WORLD_FEATURES;
}

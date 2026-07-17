import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import proj4 from 'proj4';
import { fromFile } from 'geotiff';

const OSM_FILE = new URL('../frasnelli-osm-map.xml', import.meta.url);
const DTM_FINE_FILE = new URL('../frasnelli-dtm-20cm.tif', import.meta.url);
const DTM_BASE_FILE = new URL('../frasnelli-dtm-50cm.tif', import.meta.url);
const OUTPUT_FILE = new URL('../src/generated/terrain-data.js', import.meta.url);
const TRACK_WAY_ID = '208383998';
const START_NODE_ID = '2186826134';
const UTM32 = '+proj=utm +zone=32 +ellps=GRS80 +units=m +no_defs';

const xml = fs.readFileSync(OSM_FILE, 'utf8');
const attr = (text, key) => text.match(new RegExp(`${key}="([^"]+)"`))?.[1];
const nodes = new Map();
for (const match of xml.matchAll(/<node\b([^>]*)>/g)) {
  const id = attr(match[1], 'id');
  const lat = Number(attr(match[1], 'lat'));
  const lon = Number(attr(match[1], 'lon'));
  if (id && Number.isFinite(lat) && Number.isFinite(lon)) nodes.set(id, { lat, lon });
}
const way = xml.match(new RegExp(`<way\\s+id="${TRACK_WAY_ID}"[^>]*>([\\s\\S]*?)<\\/way>`));
if (!way) throw new Error(`OSM-Way ${TRACK_WAY_ID} nicht gefunden`);
let refs = Array.from(way[1].matchAll(/<nd ref="(\d+)"\/>/g), m => m[1]);
if (refs[0] === refs.at(-1)) refs = refs.slice(0, -1);
let projected = refs.map(id => {
  const node = nodes.get(id);
  if (!node) throw new Error(`OSM-Knoten ${id} fehlt`);
  const [e, n] = proj4('EPSG:4326', UTM32, [node.lon, node.lat]);
  return { id, e, n };
});

// Rotate the closed list so sample zero is the mapped start/finish line. The
// OSM order agrees with the direction arrow in Frasnelli's published plan.
const startAt = projected.findIndex(p => p.id === START_NODE_ID);
if (startAt < 0) throw new Error('Start-/Ziellinie fehlt im OSM-Streckenverlauf');
projected = [...projected.slice(startAt), ...projected.slice(0, startAt)];

function polylineLength(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    sum += Math.hypot(b.e - a.e, b.n - a.n);
  }
  return sum;
}

function resampleClosed(points, spacing = 1) {
  const segments = [];
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const length = Math.hypot(b.e - a.e, b.n - a.n);
    segments.push({ a, b, start: total, length }); total += length;
  }
  const count = Math.round(total / spacing);
  const samples = [];
  let segmentIndex = 0;
  for (let i = 0; i < count; i++) {
    const distance = i / count * total;
    while (segmentIndex < segments.length - 1 && distance > segments[segmentIndex].start + segments[segmentIndex].length) segmentIndex++;
    const segment = segments[segmentIndex];
    const t = Math.max(0, Math.min(1, (distance - segment.start) / segment.length));
    samples.push({ e: segment.a.e + (segment.b.e - segment.a.e) * t, n: segment.a.n + (segment.b.n - segment.a.n) * t });
  }
  return { samples, total };
}

const { samples: route, total: osmLength } = resampleClosed(projected, 1);
const centerE = route.reduce((sum, p) => sum + p.e, 0) / route.length;
const centerN = route.reduce((sum, p) => sum + p.n, 0) / route.length;

async function loadCoverage(url) {
  const tiff = await fromFile(fileURLToPath(url));
  const image = await tiff.getImage();
  return {
    raster: await image.readRasters({ interleave: true }),
    width: image.getWidth(), height: image.getHeight(), bbox: image.getBoundingBox(),
    noData: Number(image.getGDALNoData() ?? -9999),
  };
}
const fine = await loadCoverage(DTM_FINE_FILE);
const base = await loadCoverage(DTM_BASE_FILE);
const [minE, minN, maxE, maxN] = fine.bbox;

function sampleCoverage(coverage, e, n) {
  const [west, south, east, north] = coverage.bbox;
  const px = (e - west) / (east - west) * (coverage.width - 1);
  const py = (north - n) / (north - south) * (coverage.height - 1);
  if (px < 0 || py < 0 || px >= coverage.width - 1 || py >= coverage.height - 1) return NaN;
  const x0 = Math.floor(px), y0 = Math.floor(py), tx = px - x0, ty = py - y0;
  const at = (x, y) => Number(coverage.raster[y * coverage.width + x]);
  const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
  if (![a,b,c,d].every(v => Number.isFinite(v) && Math.abs(v - coverage.noData) > .01 && v > -1000)) return NaN;
  return a * (1-tx) * (1-ty) + b * tx * (1-ty) + c * (1-tx) * ty + d * tx * ty;
}
const sampleFine = (e, n) => sampleCoverage(fine, e, n);
const sampleDtm = (e, n) => {
  const highResolution = sampleFine(e, n);
  return Number.isFinite(highResolution) ? highResolution : sampleCoverage(base, e, n);
};

let routeHeights = route.map((p, i) => {
  const prev = route[(i - 2 + route.length) % route.length], next = route[(i + 2) % route.length];
  const dx = next.e - prev.e, dz = next.n - prev.n, length = Math.hypot(dx, dz) || 1;
  const rx = -dz / length, rz = dx / length;
  const heights = [-1.2, 0, 1.2].map(offset => sampleDtm(p.e + rx * offset, p.n + rz * offset)).filter(Number.isFinite).sort((a,b) => a-b);
  return heights.length ? heights[Math.floor(heights.length / 2)] : NaN;
});
const validRouteHeights = routeHeights.filter(Number.isFinite).sort((a,b) => a-b);
const fineRouteCount = route.filter(p => Number.isFinite(sampleFine(p.e, p.n))).length;
console.log(`DTM bbox: ${minE.toFixed(1)},${minN.toFixed(1)} – ${maxE.toFixed(1)},${maxN.toFixed(1)}; Raster fein ${fine.width}x${fine.height}, Basis ${base.width}x${base.height}`);
console.log(`Strecke bbox: ${Math.min(...route.map(p=>p.e)).toFixed(1)},${Math.min(...route.map(p=>p.n)).toFixed(1)} – ${Math.max(...route.map(p=>p.e)).toFixed(1)},${Math.max(...route.map(p=>p.n)).toFixed(1)}; gültig ${validRouteHeights.length}/${routeHeights.length}`);
if (validRouteHeights.length < routeHeights.length * .9) throw new Error('Zu viele ungültige DTM-Werte entlang der Strecke');
const baseHeight = validRouteHeights[Math.floor(validRouteHeights.length / 2)];
for (let i = 0; i < routeHeights.length; i++) if (!Number.isFinite(routeHeights[i])) routeHeights[i] = baseHeight;
routeHeights = routeHeights.map((_, i) => {
  let weighted = 0, weights = 0;
  for (let k = -3; k <= 3; k++) {
    const weight = 4 - Math.abs(k);
    weighted += routeHeights[(i + k + routeHeights.length) % routeHeights.length] * weight; weights += weight;
  }
  return weighted / weights;
});

function smoothCircular(values) {
  return values.map((_, i) => {
    let weighted = 0, weights = 0;
    for (let k = -3; k <= 3; k++) {
      const weight = 4 - Math.abs(k);
      weighted += values[(i + k + values.length) % values.length] * weight; weights += weight;
    }
    return weighted / weights;
  });
}

function sampleRoadEdge(offset) {
  const values = route.map((p, i) => {
    const prev = route[(i - 2 + route.length) % route.length], next = route[(i + 2) % route.length];
    const dx = next.e - prev.e, dz = next.n - prev.n, length = Math.hypot(dx, dz) || 1;
    // Geographic right-hand normal. Game Z is -north below, so this becomes
    // (-tangent.z, tangent.x) in Three.js and keeps right turns on screen-right.
    const rx = dz / length, rz = -dx / length;
    const height = sampleDtm(p.e + rx * offset, p.n + rz * offset);
    return Number.isFinite(height) ? height : routeHeights[i];
  });
  return smoothCircular(values);
}
const leftEdgeHeights = sampleRoadEdge(-3.5);
const rightEdgeHeights = sampleRoadEdge(3.5);

const terrainWidth = 256;
const terrainHeight = 212;
const terrainValues = [];
for (let row = 0; row < terrainHeight; row++) {
  // Row zero maps to max game-Z. Because game Z is -north, that is minN.
  const n = minN + row / (terrainHeight - 1) * (maxN - minN);
  for (let col = 0; col < terrainWidth; col++) {
    const e = minE + col / (terrainWidth - 1) * (maxE - minE);
    const h = sampleDtm(e, n);
    terrainValues.push(Number.isFinite(h) ? Math.round((h - baseHeight) * 100) / 100 : 0);
  }
}

const trackPoints = route.map((p, i) => ({
  x: Math.round((p.e - centerE) * 1000) / 1000,
  y: Math.round((routeHeights[i] - baseHeight) * 1000) / 1000,
  // Three.js uses -Z as forward. Negating north preserves the map's handedness
  // so the first corner in the official direction is a right-hander.
  z: Math.round((centerN - p.n) * 1000) / 1000,
  l: Math.round((leftEdgeHeights[i] - baseHeight) * 1000) / 1000,
  r: Math.round((rightEdgeHeights[i] - baseHeight) * 1000) / 1000,
}));
const terrain = {
  width: terrainWidth,
  height: terrainHeight,
  minX: Math.round((minE - centerE) * 1000) / 1000,
  maxX: Math.round((maxE - centerE) * 1000) / 1000,
  minZ: Math.round((centerN - maxN) * 1000) / 1000,
  maxZ: Math.round((centerN - minN) * 1000) / 1000,
  baseElevation: Math.round(baseHeight * 1000) / 1000,
  values: terrainValues,
};

fs.mkdirSync(new URL('../src/generated/', import.meta.url), { recursive: true });
const output = `// Generated from Autonome Provinz Bozen DTM 0.2 m (Etsch 2024) and OSM way ${TRACK_WAY_ID}.\n` +
  `export const GEO_TRACK_LENGTH = ${osmLength.toFixed(3)};\n` +
  `export const GEO_TRACK_POINTS = ${JSON.stringify(trackPoints)};\n` +
  `export const TERRAIN_DATA = ${JSON.stringify(terrain)};\n`;
fs.writeFileSync(OUTPUT_FILE, output);

const minTrack = Math.min(...routeHeights), maxTrack = Math.max(...routeHeights);
console.log(`OSM-Strecke: ${osmLength.toFixed(1)} m, ${trackPoints.length} Samples`);
console.log(`DTM: ${fineRouteCount}/${route.length} Streckenpunkte aus 20 cm, Rest aus 50 cm; Höhenbasis ${baseHeight.toFixed(3)} m`);
console.log(`Strecken-Höhenbereich: ${(maxTrack-minTrack).toFixed(3)} m (${minTrack.toFixed(3)}–${maxTrack.toFixed(3)} m)`);
console.log(`Terrain-Ausgabe: ${terrainWidth} x ${terrainHeight}`);

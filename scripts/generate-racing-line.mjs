import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { GEO_TRACK_LENGTH, GEO_TRACK_POINTS } from '../src/generated/terrain-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(here, '../src/generated/racing-line-data.js');
const ROAD_WIDTH = 9;
const KART_HALF_WIDTH = .705;
const SAFETY_MARGIN = .32;
const MAX_OFFSET = ROAD_WIDTH / 2 - KART_HALF_WIDTH - SAFETY_MARGIN;
const n = GEO_TRACK_POINTS.length;

const mod = value => (value % n + n) % n;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const center = GEO_TRACK_POINTS.map(p => ({ x: p.x, y: p.y, z: p.z }));
const normals = center.map((_, i) => {
  const before = center[mod(i - 3)];
  const after = center[mod(i + 3)];
  const dx = after.x - before.x;
  const dz = after.z - before.z;
  const length = Math.hypot(dx, dz) || 1;
  return { x: -dz / length, z: dx / length };
});

function pointAt(i, offsets) {
  const p = center[mod(i)];
  const normal = normals[mod(i)];
  const offset = offsets[mod(i)];
  return { x: p.x + normal.x * offset, z: p.z + normal.z * offset };
}

// Projected minimum-curvature solver. Each iteration reduces the squared
// second derivative of the path, while the box constraint keeps the N35 and a
// safety margin inside the road. Multi-scale passes remove 1 m survey noise
// before refining the apex positions.
function optimizeOffsets() {
  let offsets = new Float64Array(n);
  let velocity = new Float64Array(n);
  for (const radius of [12, 7, 4, 2]) {
    for (let iteration = 0; iteration < 900; iteration++) {
      const gradient = new Float64Array(n);
      const second = new Array(n);
      for (let i = 0; i < n; i++) {
        const a = pointAt(i - radius, offsets);
        const b = pointAt(i, offsets);
        const c = pointAt(i + radius, offsets);
        second[i] = { x: a.x - 2 * b.x + c.x, z: a.z - 2 * b.z + c.z };
      }
      for (let i = 0; i < n; i++) {
        const before = second[mod(i - radius)];
        const current = second[i];
        const after = second[mod(i + radius)];
        const gx = 2 * (before.x - 2 * current.x + after.x);
        const gz = 2 * (before.z - 2 * current.z + after.z);
        gradient[i] = (gx * normals[i].x + gz * normals[i].z) / (radius * radius * radius)
          + offsets[i] * .000025;
      }
      const learningRate = radius >= 7 ? .18 : radius >= 4 ? .10 : .045;
      for (let i = 0; i < n; i++) {
        velocity[i] = velocity[i] * .86 + gradient[i] * learningRate;
        offsets[i] = clamp(offsets[i] - velocity[i], -MAX_OFFSET, MAX_OFFSET);
      }
    }
    // Preserve the solution but reset optimizer momentum between length scales.
    velocity = new Float64Array(n);
  }

  // Smooth tiny offset steps without washing out the full-width corner entry
  // and apex choices made by the solver.
  for (let pass = 0; pass < 40; pass++) {
    const next = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      next[i] = clamp(
        offsets[mod(i - 2)] * .08 + offsets[mod(i - 1)] * .22 + offsets[i] * .40
          + offsets[mod(i + 1)] * .22 + offsets[mod(i + 2)] * .08,
        -MAX_OFFSET,
        MAX_OFFSET,
      );
    }
    offsets = next;
  }
  return offsets;
}

function heightAtOffset(i, offset) {
  const p = GEO_TRACK_POINTS[i];
  const edgeHeight = offset < 0 ? p.l : p.r;
  return p.y + (edgeHeight - p.y) * Math.min(1, Math.abs(offset) / (ROAD_WIDTH / 2));
}

function signedCurvature(points, i, radius = 3) {
  const a = points[mod(i - radius)];
  const b = points[i];
  const c = points[mod(i + radius)];
  const abx = b.x - a.x, abz = b.z - a.z;
  const bcx = c.x - b.x, bcz = c.z - b.z;
  const acx = c.x - a.x, acz = c.z - a.z;
  const denominator = Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(acx, acz);
  return denominator > 1e-6 ? 2 * (abx * bcz - abz * bcx) / denominator : 0;
}

const offsets = optimizeOffsets();
const points = center.map((p, i) => ({
  x: p.x + normals[i].x * offsets[i],
  y: heightAtOffset(i, offsets[i]) + .105,
  z: p.z + normals[i].z * offsets[i],
  offset: offsets[i],
}));
const segmentLength = points.map((p, i) => {
  const q = points[mod(i + 1)];
  return Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
});
const lineLength = segmentLength.reduce((sum, value) => sum + value, 0);
// A 15 m chord matches the corner-planning horizon of a human driver and keeps
// centimetre-scale survey/offset detail from becoming a fictitious steering
// input or speed restriction.
const curvature = points.map((_, i) => {
  const longHorizon = signedCurvature(points, i, 15);
  const shortHorizon = signedCurvature(points, i, 5) * .75;
  return Math.abs(shortHorizon) > Math.abs(longHorizon) ? shortHorizon : longHorizon;
});

// 70 kg reference driver in the 140 kg N35. These limits intentionally match
// the simulator's hard rental tire, rear-only brake and GX390-like powertrain.
const g = 9.81;
const lateralMu = 1.05;
const topSpeed = 72.5 / 3.6;
const accelerationAt = speed => Math.max(.12, 2.10 * (1 - (speed / topSpeed) ** 2));
const brakingAt = speed => 4.50 - .035 * Math.min(speed, 18);
const speeds = curvature.map(kappa => Math.min(topSpeed, Math.sqrt(lateralMu * g / Math.max(Math.abs(kappa), .0015))));

// Circular forward/backward propagation produces a physically reachable speed
// envelope instead of treating every bend independently.
for (let pass = 0; pass < 80; pass++) {
  for (let i = 0; i < n; i++) {
    const j = mod(i + 1);
    const grade = (points[j].y - points[i].y) / Math.max(segmentLength[i], .1);
    const acceleration = Math.max(.05, accelerationAt(speeds[i]) - g * grade);
    speeds[j] = Math.min(speeds[j], Math.sqrt(Math.max(0, speeds[i] ** 2 + 2 * acceleration * segmentLength[i])));
  }
  for (let k = n - 1; k >= 0; k--) {
    const j = mod(k + 1);
    const grade = (points[j].y - points[k].y) / Math.max(segmentLength[k], .1);
    const braking = Math.max(2.8, brakingAt(speeds[j]) + g * grade);
    speeds[k] = Math.min(speeds[k], Math.sqrt(Math.max(0, speeds[j] ** 2 + 2 * braking * segmentLength[k])));
  }
}

let lapTime = 0;
for (let i = 0; i < n; i++) {
  const j = mod(i + 1);
  lapTime += 2 * segmentLength[i] / Math.max(speeds[i] + speeds[j], 1);
}

const result = points.map((point, i) => {
  const j = mod(i + 1);
  const requiredAcceleration = (speeds[j] ** 2 - speeds[i] ** 2) / Math.max(2 * segmentLength[i], .1);
  let mode = 'coast', throttle = 0, brake = 0;
  if (requiredAcceleration < -.22) {
    mode = 'brake';
    brake = clamp(-requiredAcceleration / brakingAt(speeds[i]), 0, 1);
  } else if (requiredAcceleration > .10 && speeds[i] < topSpeed - .15) {
    mode = 'accel';
    throttle = clamp(requiredAcceleration / Math.max(accelerationAt(speeds[i]), .1), .15, 1);
  }
  return {
    x: Number(point.x.toFixed(3)),
    y: Number(point.y.toFixed(3)),
    z: Number(point.z.toFixed(3)),
    offset: Number(point.offset.toFixed(3)),
    curvature: Number(curvature[i].toFixed(5)),
    speed: Number((speeds[i] * 3.6).toFixed(2)),
    throttle: Number(throttle.toFixed(3)),
    brake: Number(brake.toFixed(3)),
    mode,
  };
});

const output = `// Generated numerical minimum-curvature racing line for the georeferenced Frasnelli course.\n`
  + `export const RACING_LINE_REFERENCE_WEIGHT = 70;\n`
  + `export const RACING_LINE_LENGTH = ${lineLength.toFixed(3)};\n`
  + `export const RACING_LINE_LAP_TIME = ${lapTime.toFixed(3)};\n`
  + `export const RACING_LINE_POINTS = ${JSON.stringify(result)};\n`;
await writeFile(outputPath, output, 'utf8');

const brakingPoints = result.filter(point => point.mode === 'brake').length;
const accelerationPoints = result.filter(point => point.mode === 'accel').length;
console.log(`Rennlinie: ${lineLength.toFixed(1)} m, Sollzeit ${lapTime.toFixed(3)} s, ${brakingPoints} Brems- und ${accelerationPoints} Beschleunigungsmeter, Rand ${MAX_OFFSET.toFixed(2)} m.`);

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { KART_MODEL } from '../src/kart.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const sourcePath = resolve(projectRoot, '.ai-training/human-best.json');
const outputPath = resolve(projectRoot, 'src/generated/reference-ghost-data.js');
const human = JSON.parse(await readFile(sourcePath, 'utf8'));

if (!Number.isFinite(human?.time) || !Array.isArray(human?.points) || human.points.length < 100) {
  throw new Error('Keine gültige menschliche Bestlinie für den Referenz-Ghost gefunden.');
}

const rounded = (value, digits = 4) => Number(value.toFixed(digits));
const points = human.points;
const segmentTimes = [];
let calculatedTime = 0;
for (let index = 0; index < points.length; index++) {
  const point = points[index];
  const next = points[(index + 1) % points.length];
  const distance = Math.hypot(next.x - point.x, next.y - point.y, next.z - point.z);
  const speedMs = Math.max(2, ((point.speed || 0) + (next.speed || 0)) / 7.2);
  const segmentTime = distance / speedMs;
  segmentTimes.push(segmentTime);
  calculatedTime += segmentTime;
}
if (!Number.isFinite(calculatedTime) || calculatedTime <= 0) throw new Error('Referenz-Ghost besitzt kein gültiges Zeitprofil.');

const samples = [];
const timeScale = human.time / calculatedTime;
let time = 0;
for (let index = 0; index < points.length; index++) {
  const point = points[index];
  const before = points[(index - 2 + points.length) % points.length];
  const after = points[(index + 2) % points.length];
  const dx = after.x - before.x;
  const dy = after.y - before.y;
  const dz = after.z - before.z;
  const horizontal = Math.hypot(dx, dz) || 1;
  const heading = Math.atan2(-dx, -dz);
  const pitch = Math.atan2(dy, horizontal);
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, heading, 0, 'YXZ'));
  const steerInput = Number.isFinite(point.steer) ? point.steer : 0;
  samples.push([
    rounded(time, 3), rounded(point.x, 3), rounded(point.y, 3), rounded(point.z, 3),
    rounded(quaternion.x), rounded(quaternion.y), rounded(quaternion.z), rounded(quaternion.w),
    rounded(steerInput * KART_MODEL.maxSteer), rounded(steerInput * Math.PI * .75), rounded(point.speed || 0, 2),
  ]);
  time += segmentTimes[index] * timeScale;
}

const reference = {
  version: 1,
  publicReference: true,
  time: rounded(human.time, 3),
  driverWeight: Number(human.driverWeight) || 70,
  samples,
};
const output = `// Generated public reference ghost. Contains no name, device id or timestamp.\nexport const REFERENCE_GHOST = ${JSON.stringify(reference)};\n`;
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, output, 'utf8');
console.log(`Referenz-Ghost erstellt: ${reference.time.toFixed(3)} s, ${samples.length} Punkte.`);

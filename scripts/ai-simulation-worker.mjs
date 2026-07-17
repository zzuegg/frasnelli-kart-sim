import { parentPort, workerData } from 'node:worker_threads';
import * as THREE from 'three';
import { createKart, KartPhysics } from '../src/kart.js';
import { RacingDriver } from '../src/ai-driver.js';
import { TrackData, ROAD_WIDTH } from '../src/track.js';
import { GEO_TRACK_POINTS } from '../src/generated/terrain-data.js';

const referencePoints = workerData.referencePoints;
const maximumOffsetAllowed = workerData.maximumOffsetAllowed ?? ROAD_WIDTH / 2 - .78;
const simulationDriverWeight = workerData.simulationDriverWeight ?? 70;
const sampleCount = GEO_TRACK_POINTS.length;
const dt = 1 / 120;
const mod = value => (value % sampleCount + sampleCount) % sampleCount;

function interpolatedControl(controls, index, fallback) {
  if (!controls?.length) return fallback;
  const phase = index / sampleCount * controls.length;
  const sector = Math.floor(phase) % controls.length;
  const blend = phase - Math.floor(phase);
  const smoothBlend = blend * blend * (3 - 2 * blend);
  return THREE.MathUtils.lerp(controls[sector], controls[(sector + 1) % controls.length], smoothBlend);
}

function applyPhysicalSpeedEnvelope(points) {
  const speeds = points.map(point => Math.min(
    point.speed / 3.6,
    Math.sqrt(11.9 / Math.max(Math.abs(point.curvature), .0001)),
    72.5 / 3.6,
  ));
  for (let pass = 0; pass < 5; pass++) {
    for (let index = points.length - 1; index >= 0; index--) {
      const next = mod(index + 1);
      const distance = Math.max(.05, Math.hypot(points[next].x - points[index].x, points[next].z - points[index].z));
      speeds[index] = Math.min(speeds[index], Math.sqrt(speeds[next] ** 2 + 2 * 6.8 * distance));
    }
    for (let index = 0; index < points.length; index++) {
      const next = mod(index + 1);
      const distance = Math.max(.05, Math.hypot(points[next].x - points[index].x, points[next].z - points[index].z));
      speeds[next] = Math.min(speeds[next], Math.sqrt(speeds[index] ** 2 + 2 * 2.6 * distance));
    }
  }
  points.forEach((point, index) => { point.speed = speeds[index] * 3.6; });
}

function scaledReference(lineScale = 1, speedMultipliers = null, lineAdjustments = null, preserveRecordedCoordinates = false, precomputedSpeedProfile = false) {
  const points = referencePoints.map((reference, index) => {
    const before = GEO_TRACK_POINTS[mod(index - 3)];
    const after = GEO_TRACK_POINTS[mod(index + 3)];
    const tangentLength = Math.hypot(after.x - before.x, after.z - before.z) || 1;
    const rightX = -(after.z - before.z) / tangentLength;
    const rightZ = (after.x - before.x) / tangentLength;
    const center = GEO_TRACK_POINTS[index];
    const recordedOffset = reference.offset || 0;
    const offset = recordedOffset * lineScale + interpolatedControl(lineAdjustments, index, 0);
    const speedFactor = interpolatedControl(speedMultipliers, index, 1);
    const x = preserveRecordedCoordinates ? reference.x + rightX * (offset - recordedOffset) : center.x + rightX * offset;
    const z = preserveRecordedCoordinates ? reference.z + rightZ * (offset - recordedOffset) : center.z + rightZ * offset;
    return { ...reference, x, z, offset, speed: Math.min(72.5, reference.speed * speedFactor) };
  });
  for (let index = 0; index < sampleCount; index++) {
    const a = points[mod(index - 5)], b = points[index], c = points[mod(index + 5)];
    const abx = b.x - a.x, abz = b.z - a.z;
    const bcx = c.x - b.x, bcz = c.z - b.z;
    const acx = c.x - a.x, acz = c.z - a.z;
    const denominator = Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(acx, acz);
    points[index].curvature = denominator > 1e-6 ? 2 * (abx * bcz - abz * bcx) / denominator : 0;
  }
  if (precomputedSpeedProfile) applyPhysicalSpeedEnvelope(points);
  return points;
}

function makeTrack() {
  const samples = GEO_TRACK_POINTS.map(point => ({
    point: new THREE.Vector3(point.x, point.y, point.z),
    leftHeight: point.l,
    rightHeight: point.r,
  }));
  const tangent = samples[2].point.clone().sub(samples.at(-2).point).normalize();
  return new TrackData(samples, 0, Math.atan2(-tangent.x, -tangent.z));
}

function simulate(config) {
  const track = makeTrack();
  const physics = new KartPhysics(track, createKart());
  physics.setDriverWeight(simulationDriverWeight);
  const points = scaledReference(config.lineScale ?? 1, config.speedMultipliers, config.lineAdjustments, config.driverMode === 'recorded', config.precomputedSpeedProfile);
  const driver = new RacingDriver({ ...config, points });
  const laps = [];
  let impacts = 0;
  let maximumOffset = 0;
  let maximumOffsetIndex = 0;
  let firstImpactIndex = null;
  physics.onImpact = () => {
    impacts++;
    if (firstImpactIndex === null) firstImpactIndex = physics.trackPose?.index ?? 0;
  };
  physics.onLap = result => {
    laps.push({ ...result, impacts, maximumOffset, maximumOffsetIndex, firstImpactIndex });
    impacts = 0;
    maximumOffset = 0;
    maximumOffsetIndex = 0;
    firstImpactIndex = null;
  };

  for (let step = 0; step < 120 * 260 && laps.length < 2; step++) {
    const input = driver.update(dt, physics);
    physics.update(dt, input);
    if (Math.abs(physics.trackPose.signedDistance) > maximumOffset) {
      maximumOffset = Math.abs(physics.trackPose.signedDistance);
      maximumOffsetIndex = physics.trackPose.index;
    }
  }
  const flyingLap = laps[1] ?? null;
  const valid = Boolean(flyingLap?.valid && flyingLap.impacts === 0 && flyingLap.maximumOffset <= maximumOffsetAllowed);
  const failureIndex = flyingLap?.firstImpactIndex ?? flyingLap?.maximumOffsetIndex ?? firstImpactIndex ?? maximumOffsetIndex;
  return { config, valid, lap: flyingLap?.time ?? Infinity, flyingLap, failureIndex };
}

parentPort.on('message', ({ id, config }) => {
  try {
    parentPort.postMessage({ id, result: simulate(config) });
  } catch (error) {
    parentPort.postMessage({ id, error: error?.stack || String(error) });
  }
});

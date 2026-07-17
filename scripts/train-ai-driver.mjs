import { access, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { cpus } from 'node:os';
import { Worker } from 'node:worker_threads';
import * as THREE from 'three';
import { createKart, KartPhysics } from '../src/kart.js';
import { RacingDriver } from '../src/ai-driver.js';
import { TrackData, ROAD_WIDTH } from '../src/track.js';
import { GEO_TRACK_POINTS } from '../src/generated/terrain-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const liveOutputPath = resolve(here, '../src/generated/racing-line-data.js');
const shadowDirectory = resolve(here, '../.ai-training');
const globalSearch = process.argv.includes('--global') || process.env.AI_GLOBAL === '1';
const globalExploration = THREE.MathUtils.clamp(Number(process.env.AI_GLOBAL_EXPLORATION) || 1, .5, 4);
const shadowOutputPath = resolve(shadowDirectory, globalSearch ? 'global-racing-line-data.js' : 'racing-line-data.js');
const useShadow = globalSearch || process.argv.includes('--shadow') || process.env.AI_SHADOW === '1';
if (useShadow) {
  await mkdir(shadowDirectory, { recursive: true });
  try { await access(shadowOutputPath); }
  catch { await copyFile(liveOutputPath, shadowOutputPath); }
}
const outputPath = useShadow ? shadowOutputPath : liveOutputPath;
const currentRacingData = await import(`${pathToFileURL(outputPath).href}?training=${Date.now()}`);
const sampleCount = GEO_TRACK_POINTS.length;
const mod = value => (value % sampleCount + sampleCount) % sampleCount;
const isStoredGlobalPolicy = currentRacingData.RACING_LINE_SOURCE?.startsWith('global-physics-')
  && Array.isArray(currentRacingData.RACING_POLICY_POINTS);
const hasStoredPolicy = globalSearch ? isStoredGlobalPolicy : Array.isArray(currentRacingData.RACING_POLICY_POINTS);

function globalReferencePoints() {
  const curvature = GEO_TRACK_POINTS.map((point, index) => {
    const before = GEO_TRACK_POINTS[mod(index - 5)];
    const after = GEO_TRACK_POINTS[mod(index + 5)];
    const abx = point.x - before.x, abz = point.z - before.z;
    const bcx = after.x - point.x, bcz = after.z - point.z;
    const acx = after.x - before.x, acz = after.z - before.z;
    const denominator = Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(acx, acz);
    return denominator > 1e-6 ? 2 * (abx * bcz - abz * bcx) / denominator : 0;
  });
  return GEO_TRACK_POINTS.map((point, index) => {
    let maximumCurvature = 0;
    for (let step = -2; step <= 2; step++) maximumCurvature = Math.max(maximumCurvature, Math.abs(curvature[mod(index + step)]));
    const speed = THREE.MathUtils.clamp(Math.sqrt(11.8 / Math.max(maximumCurvature, .0017)) * 3.6, 25, 72.5);
    return {
      x: point.x,
      y: point.y + .025,
      z: point.z,
      offset: 0,
      curvature: curvature[index],
      speed,
      throttle: 0,
      brake: 0,
      mode: 'coast',
    };
  });
}

let humanSeed = null;
try { if (!globalSearch) {
  const candidate = JSON.parse(await readFile(resolve(shadowDirectory, 'human-best.json'), 'utf8'));
  const matchingPointCount = Array.isArray(candidate.points)
    && candidate.points.length === currentRacingData.RACING_LINE_POINTS.length;
  if (matchingPointCount && Number.isFinite(candidate.time) && candidate.time < currentRacingData.RACING_LINE_LAP_TIME) {
    humanSeed = candidate;
  }
} } catch {}
const referencePoints = globalSearch
  ? isStoredGlobalPolicy ? currentRacingData.RACING_POLICY_POINTS : globalReferencePoints()
  : humanSeed?.points
  ?? currentRacingData.RACING_POLICY_POINTS
  ?? currentRacingData.RACING_LINE_POINTS;
const simulationDriverWeight = Number(humanSeed?.driverWeight) || 70;
const maximumOffsetAllowed = globalSearch ? ROAD_WIDTH / 2 + .7 : humanSeed ? ROAD_WIDTH / 2 + .7 : ROAD_WIDTH / 2 - .78;
const dt = 1 / 120;

class SimulationPool {
  constructor(size) {
    this.queue = [];
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.states = Array.from({ length: size }, () => {
      const worker = new Worker(new URL('./ai-simulation-worker.mjs', import.meta.url), {
        type: 'module',
        workerData: { referencePoints, maximumOffsetAllowed, simulationDriverWeight },
      });
      const state = { worker, busy: false };
      worker.on('message', message => {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        state.busy = false;
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
        this.pump();
      });
      worker.on('error', error => {
        state.busy = false;
        for (const [id, pending] of this.pending) {
          if (pending.state === state) {
            this.pending.delete(id);
            pending.reject(error);
          }
        }
        this.pump();
      });
      return state;
    });
  }

  run(config) {
    if (this.closed) return Promise.reject(new Error('SimulationPool ist bereits geschlossen.'));
    return new Promise((resolve, reject) => {
      this.queue.push({ config, resolve, reject });
      this.pump();
    });
  }

  runMany(configs) { return Promise.all(configs.map(config => this.run(config))); }

  pump() {
    for (const state of this.states) {
      if (state.busy || !this.queue.length) continue;
      const job = this.queue.shift();
      const id = this.nextId++;
      state.busy = true;
      this.pending.set(id, { ...job, state });
      state.worker.postMessage({ id, config: job.config });
    }
  }

  async close() {
    this.closed = true;
    await Promise.all(this.states.map(state => state.worker.terminate()));
  }
}

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

function makeBuckets() {
  return Array.from({ length: sampleCount }, () => ({
    count: 0, x: 0, y: 0, z: 0, speed: 0, throttle: 0, brake: 0, steer: 0, offset: 0,
  }));
}

function simulate(config, captureTrajectory = false) {
  const track = makeTrack();
  const physics = new KartPhysics(track, createKart());
  physics.setDriverWeight(simulationDriverWeight);
  const preserveRecordedCoordinates = config.driverMode === 'recorded';
  const driver = new RacingDriver({ ...config, points: scaledReference(config.lineScale ?? 1, config.speedMultipliers, config.lineAdjustments, preserveRecordedCoordinates, config.precomputedSpeedProfile) });
  const buckets = captureTrajectory ? makeBuckets() : null;
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
    if (buckets && physics.lap === 1) {
      const bucket = buckets[physics.trackPose.index];
      bucket.count++;
      bucket.x += physics.position.x;
      bucket.y += physics.position.y + .025;
      bucket.z += physics.position.z;
      bucket.speed += physics.speedKmh();
      bucket.throttle += input.throttle;
      bucket.brake += input.brake;
      bucket.steer += input.steer;
      bucket.offset += physics.trackPose.signedDistance;
    }
  }

  const flyingLap = laps[1] ?? null;
  const valid = Boolean(flyingLap?.valid && flyingLap.impacts === 0 && flyingLap.maximumOffset <= maximumOffsetAllowed);
  const failureIndex = flyingLap?.firstImpactIndex ?? flyingLap?.maximumOffsetIndex ?? firstImpactIndex ?? maximumOffsetIndex;
  return { config, valid, lap: flyingLap?.time ?? Infinity, flyingLap, failureIndex, buckets };
}

const learnedSource = globalSearch || Boolean(humanSeed) || currentRacingData.RACING_LINE_SOURCE === 'ai-physics';
const hasRecordedSteer = referencePoints.some(point => Number.isFinite(point.steer));
const aggressiveIteration = hasStoredPolicy || Boolean(humanSeed);
const paces = learnedSource
  ? aggressiveIteration ? [.90, 1.0, 1.08, 1.16] : [.65, .75, .85, .95]
  : [.76, .79, .82, .85, .88];
const previews = [
  { previewBase: 4.8, previewGain: .36 },
  { previewBase: 5.6, previewGain: .43 },
  { previewBase: 6.5, previewGain: .43 },
  { previewBase: 6.5, previewGain: .52 },
  { previewBase: 7.4, previewGain: .48 },
];
const activePreviews = learnedSource ? previews.slice(1, 4) : previews;
const steeringScales = learnedSource ? [.90, 1.05] : [.72, .80, .88];
const steeringGrips = learnedSource ? [.95, 1.15, 1.32] : [.88];
const recordedSteerVariants = learnedSource
  ? [
      { recordedSteerBlend: 1, limitRecordedSteer: false },
      { recordedSteerBlend: .70, limitRecordedSteer: true },
      { recordedSteerBlend: .45, limitRecordedSteer: true },
    ]
  : [{ recordedSteerBlend: 1, limitRecordedSteer: false }];
const brakingRamps = learnedSource
  ? [...new Set([currentRacingData.RACING_LINE_DRIVER_CONFIG?.brakingRamp ?? .72, .72, .86])]
  : [.82];
const lineScales = learnedSource
  ? aggressiveIteration ? [.70, .85, 1.0] : [.40, .60, .80, 1.0]
  : [1.0];
const candidates = [];
if (globalSearch) {
  for (const pace of [.58, .68, .78, .88, .98]) {
    for (const preview of previews) {
      for (const steeringScale of [.72, .86, 1.0]) {
        for (const steeringGrip of [.90, 1.08]) {
          for (const brakingRamp of [.68, .90, 1.16, 1.45, 1.75]) {
            candidates.push({
              driverMode: 'speed',
              pace,
              lineScale: 1,
              ...preview,
              steeringScale,
              steeringGrip,
              steeringRate: 2.35,
              brakingRamp,
              precomputedSpeedProfile: false,
              physicsLimitedSteering: false,
              recordedSteerBlend: 0,
              limitRecordedSteer: true,
            });
          }
        }
      }
    }
  }
  if (hasStoredPolicy) {
    const storedConfig = { ...currentRacingData.RACING_LINE_DRIVER_CONFIG, driverMode: 'speed', lineScale: 1, precomputedSpeedProfile: false, physicsLimitedSteering: false };
    candidates.push(storedConfig);
    for (const pace of [.94, 1, 1.04, 1.08]) candidates.push({ ...storedConfig, pace });
    for (const brakingRamp of [.9, 1.15, 1.4, 1.7, 2.0]) {
      for (const pace of [.60, .70, .80, .90, 1]) candidates.push({ ...storedConfig, pace, brakingRamp });
    }

    // A mature path can be limited by the tracking controller rather than its
    // geometry. Probe small one-dimensional changes first, then a compact set
    // of coupled controller variants. The seed is the previous AI population,
    // never a player's trajectory.
    const storedPreviewBase = storedConfig.previewBase ?? 4.8;
    const storedPreviewGain = storedConfig.previewGain ?? .36;
    const storedHeadingGain = storedConfig.headingGain ?? .72;
    const storedCrossTrackGain = storedConfig.crossTrackGain ?? 1.55;
    const storedSpeedPreviewBase = storedConfig.speedPreviewBase ?? 12;
    const storedSpeedPreviewGain = storedConfig.speedPreviewGain ?? .9;
    const storedSteeringRate = storedConfig.steeringRate ?? 2.35;
    const localVariants = [
      ['previewBase', [storedPreviewBase - .9, storedPreviewBase - .45, storedPreviewBase - .2, storedPreviewBase + .2, storedPreviewBase + .45, storedPreviewBase + .9]],
      ['previewGain', [storedPreviewGain - .09, storedPreviewGain - .045, storedPreviewGain - .02, storedPreviewGain + .02, storedPreviewGain + .045, storedPreviewGain + .09]],
      ['headingGain', [storedHeadingGain * .65, storedHeadingGain * .82, storedHeadingGain * .92, storedHeadingGain * 1.08, storedHeadingGain * 1.2, storedHeadingGain * 1.4]],
      ['crossTrackGain', [storedCrossTrackGain * .55, storedCrossTrackGain * .75, storedCrossTrackGain * .9, storedCrossTrackGain * 1.1, storedCrossTrackGain * 1.3, storedCrossTrackGain * 1.55]],
      ['speedPreviewBase', [storedSpeedPreviewBase - 4, storedSpeedPreviewBase - 2, storedSpeedPreviewBase + 2, storedSpeedPreviewBase + 4, storedSpeedPreviewBase + 7]],
      ['speedPreviewGain', [storedSpeedPreviewGain - .24, storedSpeedPreviewGain - .12, storedSpeedPreviewGain + .12, storedSpeedPreviewGain + .24, storedSpeedPreviewGain + .4]],
      ['steeringRate', [storedSteeringRate * .75, storedSteeringRate * .9, storedSteeringRate * 1.1, storedSteeringRate * 1.25, storedSteeringRate * 1.45]],
    ];
    for (const [key, values] of localVariants) {
      for (const value of values) candidates.push({ ...storedConfig, [key]: Math.max(.05, value) });
    }

    let controllerState = 0x9e3779b9;
    const controllerRandom = () => {
      controllerState = (Math.imul(controllerState, 1664525) + 1013904223) >>> 0;
      return controllerState / 4294967296;
    };
    const around = (value, spread, minimum = .05) => Math.max(minimum, value * (1 + (controllerRandom() * 2 - 1) * spread));
    for (let trial = 0; trial < 160; trial++) {
      candidates.push({
        ...storedConfig,
        previewBase: around(storedPreviewBase, .16, 3.5),
        previewGain: around(storedPreviewGain, .22),
        headingGain: around(storedHeadingGain, .38),
        crossTrackGain: around(storedCrossTrackGain, .42),
        speedPreviewBase: around(storedSpeedPreviewBase, .34, 5),
        speedPreviewGain: around(storedSpeedPreviewGain, .34, .2),
        steeringRate: around(storedSteeringRate, .25, 1.2),
        brakingRamp: around(storedConfig.brakingRamp ?? .9, .18, .45),
      });
    }
  }
} else if (humanSeed) {
  const uniqueReplayCandidates = new Map();
  for (const recordedHeadingGain of [0, .08, .16, .28, .45]) {
    for (const recordedCrossTrackGain of [0, .12, .28, .5, .8]) {
      for (const recordedCorrectionLimit of [0, .12, .25, .4]) {
        for (const recordedSteerScale of [.96, 1, 1.04]) {
          for (const recordedBrakeGain of [0, .025, .06]) {
            const config = {
              driverMode: 'recorded',
              pace: 1,
              lineScale: 1,
              recordedHeadingGain,
              recordedCrossTrackGain,
              recordedCorrectionLimit,
              recordedSteerScale,
              recordedThrottleGain: 0,
              recordedBrakeGain,
            };
            uniqueReplayCandidates.set(JSON.stringify(config), config);
          }
        }
      }
    }
  }
  candidates.push(...uniqueReplayCandidates.values());
} else {
  for (const pace of paces) {
    for (const lineScale of lineScales) {
      for (const preview of activePreviews) {
        for (const steeringScale of steeringScales) {
          for (const steeringGrip of steeringGrips) {
            for (const brakingRamp of brakingRamps) {
              for (const recordedVariant of recordedSteerVariants) {
                candidates.push({ pace, lineScale, ...preview, steeringScale, steeringGrip, steeringRate: 2.15, brakingRamp, ...recordedVariant });
              }
            }
          }
        }
      }
    }
  }
}

let best = null;
let validTrials = 0;
const logicalCpus = Math.max(1, cpus().length);
const requestedWorkers = Number(process.env.AI_WORKERS);
const workerCount = Number.isFinite(requestedWorkers) && requestedWorkers > 0
  ? Math.min(Math.floor(requestedWorkers), Math.max(1, logicalCpus - 1))
  : Math.max(1, Math.min(8, logicalCpus - 2));
const pool = new SimulationPool(workerCount);
if (humanSeed) {
  console.log(`Fahrer-Seed aktiv: ${humanSeed.time.toFixed(3)} s mit ${humanSeed.points.length} Streckenpunkten.`);
} else if (globalSearch) {
  console.log(`Globale Physiksuche aktiv: ohne Fahrerlinie, ${hasStoredPolicy ? 'beste KI-Population wird weiterentwickelt' : 'Start von der georeferenzierten Streckenmitte'}.`);
}
const initialResults = await pool.runMany(candidates);
for (const result of initialResults) {
  if (result.valid) {
    validTrials++;
    if (!best || result.lap < best.lap) best = result;
  }
}
if (!best) {
  await pool.close();
  throw new Error(`Keiner der ${candidates.length} KI-Piloten fuhr eine gültige fliegende Runde.`);
}

// Coordinate-descent learning of braking and acceleration by track sector.
// Every attempted change is accepted only after two full physics laps and only
// if the flying lap remains valid and becomes faster.
if (learnedSource) {
  const sectorCount = globalSearch ? 48 : 24;
  let optimizedConfig = {
    ...best.config,
    speedMultipliers: Array(sectorCount).fill(1),
    lineAdjustments: Array(sectorCount).fill(0),
  };
  let optimized = await pool.run(optimizedConfig);
  let learnedTrials = 0;

  // First let the pilots explore later/earlier turn-in and wider/tighter arcs.
  // Lateral controls are continuous and affect neighbouring sectors smoothly.
  for (let pass = 0; pass < 2; pass++) {
    for (let sector = 0; sector < sectorCount; sector++) {
      const base = optimizedConfig.lineAdjustments[sector];
      const deltas = globalSearch
        ? hasStoredPolicy
          ? (pass === 0 ? [-.24, -.12, .12, .24] : [-.055, .055]).map(delta => delta * globalExploration)
          : pass === 0 ? [-3.2, -1.6, 1.6, 3.2] : [-.8, .8]
        : pass === 0 ? [-1.0, -.5, .5, 1.0] : [-.30, .30];
      let sectorBest = optimized;
      let sectorConfig = optimizedConfig;
      const trialConfigs = [];
      for (const delta of deltas) {
        const lineAdjustments = [...optimizedConfig.lineAdjustments];
        lineAdjustments[sector] = THREE.MathUtils.clamp(base + delta, globalSearch ? -4.7 : -1.5, globalSearch ? 4.7 : 1.5);
        trialConfigs.push({ ...optimizedConfig, lineAdjustments });
      }
      const trialResults = await pool.runMany(trialConfigs);
      learnedTrials += trialResults.length;
      for (const result of trialResults) {
        if (result.valid && result.lap < sectorBest.lap) {
          sectorBest = result;
          sectorConfig = result.config;
        }
      }
      optimized = sectorBest;
      optimizedConfig = sectorConfig;
    }
  }

  // Then move braking and acceleration limits sector by sector on the line the
  // preceding physics runs actually proved driveable.
  for (let pass = 0; pass < 2; pass++) {
    for (let sector = 0; sector < sectorCount; sector++) {
      const base = optimizedConfig.speedMultipliers[sector];
      const factors = globalSearch
        ? hasStoredPolicy
          ? pass === 0 ? [base * .97, base * .988, base * 1.012, base * 1.028, base * 1.05] : [base * .994, base * 1.006, base * 1.014]
          : pass === 0 ? [.78, .90, 1.08, 1.24, 1.42] : [base * .92, base * 1.08, base * 1.16]
        : pass === 0 ? [1.12, 1.25, 1.40, 1.58] : [base * 1.08, base * 1.16];
      let sectorBest = optimized;
      let sectorConfig = optimizedConfig;
      const trialConfigs = [];
      for (const factor of factors) {
        const speedMultipliers = [...optimizedConfig.speedMultipliers];
        speedMultipliers[sector] = Math.min(1.85, factor);
        trialConfigs.push({ ...optimizedConfig, speedMultipliers });
      }
      const trialResults = await pool.runMany(trialConfigs);
      learnedTrials += trialResults.length;
      for (const result of trialResults) {
        if (result.valid && result.lap < sectorBest.lap) {
          sectorBest = result;
          sectorConfig = result.config;
        }
      }
      optimized = sectorBest;
      optimizedConfig = sectorConfig;
    }
  }

  // Start a second pilot flat-out and teach it braking only where the physics
  // actually reports an off-track excursion or impact. This explores the fast
  // side of the constraint boundary instead of only making a safe lap faster.
  if (!hasStoredPolicy) {
    let attackConfig = {
      ...optimizedConfig,
      pace: 1,
      speedMultipliers: Array(sectorCount).fill(1.58),
    };
    const failureCounts = Array(sectorCount).fill(0);
    for (let attempt = 0; attempt < 140; attempt++) {
      const attack = await pool.run(attackConfig);
      learnedTrials++;
      if (attack.valid) {
        if (attack.lap < optimized.lap) {
          optimized = attack;
          optimizedConfig = attackConfig;
        }
        break;
      }
      const failureIndex = Number.isFinite(attack.failureIndex) ? attack.failureIndex : 0;
      const sector = Math.floor(failureIndex / sampleCount * sectorCount) % sectorCount;
      failureCounts[sector]++;
      const speedMultipliers = [...attackConfig.speedMultipliers];
      speedMultipliers[sector] = Math.max(.62, speedMultipliers[sector] * .84);
      speedMultipliers[(sector - 1 + sectorCount) % sectorCount] = Math.max(.70, speedMultipliers[(sector - 1 + sectorCount) % sectorCount] * .94);
      if (failureCounts[sector] > 2) {
        speedMultipliers[(sector + 1) % sectorCount] = Math.max(.72, speedMultipliers[(sector + 1) % sectorCount] * .95);
      }
      attackConfig = { ...attackConfig, speedMultipliers };
    }
  }

  // Finally evolve combined line/speed policies. This allows coordinated
  // changes that a one-sector-at-a-time search cannot discover. Invalid but
  // promising pilots receive a continuous penalty, while only fully valid
  // laps can replace the displayed best trajectory.
  let randomState = globalSearch
    ? ((Number(process.env.AI_GLOBAL_SEED) || Date.now()) ^ process.pid) >>> 0
    : 0x35a17e21;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 4294967296;
  };
  const gaussian = () => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-9))) * Math.cos(Math.PI * 2 * random());
  const score = result => {
    if (!result.flyingLap) return Infinity;
    const edge = Math.max(0, result.flyingLap.maximumOffset - maximumOffsetAllowed);
    return result.lap + result.flyingLap.impacts * 8 + edge * 10 + (result.flyingLap.valid ? 0 : 8);
  };
  let elites = [{ config: optimizedConfig, result: optimized, score: score(optimized) }];
  const evolutionGenerations = globalSearch ? hasStoredPolicy ? 24 : 18 : 8;
  const populationSize = globalSearch ? hasStoredPolicy ? 128 : 96 : 48;
  for (let generation = 0; generation < evolutionGenerations; generation++) {
    const population = [...elites];
    const globalLineSigma = hasStoredPolicy ? .34 * globalExploration : 1.65;
    const globalSpeedSigma = hasStoredPolicy ? .09 * Math.sqrt(globalExploration) : .34;
    const lineSigma = (globalSearch ? globalLineSigma : .52) * (globalSearch ? .88 : .80) ** generation;
    const speedSigma = (globalSearch ? globalSpeedSigma : .20) * (globalSearch ? .90 : .82) ** generation;
    const mutationConfigs = [];
    while (population.length + mutationConfigs.length < populationSize) {
      const parent = elites[Math.floor(random() * elites.length)].config;
      let lineAdjustments;
      let speedMultipliers;
      if (globalSearch && hasStoredPolicy) {
        lineAdjustments = [...parent.lineAdjustments];
        speedMultipliers = [...parent.speedMultipliers];
        const mode = random();
        const mutateLine = mode < .72;
        const mutateSpeed = mode > .28;
        const smoothBumps = (controls, sigma, minimum, maximum, bumpCount) => {
          for (let bump = 0; bump < bumpCount; bump++) {
            const center = Math.floor(random() * controls.length);
            const radius = random() < .68 ? 1 : 2;
            const delta = gaussian() * sigma;
            for (let step = -radius; step <= radius; step++) {
              const weight = .5 + .5 * Math.cos(Math.PI * step / (radius + 1));
              const index = (center + step + controls.length) % controls.length;
              controls[index] = THREE.MathUtils.clamp(controls[index] + delta * weight, minimum, maximum);
            }
          }
        };
        if (mutateLine) smoothBumps(lineAdjustments, lineSigma, -4.8, 4.8, random() < .78 ? 1 : 2);
        if (mutateSpeed) smoothBumps(speedMultipliers, speedSigma, .48, 1.9, random() < .7 ? 1 : 2);
      } else {
        lineAdjustments = parent.lineAdjustments.map(value => random() < (globalSearch ? .62 : .38)
          ? THREE.MathUtils.clamp(value + gaussian() * lineSigma, globalSearch ? -4.8 : -1.7, globalSearch ? 4.8 : 1.7)
          : value);
        speedMultipliers = parent.speedMultipliers.map(value => random() < (globalSearch ? .58 : .42)
          ? THREE.MathUtils.clamp(value + gaussian() * speedSigma, globalSearch ? .48 : .72, 1.9)
          : value);
      }
      mutationConfigs.push({ ...parent, lineAdjustments, speedMultipliers });
    }
    const mutationResults = await pool.runMany(mutationConfigs);
    learnedTrials += mutationResults.length;
    for (const result of mutationResults) {
      population.push({ config: result.config, result, score: score(result) });
      if (result.valid && result.lap < optimized.lap) {
        optimized = result;
        optimizedConfig = result.config;
      }
    }
    population.sort((a, b) => a.score - b.score);
    elites = population.slice(0, globalSearch ? 10 : 6);
  }
  candidates.push(...Array(learnedTrials).fill(null));
  if (optimized.valid && optimized.lap < best.lap) best = optimized;
}

await pool.close();

if (learnedSource && hasStoredPolicy && best.lap >= currentRacingData.RACING_LINE_LAP_TIME - .001) {
  console.log(`KI-Training (${workerCount} Threads): ${candidates.length} Physikfahrten, ${validTrials} gültige Ausgangsvarianten. Beste neue Runde ${best.lap.toFixed(3)} s ist nicht schneller als ${currentRacingData.RACING_LINE_LAP_TIME.toFixed(3)} s; bestehende Bestlinie bleibt erhalten.`);
  process.exit(0);
}

const recorded = simulate(best.config, true);
if (!recorded.valid) throw new Error('Die Wiederholungsfahrt des schnellsten KI-Piloten war nicht gültig.');

const learnedPolicy = scaledReference(best.config.lineScale ?? 1, best.config.speedMultipliers, best.config.lineAdjustments, best.config.driverMode === 'recorded', best.config.precomputedSpeedProfile)
  .map(point => ({ ...point, speed: Math.min(72.5, point.speed * best.config.pace) }));

const raw = recorded.buckets.map((bucket, index) => {
  if (bucket.count) {
    return {
      x: bucket.x / bucket.count,
      y: bucket.y / bucket.count,
      z: bucket.z / bucket.count,
      speed: bucket.speed / bucket.count,
      throttle: bucket.throttle / bucket.count,
      brake: bucket.brake / bucket.count,
      steer: bucket.steer / bucket.count,
      offset: bucket.offset / bucket.count,
    };
  }
  const fallback = referencePoints[index];
  return { ...fallback, throttle: fallback.throttle || 0, brake: fallback.brake || 0, steer: Number.isFinite(fallback.steer) ? fallback.steer : 0 };
});

// Only average neighbouring samples of the recorded vehicle trajectory. This
// removes 120 Hz controller chatter; it does not invent or optimize a path.
const driven = raw.map((_, index) => {
  const weights = [1, 2, 3, 2, 1];
  let total = 0;
  const value = { x: 0, y: 0, z: 0, speed: 0, throttle: 0, brake: 0, steer: 0, offset: 0 };
  for (let k = -2; k <= 2; k++) {
    const weight = weights[k + 2];
    const point = raw[mod(index + k)];
    total += weight;
    for (const key of Object.keys(value)) value[key] += point[key] * weight;
  }
  for (const key of Object.keys(value)) value[key] /= total;
  return value;
});

function curvatureAt(index, radius = 5) {
  const a = driven[mod(index - radius)], b = driven[index], c = driven[mod(index + radius)];
  const abx = b.x - a.x, abz = b.z - a.z;
  const bcx = c.x - b.x, bcz = c.z - b.z;
  const acx = c.x - a.x, acz = c.z - a.z;
  const denominator = Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(acx, acz);
  return denominator > 1e-6 ? 2 * (abx * bcz - abz * bcx) / denominator : 0;
}

let lineLength = 0;
for (let i = 0; i < sampleCount; i++) {
  const next = driven[mod(i + 1)];
  lineLength += Math.hypot(next.x - driven[i].x, next.y - driven[i].y, next.z - driven[i].z);
}

const points = driven.map((point, index) => {
  const mode = point.brake > .055 ? 'brake' : point.throttle > .14 ? 'accel' : 'coast';
  return {
    x: Number(point.x.toFixed(3)),
    y: Number(point.y.toFixed(3)),
    z: Number(point.z.toFixed(3)),
    offset: Number(point.offset.toFixed(3)),
    curvature: Number(curvatureAt(index).toFixed(5)),
    speed: Number(point.speed.toFixed(2)),
    throttle: Number(point.throttle.toFixed(3)),
    brake: Number(point.brake.toFixed(3)),
    steer: Number(point.steer.toFixed(4)),
    mode,
  };
});

const exportedDriverConfig = {
  ...Object.fromEntries(Object.entries(best.config).filter(([key]) => key !== 'speedMultipliers' && key !== 'lineAdjustments' && key !== 'lineScale' && key !== 'pace')),
  brakingRamp: (best.config.brakingRamp ?? .82) * best.config.pace,
  pace: 1,
};

const output = `// Generated from the fastest valid flying lap driven by the full N35 physics AI.\n`
  + `export const RACING_LINE_SOURCE = '${globalSearch ? 'global-physics-v8' : 'ai-physics'}';\n`
  + `export const RACING_LINE_REFERENCE_WEIGHT = ${simulationDriverWeight};\n`
  + `export const RACING_LINE_TRIALS = ${candidates.length};\n`
  + `export const RACING_LINE_VALID_TRIALS = ${validTrials};\n`
  + `export const RACING_LINE_WORKERS = ${workerCount};\n`
  + `export const RACING_LINE_DRIVER_CONFIG = ${JSON.stringify(exportedDriverConfig)};\n`
  + `export const RACING_LINE_LENGTH = ${lineLength.toFixed(3)};\n`
  + `export const RACING_LINE_LAP_TIME = ${recorded.lap.toFixed(3)};\n`
  + `export const RACING_POLICY_POINTS = ${JSON.stringify(learnedPolicy)};\n`
  + `export const RACING_LINE_POINTS = ${JSON.stringify(points)};\n`;
const temporaryOutputPath = `${outputPath}.tmp`;
await writeFile(temporaryOutputPath, output, 'utf8');
await rename(temporaryOutputPath, outputPath);

console.log(`KI-Training (${workerCount} Threads): ${candidates.length} Piloten, ${validTrials} gültig. Schnellste fliegende Runde ${recorded.lap.toFixed(3)} s, Linie ${lineLength.toFixed(1)} m, max. Offset ${recorded.flyingLap.maximumOffset.toFixed(2)} m.`);

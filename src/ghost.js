import * as THREE from 'three';
import { createKart, KART_MODEL } from './kart.js';
import { REFERENCE_GHOST } from './generated/reference-ghost-data.js';

const GHOST_STORAGE_KEY = 'frasnelli-ghost-best-v1';
const GHOST_SETTINGS_KEY = 'frasnelli-ghost-settings-v1';
const HUMAN_BEST_KEY = 'frasnelli-human-best';
const SAMPLE_INTERVAL = 1 / 30;
const clamp = THREE.MathUtils.clamp;

function rounded(value, digits = 4) { return Number(value.toFixed(digits)); }

function validLap(lap) {
  return Number.isFinite(lap?.time)
    && lap.time > 20
    && lap.time < 300
    && Array.isArray(lap.samples)
    && lap.samples.length > 100
    && lap.samples.every(sample => Array.isArray(sample) && sample.length >= 11 && sample.every(Number.isFinite));
}

function ghostVisual() {
  const visual = createKart();
  visual.name = 'Persönlicher Bestzeit-Ghost';
  visual.visible = false;
  visual.traverse(object => {
    if (!object.isMesh) return;
    if (object.geometry?.type === 'PlaneGeometry') {
      object.visible = false;
      return;
    }
    object.castShadow = false;
    object.receiveShadow = false;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const ghostMaterials = materials.map(source => {
      const material = source.clone();
      if (material.color) material.color.set(0x47d9ff);
      if (material.emissive) material.emissive.set(0x0d7895);
      material.transparent = true;
      material.opacity = .34;
      material.depthWrite = false;
      material.side = THREE.DoubleSide;
      return material;
    });
    object.material = Array.isArray(object.material) ? ghostMaterials : ghostMaterials[0];
    object.renderOrder = 8;
  });
  return visual;
}

function orientationSample(physics, time) {
  const pitch = physics.trackPose ? Math.asin(clamp(physics.trackPose.tangent.y, -.2, .2)) : 0;
  const bank = physics.trackPose && Number.isFinite(physics.trackPose.bankAngle)
    ? clamp(physics.trackPose.bankAngle, -.12, .12)
    : 0;
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, physics.heading, bank, 'YXZ'));
  return [
    rounded(time, 3),
    rounded(physics.position.x, 3),
    rounded(physics.position.y, 3),
    rounded(physics.position.z, 3),
    rounded(quaternion.x), rounded(quaternion.y), rounded(quaternion.z), rounded(quaternion.w),
    rounded(physics.steerAngle), rounded(physics.wheelAngle), rounded(physics.speedKmh(), 2),
  ];
}

function migrateHumanLap() {
  let human;
  try { human = JSON.parse(localStorage.getItem(HUMAN_BEST_KEY)); } catch { return null; }
  if (!Number.isFinite(human?.time) || !Array.isArray(human?.points) || human.points.length < 100) return null;

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
  if (!Number.isFinite(calculatedTime) || calculatedTime <= 0) return null;

  const timeScale = human.time / calculatedTime;
  const samples = [];
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
  return { version: 1, time: human.time, driverWeight: human.driverWeight, recordedAt: human.recordedAt, migrated: true, samples };
}

export class LapGhost {
  constructor(scene) {
    this.visual = ghostVisual();
    scene.add(this.visual);
    this.reference = validLap(REFERENCE_GHOST) ? REFERENCE_GHOST : null;
    this.localBest = this.loadLocalBest();
    this.best = this.fastestGhost();
    const settings = this.loadSettings();
    this.enabled = settings.enabled ?? true;
    this.lead = clamp(Number(settings.lead) || 0, 0, 10);
    this.recording = [];
    this.recordAccumulator = 0;
    this.cursor = 0;
    this.lastPlaybackTime = -1;
    this.q0 = new THREE.Quaternion();
    this.q1 = new THREE.Quaternion();
  }

  fastestGhost() {
    if (!this.localBest) return this.reference;
    if (!this.reference) return this.localBest;
    return this.localBest.time < this.reference.time - .0005 ? this.localBest : this.reference;
  }

  get bestSource() { return this.best === this.localBest ? 'local' : 'reference'; }

  loadLocalBest() {
    try {
      const stored = JSON.parse(localStorage.getItem(GHOST_STORAGE_KEY));
      if (validLap(stored)) return stored;
    } catch {}
    const migrated = migrateHumanLap();
    if (!validLap(migrated)) return null;
    try { localStorage.setItem(GHOST_STORAGE_KEY, JSON.stringify(migrated)); } catch {}
    return migrated;
  }

  loadSettings() {
    try { return JSON.parse(localStorage.getItem(GHOST_SETTINGS_KEY)) ?? {}; }
    catch { return {}; }
  }

  saveSettings() {
    try { localStorage.setItem(GHOST_SETTINGS_KEY, JSON.stringify({ enabled: this.enabled, lead: this.lead })); } catch {}
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.saveSettings();
    if (!this.enabled) this.visual.visible = false;
  }

  setLead(seconds) {
    this.lead = clamp(Number(seconds) || 0, 0, 10);
    this.saveSettings();
    this.lastPlaybackTime = -1;
  }

  resetRecording(physics) {
    this.recording = physics ? [orientationSample(physics, 0)] : [];
    this.recordAccumulator = 0;
  }

  capture(dt, physics, force = false, forcedTime = null) {
    this.recordAccumulator += dt;
    if (!force && this.recordAccumulator < SAMPLE_INTERVAL) return;
    this.recordAccumulator %= SAMPLE_INTERVAL;
    const time = forcedTime ?? physics.lapTime;
    const previous = this.recording.at(-1);
    if (previous && time <= previous[0] + .0005) return;
    this.recording.push(orientationSample(physics, time));
  }

  finish(time, valid, physics) {
    this.capture(0, physics, true, time);
    const isBest = valid && this.recording.length > 100 && (!this.localBest || time < this.localBest.time - .0005);
    let saved = false;
    let lap = null;
    if (isBest) {
      lap = {
        version: 1,
        time: rounded(time, 3),
        driverWeight: physics.driverWeight,
        recordedAt: new Date().toISOString(),
        samples: this.recording,
      };
      try {
        localStorage.setItem(GHOST_STORAGE_KEY, JSON.stringify(lap));
        this.localBest = lap;
        saved = true;
      } catch {}
    }
    const previousBest = this.best;
    this.best = this.fastestGhost();
    this.resetRecording(physics);
    this.cursor = 0;
    this.lastPlaybackTime = -1;
    return saved && this.best === lap && this.best !== previousBest;
  }

  resetPlayback() {
    this.cursor = 0;
    this.lastPlaybackTime = -1;
  }

  playAt(playbackTime, dt, target = this.visual) {
    const lap = this.best;
    if (!lap || playbackTime < 0 || playbackTime > lap.time) {
      if (target === this.visual) target.visible = false;
      return null;
    }
    const restarted = playbackTime < this.lastPlaybackTime;
    if (restarted) this.cursor = 0;
    this.lastPlaybackTime = playbackTime;
    while (this.cursor < lap.samples.length - 2 && lap.samples[this.cursor + 1][0] <= playbackTime) this.cursor++;
    while (this.cursor > 0 && lap.samples[this.cursor][0] > playbackTime) this.cursor--;

    const a = lap.samples[this.cursor];
    const b = lap.samples[Math.min(this.cursor + 1, lap.samples.length - 1)];
    const blend = b[0] > a[0] ? clamp((playbackTime - a[0]) / (b[0] - a[0]), 0, 1) : 0;
    target.position.set(
      THREE.MathUtils.lerp(a[1], b[1], blend),
      THREE.MathUtils.lerp(a[2], b[2], blend),
      THREE.MathUtils.lerp(a[3], b[3], blend),
    );
    this.q0.set(a[4], a[5], a[6], a[7]).normalize();
    this.q1.set(b[4], b[5], b[6], b[7]).normalize();
    target.quaternion.copy(this.q0).slerp(this.q1, blend);

    const steerAngle = THREE.MathUtils.lerp(a[8], b[8], blend);
    const wheelAngle = THREE.MathUtils.lerp(a[9], b[9], blend);
    const speedKmh = THREE.MathUtils.lerp(a[10], b[10], blend);
    const speedMs = speedKmh / 3.6;
    const data = target.userData;
    data.frontPivots?.forEach(pivot => { pivot.rotation.y = steerAngle; });
    if (data.steeringWheel) data.steeringWheel.rotation.z = wheelAngle;
    if (restarted || playbackTime <= dt + .001) data.wheelRotation = 0;
    data.wheelRotation -= speedMs * dt / .145;
    data.wheelHubs?.forEach(wheel => { wheel.rotation.x = data.wheelRotation; });
    target.visible = true;
    return { playbackTime, speedKmh, steerAngle, wheelAngle, finished: playbackTime >= lap.time };
  }

  update(physics, dt) {
    const playbackTime = physics.lapTime + this.lead;
    if (!this.enabled || !this.best || playbackTime > this.best.time) {
      this.visual.visible = false;
      return null;
    }
    return this.playAt(playbackTime, dt, this.visual);
  }
}

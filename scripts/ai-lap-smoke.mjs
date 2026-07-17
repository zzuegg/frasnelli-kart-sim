import * as THREE from 'three';
import { createKart, KartPhysics } from '../src/kart.js';
import { RacingDriver } from '../src/ai-driver.js';
import { TrackData, ROAD_WIDTH } from '../src/track.js';
import { GEO_TRACK_POINTS } from '../src/generated/terrain-data.js';
import { RACING_LINE_LAP_TIME, RACING_LINE_POINTS, RACING_LINE_REFERENCE_WEIGHT } from '../src/generated/racing-line-data.js';

const samples = GEO_TRACK_POINTS.map(point => ({
  point: new THREE.Vector3(point.x, point.y, point.z),
  leftHeight: point.l,
  rightHeight: point.r,
}));
const before = samples.at(-2).point;
const after = samples[2].point;
const tangent = after.clone().sub(before).normalize();
const startHeading = Math.atan2(-tangent.x, -tangent.z);
const track = new TrackData(samples, 0, startHeading);
const physics = new KartPhysics(track, createKart());
physics.setDriverWeight(RACING_LINE_REFERENCE_WEIGHT);
const driver = process.env.DIRECT_REPLAY ? {
  update(dt, state) {
    const point = RACING_LINE_POINTS[state.trackPose.index];
    return { steer: point.steer, throttle: point.throttle, brake: point.brake, wheelAngle: point.steer * THREE.MathUtils.degToRad(135) };
  },
} : new RacingDriver();

const laps = [];
let maximumOffset = 0;
let maximumOffsetIndex = 0;
let impacts = 0;
let maximumSpeed = 0;
physics.onLap = result => {
  laps.push({ ...result, maximumOffset, impacts });
  maximumOffset = 0;
  impacts = 0;
};
physics.onImpact = () => { impacts++; };

const dt = 1 / 120;
for (let step = 0; step < 120 * 260 && laps.length < 2; step++) {
  const input = driver.update(dt, physics);
  physics.update(dt, input);
  if (Math.abs(physics.trackPose.signedDistance) > maximumOffset) {
    maximumOffset = Math.abs(physics.trackPose.signedDistance);
    maximumOffsetIndex = physics.trackPose.index;
  }
  maximumSpeed = Math.max(maximumSpeed, physics.speedKmh());
}

if (laps.length < 2) throw new Error(`KI beendet innerhalb 260 s keine fliegende Runde; Fortschritt ${(physics.progress * 100).toFixed(1)} %.`);
const flyingLap = laps[1];
if (!flyingLap.valid) throw new Error(`Fliegende KI-Runde ${flyingLap.time.toFixed(3)} s ist ungültig; maximaler Offset ${flyingLap.maximumOffset.toFixed(2)} m bei Index ${maximumOffsetIndex}.`);
if (flyingLap.impacts > 0) throw new Error(`KI hatte in der fliegenden Runde ${flyingLap.impacts} Leitplankenkontakte.`);
if (flyingLap.maximumOffset > ROAD_WIDTH / 2 + .72) throw new Error(`KI verlässt Asphalt und Curb: ${flyingLap.maximumOffset.toFixed(2)} m Offset.`);
if (flyingLap.time < 45 || flyingLap.time > 125) throw new Error(`KI-Rundenzeit unplausibel: ${flyingLap.time.toFixed(3)} s.`);
if (Math.abs(flyingLap.time - RACING_LINE_LAP_TIME) > 12) throw new Error(`Wiedergabe ${flyingLap.time.toFixed(3)} s weicht zu stark von der trainierten Bestzeit ${RACING_LINE_LAP_TIME.toFixed(3)} s ab.`);

console.log(`KI-Runde OK: ${flyingLap.time.toFixed(3)} s real simuliert, trainierte Bestzeit ${RACING_LINE_LAP_TIME.toFixed(3)} s, Spitze ${maximumSpeed.toFixed(1)} km/h, maximaler Offset ${flyingLap.maximumOffset.toFixed(2)} m.`);

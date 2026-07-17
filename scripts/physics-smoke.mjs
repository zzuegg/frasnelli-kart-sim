import * as THREE from 'three';
import { createKart, KartPhysics, KART_MODEL } from '../src/kart.js';
import { GEO_TRACK_LENGTH, GEO_TRACK_POINTS, TERRAIN_DATA } from '../src/generated/terrain-data.js';

if (GEO_TRACK_LENGTH < 1000 || GEO_TRACK_LENGTH > 1040) throw new Error(`Unplausible Streckenlänge: ${GEO_TRACK_LENGTH.toFixed(1)} m`);
if (GEO_TRACK_POINTS.some(p => ![p.x,p.y,p.z,p.l,p.r].every(Number.isFinite))) throw new Error('Ungültige georeferenzierte Streckendaten');
const elevationRange = Math.max(...GEO_TRACK_POINTS.map(p => p.y)) - Math.min(...GEO_TRACK_POINTS.map(p => p.y));
if (elevationRange < 2 || elevationRange > 6) throw new Error(`Unplausibles Höhenprofil: ${elevationRange.toFixed(2)} m`);
if (TERRAIN_DATA.values.length !== TERRAIN_DATA.width * TERRAIN_DATA.height) throw new Error('DTM-Rastergröße stimmt nicht');

const previousStart = GEO_TRACK_POINTS.at(-2), start = GEO_TRACK_POINTS[0], nextStart = GEO_TRACK_POINTS[2];
const tangentX = nextStart.x - previousStart.x, tangentZ = nextStart.z - previousStart.z;
const tangentLength = Math.hypot(tangentX, tangentZ);
const rightX = -tangentZ / tangentLength, rightZ = tangentX / tangentLength;
const firstCornerPoint = GEO_TRACK_POINTS[100];
const firstCornerRight = (firstCornerPoint.x - start.x) * rightX + (firstCornerPoint.z - start.z) * rightZ;
if (firstCornerRight < 10) throw new Error(`Erste Kurve ist nicht rechts: Querbewegung ${firstCornerRight.toFixed(2)} m`);

const kartVisual = createKart();
const rearCover = kartVisual.getObjectByName('Rear end cover');
const rearAxle = kartVisual.getObjectByName('Rear axle');
if (!rearCover || rearCover.geometry.parameters.width > KART_MODEL.rearWidth) throw new Error('Der Heckschutz ragt Ã¼ber die hintere Reifenbreite hinaus.');
if (!rearAxle || Math.abs(rearAxle.geometry.parameters.height - 1.06) > .001) throw new Error('Die sichtbare Hinterachse entspricht nicht der 1060-mm-N35-Achse.');

// Infinite straight for isolated vehicle-dynamics tests. Keeping the reported
// distance at zero prevents barrier collision logic from masking tire behavior.
const track = {
  startIndex: 0,
  lastNearest: 0,
  resetPose: () => ({ point: new THREE.Vector3(0, 0, 0), heading: 0 }),
  nearest(position) {
    return {
      index: 0,
      point: new THREE.Vector3(position.x, 0, position.z),
      tangent: new THREE.Vector3(0, 0, -1),
      right: new THREE.Vector3(1, 0, 0),
      signedDistance: 0,
      distance: 0,
      progress: (((-position.z) % 1030) + 1030) % 1030 / 1030,
      bankAngle: 0,
      surfaceHeight: 0,
    };
  },
};

const kart = new KartPhysics(track, createKart());
let zeroToFifty = null;
for (let i = 0; i < 120 * 20; i++) {
  kart.update(1 / 120, { steer: 0, throttle: 1, brake: 0, wheelAngle: 0 });
  if (zeroToFifty === null && kart.speedKmh() >= 50) zeroToFifty = i / 120;
}
const peak = kart.speedKmh();
if (peak < 64 || peak > 79) throw new Error(`Unplausible Endgeschwindigkeit: ${peak.toFixed(1)} km/h`);
if (zeroToFifty === null || zeroToFifty < 5.5 || zeroToFifty > 12) throw new Error(`Unplausible 0–50-Zeit: ${zeroToFifty?.toFixed(2)} s`);

let maximumStraightLock = 0;
for (let i = 0; i < 120 * 2; i++) {
  kart.update(1 / 120, { steer: 0, throttle: 0, brake: 1, wheelAngle: 0 });
  maximumStraightLock = Math.max(maximumStraightLock, kart.telemetry.rearLock);
}
const afterTwoSecondBrake = kart.speedKmh();
if (afterTwoSecondBrake < 22 || afterTwoSecondBrake > 48) throw new Error(`Unplausible Hinterachsbremsung: ${afterTwoSecondBrake.toFixed(1)} km/h nach 2 s`);
if (maximumStraightLock < .8) throw new Error(`Vollbremsung blockiert die Hinterachse nicht: ${(maximumStraightLock * 100).toFixed(0)} %`);
for (let i = 0; i < 120 * 4; i++) kart.update(1 / 120, { steer: 0, throttle: 0, brake: 1, wheelAngle: 0 });
if (kart.speedKmh() > 2) throw new Error(`Kart kommt nicht zum Stillstand: ${kart.speedKmh().toFixed(1)} km/h`);

const breakoutKart = new KartPhysics(track, createKart());
for (let i = 0; i < 120 * 14; i++) breakoutKart.update(1 / 120, { steer: 0, throttle: 1, brake: 0, wheelAngle: 0 });
for (let i = 0; i < 120 * .45; i++) breakoutKart.update(1 / 120, { steer: .22, throttle: .3, brake: 0, wheelAngle: .5 });
if (breakoutKart.heading >= -.03) throw new Error(`Rechtslenken dreht nicht nach rechts: ${(breakoutKart.heading * 180 / Math.PI).toFixed(1)}°`);
const headingBeforeLock = breakoutKart.heading;
let maximumRearLock = 0;
for (let i = 0; i < 120 * .8; i++) {
  breakoutKart.update(1 / 120, { steer: .22, throttle: 0, brake: .72, wheelAngle: .5 });
  maximumRearLock = Math.max(maximumRearLock, breakoutKart.telemetry.rearLock);
}
const breakoutRotation = Math.abs(breakoutKart.heading - headingBeforeLock);
console.log(`Breakout diagnostic: entry ${(headingBeforeLock * 180 / Math.PI).toFixed(1)}°, delta ${(breakoutRotation * 180 / Math.PI).toFixed(1)}°, yaw ${(breakoutKart.yawRate * 180 / Math.PI).toFixed(1)}°/s, speed ${breakoutKart.speedKmh().toFixed(1)} km/h, lock ${(maximumRearLock * 100).toFixed(0)} %`);
if (maximumRearLock > .20) throw new Error(`Teilbremsung blockiert zu früh: ${(maximumRearLock * 100).toFixed(0)} %`);
if (breakoutRotation < .22) throw new Error(`Breakout erzeugt zu wenig Gierbewegung: ${(breakoutRotation * 180 / Math.PI).toFixed(1)}°`);
if (breakoutRotation > .78) throw new Error(`Breakout dreht zu aggressiv ein: ${(breakoutRotation * 180 / Math.PI).toFixed(1)}°`);

console.log(`Physics/DTM smoke test OK: ${peak.toFixed(1)} km/h, 0–50 in ${zeroToFifty.toFixed(1)} s, nach 2 s Hinterachsbremsung ${afterTwoSecondBrake.toFixed(1)} km/h, Breakout-Rotation ${(breakoutRotation * 180 / Math.PI).toFixed(1)}°, erste Kurve rechts +${firstCornerRight.toFixed(1)} m`);

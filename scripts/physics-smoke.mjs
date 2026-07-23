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
const straightWheelSpeeds = Object.values(kart.telemetry.wheelSpeeds || {});
if (straightWheelSpeeds.length !== 4 || straightWheelSpeeds.some(speed => !Number.isFinite(speed))) throw new Error('Die vier Raddrehzahlen werden nicht separat berechnet.');
if (Math.abs(kart.telemetry.wheelSpeeds.rearLeft - kart.telemetry.wheelSpeeds.rearRight) > .25) throw new Error('Die starre Hinterachse koppelt die hinteren Raddrehzahlen nicht.');
if (peak < 64 || peak > 79) throw new Error(`Unplausible Endgeschwindigkeit: ${peak.toFixed(1)} km/h`);
if (zeroToFifty === null || zeroToFifty < 5.5 || zeroToFifty > 12) throw new Error(`Unplausible 0–50-Zeit: ${zeroToFifty?.toFixed(2)} s`);

let maximumStraightLock = 0;
let maximumForceDemand = 0;
for (let i = 0; i < 120 * 2; i++) {
  kart.update(1 / 120, { steer: 0, throttle: 0, brake: 1, wheelAngle: 0 });
  maximumStraightLock = Math.max(maximumStraightLock, kart.telemetry.rearLock);
  maximumForceDemand = Math.max(maximumForceDemand, ...Object.values(kart.telemetry.tireForceDemand || {}));
  if (Object.values(kart.telemetry.tireUtilization || {}).some(value => value > 1.0001)) throw new Error('Die kombinierte Reifenellipse wird überschritten.');
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
let maximumRearLift = 0;
let minimumInsideRearLoad = Infinity;
for (let i = 0; i < 120 * .8; i++) {
  breakoutKart.update(1 / 120, { steer: .22, throttle: 0, brake: .72, wheelAngle: .5 });
  maximumRearLock = Math.max(maximumRearLock, breakoutKart.telemetry.rearLock);
  maximumRearLift = Math.max(maximumRearLift, breakoutKart.telemetry.rearLift);
  minimumInsideRearLoad = Math.min(minimumInsideRearLoad, breakoutKart.telemetry.wheelLoads?.rearRight ?? Infinity);
}
const breakoutRotation = Math.abs(breakoutKart.heading - headingBeforeLock);
console.log(`Wheel-load diagnostic: lift ${(maximumRearLift * 100).toFixed(0)} %, inner rear ${minimumInsideRearLoad.toFixed(0)} N`);
if (maximumRearLift < .75 || minimumInsideRearLoad > 25) throw new Error('Das innere Hinterrad wird beim Brems-Eindrehen nicht ausreichend entlastet.');

function cornerState(driverWeight) {
  const testKart = new KartPhysics(track, createKart());
  testKart.setDriverWeight(driverWeight);
  for (let i = 0; i < 120 * 20 && testKart.speedKmh() < 60; i++) testKart.update(1 / 120, { steer: 0, throttle: 1, brake: 0, wheelAngle: 0 });
  let maximumLift = 0;
  let minimumInsideLoad = Infinity;
  for (let i = 0; i < 120 * .7; i++) {
    testKart.update(1 / 120, { steer: .16, throttle: .45, brake: 0, wheelAngle: .3 });
    maximumLift = Math.max(maximumLift, testKart.telemetry.rearLift);
    minimumInsideLoad = Math.min(minimumInsideLoad, testKart.telemetry.wheelLoads?.rearRight ?? Infinity);
  }
  const kinematicYaw = Math.abs(testKart.u / KART_MODEL.wheelbase * Math.tan(testKart.steerAngle));
  const staticInsideRear = (KART_MODEL.kartMass + driverWeight) * 9.81 * KART_MODEL.cgToFront / KART_MODEL.wheelbase * .5;
  return {
    maximumLift,
    minimumInsideLoad,
    insideLoadRatio: minimumInsideLoad / staticInsideRear,
    kinematicYaw,
    yaw: Math.abs(testKart.yawRate),
    driverOffset: Math.abs(testKart.driverLateralOffset),
    chassisTwist: Math.abs(testKart.telemetry.chassisTwist),
  };
}

const corner70 = cornerState(70);
const corner100 = cornerState(100);
console.log(`Corner diagnostic: 70 kg yaw ${(corner70.yaw * 180 / Math.PI).toFixed(1)} deg/s of ${(corner70.kinematicYaw * 180 / Math.PI).toFixed(1)} deg/s kinematic, inner rear ${corner70.minimumInsideLoad.toFixed(0)} N; 100 kg inner rear ${corner100.minimumInsideLoad.toFixed(0)} N`);
const steadyYawRatio = corner70.yaw / Math.max(corner70.kinematicYaw, .001);
if (steadyYawRatio < .30 || steadyYawRatio > .75) throw new Error(`Unplausibler Untersteuergradient: ${(steadyYawRatio * 100).toFixed(0)} % der kinematischen Gierrate.`);
if (corner100.insideLoadRatio > corner70.insideLoadRatio - .03) throw new Error('Höheres Fahrergewicht beeinflusst die relative Hinterradentlastung nicht ausreichend.');
if (corner70.driverOffset < .008 || corner70.chassisTwist < .015) throw new Error('Fahrerbewegung oder dynamische Chassisverwindung reagiert nicht auf Querbeschleunigung.');
console.log(`Breakout diagnostic: entry ${(headingBeforeLock * 180 / Math.PI).toFixed(1)}°, delta ${(breakoutRotation * 180 / Math.PI).toFixed(1)}°, yaw ${(breakoutKart.yawRate * 180 / Math.PI).toFixed(1)}°/s, speed ${breakoutKart.speedKmh().toFixed(1)} km/h, lock ${(maximumRearLock * 100).toFixed(0)} %`);
if (maximumRearLock > .20) throw new Error(`Teilbremsung blockiert zu früh: ${(maximumRearLock * 100).toFixed(0)} %`);
if (breakoutRotation < .22) throw new Error(`Breakout erzeugt zu wenig Gierbewegung: ${(breakoutRotation * 180 / Math.PI).toFixed(1)}°`);
if (breakoutRotation > .78) throw new Error(`Breakout dreht zu aggressiv ein: ${(breakoutRotation * 180 / Math.PI).toFixed(1)}°`);
if (maximumForceDemand < .9) throw new Error('Der Vollbremstest nutzt die Reifenellipse nicht aus.');

const curbTrack = {
  ...track,
  surfaceAt(position) {
    if (position.x <= .3) return { height: 0, curbHeight: 0 };
    const serration = .5 + .5 * Math.sin(-position.z * Math.PI * 2 / 1.15);
    const curbHeight = .045 + .032 * serration;
    return { height: curbHeight, curbHeight };
  },
};
const curbKart = new KartPhysics(curbTrack, createKart());
let maximumCurbShock = 0;
let maximumCurbLoadSpread = 0;
for (let i = 0; i < 120 * 10; i++) {
  curbKart.update(1 / 120, { steer: 0, throttle: 1, brake: 0, wheelAngle: 0 });
  maximumCurbShock = Math.max(maximumCurbShock, curbKart.telemetry.verticalShock);
  const loads = Object.values(curbKart.telemetry.wheelLoads || {});
  if (loads.length === 4) maximumCurbLoadSpread = Math.max(maximumCurbLoadSpread, Math.max(...loads) - Math.min(...loads));
}
if (maximumCurbShock < .04 || maximumCurbLoadSpread < 120) throw new Error('Aggressive Kerbs erzeugen keine radweisen Lastspitzen.');

const lapGateKart = new KartPhysics(track, createKart());
let shortcutLap = null;
lapGateKart.onLap = lap => { shortcutLap = lap; };
lapGateKart.u = 10;
lapGateKart.lapArmed = true;
lapGateKart.lapTime = 50;
lapGateKart.lapSector = 0;
lapGateKart.previousProgress = .95;
lapGateKart.progress = .01;
lapGateKart.trackPose = track.nearest(lapGateKart.position);
lapGateKart.updateLap(0);
if (shortcutLap?.valid || lapGateKart.bestLap !== null) throw new Error('Eine abgekürzte Runde passiert die Sektorprüfung.');

console.log(`Physics/DTM smoke test OK: ${peak.toFixed(1)} km/h, 0–50 in ${zeroToFifty.toFixed(1)} s, nach 2 s Hinterachsbremsung ${afterTwoSecondBrake.toFixed(1)} km/h, Breakout-Rotation ${(breakoutRotation * 180 / Math.PI).toFixed(1)}°, Kerb-Lastspitze ${maximumCurbLoadSpread.toFixed(0)} N, erste Kurve rechts +${firstCornerRight.toFixed(1)} m`);

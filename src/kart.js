import * as THREE from 'three';
import { ROAD_WIDTH } from './track.js';

const clamp = THREE.MathUtils.clamp;

// Calibrated as a heavy 13-PS outdoor rental kart: rigid chassis, live rear
// axle, centrifugal clutch, one hydraulic brake disc on the rear axle.
export const KART_MODEL = Object.freeze({
  name: 'Birel ART N35-XR ST',
  kartMass: 140,
  wheelbase: 1.07,
  frontWidth: 1.208,
  rearWidth: 1.410,
  cgToFront: .62,
  cgHeight: .34,
  wheelRadius: .138,
  finalDrive: 2.65,
  drivetrainEfficiency: .84,
  engineTorqueScale: 1.18,
  asphaltMu: 1.32,
  maxSteer: .42,
  steerRate: 5.4,
  frontCornerStiffness: 17000,
  rearCornerStiffness: 28000,
});

function engineTorque(rpm) {
  if (rpm < 1800) return THREE.MathUtils.lerp(15, 23, clamp((rpm - 900) / 900, 0, 1));
  if (rpm < 2600) return THREE.MathUtils.lerp(23, 26.5, (rpm - 1800) / 800);
  if (rpm < 3600) return THREE.MathUtils.lerp(26.5, 22.5, (rpm - 2600) / 1000);
  return 22.5 * clamp(1 - (rpm - 3600) / 230, 0, 1);
}

function lateralTireForce(slipAngle, normalLoad, friction, cornerStiffness) {
  if (normalLoad <= 1) return 0;
  const peak = friction * normalLoad;
  const shape = 1.32;
  const stiffness = cornerStiffness / Math.max(shape * peak, 1);
  const curve = Math.sin(shape * Math.atan(stiffness * slipAngle));
  // Long-life rental slicks lose force progressively after a pronounced
  // breakaway instead of retaining an artificial flat force plateau.
  const breakaway = 1 / (1 + .07 * Math.max(0, Math.abs(slipAngle) - .24) ** 2 / .16 ** 2);
  return -peak * curve * breakaway;
}

function mesh(geometry, material, cast = true) {
  const object = new THREE.Mesh(geometry, material);
  object.castShadow = cast; object.receiveShadow = true;
  return object;
}

export function createKart() {
  const root = new THREE.Group();
  const moving = new THREE.Group(); moving.rotation.y = Math.PI; root.add(moving);
  const red = new THREE.MeshStandardMaterial({ color: 0xd92720, roughness: .35, metalness: .08 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x111412, roughness: .48, metalness: .35 });
  const metal = new THREE.MeshStandardMaterial({ color: 0xaeb5af, roughness: .3, metalness: .82 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x090a09, roughness: .9 });
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x252a27, roughness: .65 });
  const driverMat = new THREE.MeshStandardMaterial({ color: 0x26394e, roughness: .7 });

  const chassis = mesh(new THREE.BoxGeometry(.76, .12, 1.45), dark); chassis.position.y = .25; moving.add(chassis);
  const floor = mesh(new THREE.BoxGeometry(1.02, .055, 1.58), metal); floor.position.set(0, .18, .02); moving.add(floor);
  const nose = mesh(new THREE.BoxGeometry(.72, .18, .48), red); nose.position.set(0, .31, .84); moving.add(nose);
  const noseTop = mesh(new THREE.BoxGeometry(.38, .12, .42), red); noseTop.position.set(0, .44, .82); moving.add(noseTop);
  // The N35 uses a compact rear end cover inside the 1.410 m rear tyre width.
  // The actual 40 x 5 x 1060 mm live axle ends at the inner tyre faces.
  const rear = mesh(new THREE.BoxGeometry(1.18, .24, .36), red); rear.name = 'Rear end cover'; rear.position.set(0, .34, -.78); moving.add(rear);
  const rearAxle = mesh(new THREE.CylinderGeometry(.02, .02, 1.06, 14), metal); rearAxle.name = 'Rear axle'; rearAxle.rotation.z = Math.PI / 2; rearAxle.position.set(0, .25, -.535); moving.add(rearAxle);

  for (const side of [-1, 1]) {
    const pod = mesh(new THREE.BoxGeometry(.22, .19, .88), red); pod.position.set(side * .54, .3, .05); moving.add(pod);
  }

  const seat = mesh(new THREE.BoxGeometry(.54, .7, .12), seatMat); seat.position.set(0, .65, -.32); seat.rotation.x = -.18; moving.add(seat);
  const driverBody = mesh(new THREE.CapsuleGeometry(.23, .48, 6, 10), driverMat); driverBody.position.set(0, .82, -.22); driverBody.rotation.x = -.08; moving.add(driverBody);
  const helmet = mesh(new THREE.SphereGeometry(.22, 20, 14), new THREE.MeshStandardMaterial({ color: 0xf0f1ea, roughness: .3 })); helmet.position.set(0, 1.24, -.18); moving.add(helmet);
  const visor = mesh(new THREE.BoxGeometry(.29, .095, .03), new THREE.MeshStandardMaterial({ color: 0x0e1820, roughness: .12, metalness: .3 })); visor.position.set(0, 1.27, .015); visor.rotation.x = -.08; moving.add(visor);

  const wheelHubs = [];
  const frontPivots = [];
  const frontWheelGeometry = new THREE.CylinderGeometry(.132, .132, .12, 18);
  const rearWheelGeometry = new THREE.CylinderGeometry(.138, .138, .18, 18);
  for (const z of [-.535, .535]) {
    const isFront = z > 0;
    const xOffset = isFront ? .544 : .615;
    const tireWidth = isFront ? .12 : .18;
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group(); pivot.position.set(side * xOffset, .25, z); moving.add(pivot);
      const wheelGeometry = isFront ? frontWheelGeometry : rearWheelGeometry;
      const wheel = mesh(wheelGeometry, rubber); wheel.rotation.z = Math.PI / 2; pivot.add(wheel);
      const hub = mesh(new THREE.CylinderGeometry(.06, .06, tireWidth + .01, 12), metal); hub.rotation.z = Math.PI / 2; pivot.add(hub);
      wheelHubs.push(wheel, hub);
      if (isFront) frontPivots.push(pivot);
    }
  }

  const column = mesh(new THREE.CylinderGeometry(.025, .025, .54, 10), metal); column.position.set(0, .76, .31); column.rotation.x = -.54; moving.add(column);
  const steeringWheel = mesh(new THREE.TorusGeometry(.17, .025, 8, 24), dark); steeringWheel.position.set(0, .96, .51); steeringWheel.rotation.x = Math.PI / 2 - .54; moving.add(steeringWheel);
  const spoke = mesh(new THREE.BoxGeometry(.29, .028, .025), metal); steeringWheel.add(spoke);

  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: .28, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = .03; root.add(shadow);

  root.userData = { moving, wheelHubs, frontPivots, steeringWheel, helmet, visor, wheelRotation: 0 };
  return root;
}

export class KartPhysics {
  constructor(track, visual) {
    this.track = track;
    this.visual = visual;
    this.driverWeight = 70;
    this.position = new THREE.Vector3();
    this.heading = 0;
    this.u = 0;
    this.v = 0;
    this.yawRate = 0;
    this.steerAngle = 0;
    this.wheelAngle = 0;
    this.lastSteerInput = 0;
    this.surface = 'ASPHALT';
    this.progress = 0;
    this.lap = 0;
    this.lapTime = 0;
    this.bestLap = null;
    this.lastLap = null;
    this.lapArmed = false;
    this.lapValid = true;
    this.longitudinalAcceleration = 0;
    this.engineThrottle = 0;
    this.brakePressure = 0;
    this.rearLock = 0;
    this.telemetry = { lateralG: 0, longitudinalG: 0, slip: 0, rearSlip: 0, rearLock: 0, rpm: 1800, collision: 0, curb: false };
    this.onLap = null;
    this.onImpact = null;
    this.reset();
  }

  setDriverWeight(kg) { this.driverWeight = clamp(Number(kg) || 70, 45, 130); }

  reset() {
    const pose = this.track.resetPose();
    this.position.copy(pose.point).setY(.08);
    this.heading = pose.heading;
    this.u = this.v = this.yawRate = 0;
    this.longitudinalAcceleration = 0;
    this.engineThrottle = 0;
    this.brakePressure = 0;
    this.rearLock = 0;
    this.steerAngle = 0;
    this.wheelAngle = 0;
    this.lapTime = 0;
    this.lapArmed = false;
    this.lapValid = true;
    this.track.lastNearest = this.track.startIndex;
    this.trackPose = this.track.nearest(this.position, true);
    this.position.y = (this.trackPose.surfaceHeight ?? this.trackPose.point.y) + .08;
    this.updateVisual(0);
  }

  update(dt, input) {
    dt = Math.min(dt, 1 / 30);
    const nearest = this.track.nearest(this.position, Math.abs(this.track.lastNearest - this.track.startIndex) > 200 && this.u < .5);
    const absOffset = Math.abs(nearest.signedDistance);
    const onRoad = absOffset <= ROAD_WIDTH * .5;
    const onCurb = absOffset > ROAD_WIDTH * .5 && absOffset <= ROAD_WIDTH * .5 + .75;
    this.surface = onRoad ? 'ASPHALT' : onCurb ? 'CURB' : 'GRASS';
    this.telemetry.curb = onCurb;
    if (!onRoad && !onCurb) this.lapValid = false;

    const mass = KART_MODEL.kartMass + this.driverWeight;
    const wheelbase = KART_MODEL.wheelbase;
    const a = KART_MODEL.cgToFront;
    const b = wheelbase - a;
    const inertia = mass * .47;
    const g = 9.81;
    // Positive controller input means right. With local forward on -Z, a
    // right-hand turn is a negative yaw angle in Three.js world space.
    const steerTarget = -clamp(input.steer, -1, 1) * KART_MODEL.maxSteer;
    this.steerAngle += clamp(steerTarget - this.steerAngle, -KART_MODEL.steerRate * dt, KART_MODEL.steerRate * dt);
    this.wheelAngle = Number.isFinite(input.wheelAngle) ? input.wheelAngle : clamp(input.steer, -1, 1) * THREE.MathUtils.degToRad(135);
    this.lastSteerInput = input.steer;

    // v and yawRate use the conventional positive-left vehicle coordinates.
    // They are converted to Three.js world coordinates only after integration.
    const totalSpeed = Math.hypot(this.u, this.v);
    const speed = Math.max(Math.abs(this.u), 1.35);
    const slipF = Math.atan2(this.v + a * this.yawRate, speed) - this.steerAngle;
    const slipR = Math.atan2(this.v - b * this.yawRate, speed);
    const surfaceMu = onRoad ? KART_MODEL.asphaltMu : onCurb ? .72 : .38;

    // Longitudinal load transfer. A rear-braked kart unloads its only braked
    // axle under deceleration, which naturally limits braking and enables spins.
    const staticFront = mass * g * b / wheelbase;
    const transfer = mass * this.longitudinalAcceleration * KART_MODEL.cgHeight / wheelbase;
    const normalF = clamp(staticFront - transfer, mass * g * .25, mass * g * .58);
    const normalR = mass * g - normalF;
    const loadSensitivityF = clamp(1.04 - .10 * (normalF / staticFront - 1), .88, 1.08);
    const staticRear = mass * g - staticFront;
    const loadSensitivityR = clamp(1.04 - .10 * (normalR / staticRear - 1), .88, 1.08);
    let fyF = lateralTireForce(slipF, normalF, surfaceMu * loadSensitivityF, KART_MODEL.frontCornerStiffness);
    let fyR = lateralTireForce(slipR, normalR, surfaceMu * loadSensitivityR, KART_MODEL.rearCornerStiffness);

    const pedalThrottle = clamp(input.throttle, 0, 1);
    const brake = clamp(input.brake, 0, 1);
    this.brakePressure = THREE.MathUtils.damp(this.brakePressure, brake, brake > this.brakePressure ? 9 : 14, dt);
    const throttle = brake > .08 ? 0 : pedalThrottle;
    this.engineThrottle = THREE.MathUtils.damp(this.engineThrottle, throttle, throttle > this.engineThrottle ? 7 : 10, dt);
    const wheelRpm = Math.abs(this.u) / (2 * Math.PI * KART_MODEL.wheelRadius) * 60;
    const lockedRpm = wheelRpm * KART_MODEL.finalDrive;
    const clutchRpm = 1800 + this.engineThrottle * 520;
    const engineRpm = clamp(Math.max(lockedRpm, clutchRpm), 1200, 4100);
    const driveForce = this.engineThrottle * engineTorque(engineRpm) * KART_MODEL.engineTorqueScale * KART_MODEL.finalDrive * KART_MODEL.drivetrainEfficiency / KART_MODEL.wheelRadius;
    const travelSign = Math.abs(this.u) > .12 ? Math.sign(this.u) : 1;
    const engineBrake = (1 - this.engineThrottle) * (16 + Math.abs(this.u) * 1.2) * (totalSpeed > .15 ? 1 : 0);
    const rolling = (onRoad ? 52 : onCurb ? 105 : 260) * (totalSpeed > .15 ? 1 : 0);
    const aero = .40 * totalSpeed * totalSpeed;
    const resistance = rolling + aero;
    const resistLong = totalSpeed > .01 ? resistance * this.u / totalSpeed : 0;
    const resistLat = totalSpeed > .01 ? resistance * this.v / totalSpeed : 0;

    // Rental karts brake through the solid rear axle. Once it locks, rear
    // lateral force collapses and the remaining front force rotates the kart.
    const rearLimit = surfaceMu * loadSensitivityR * normalR;
    const brakeDemand = this.brakePressure ** 2.15 * mass * g * .72 * (totalSpeed > .12 ? 1 : 0);
    const rearLockTarget = clamp((brakeDemand - rearLimit * .92) / Math.max(rearLimit * .35, 1), 0, 1);
    this.rearLock = THREE.MathUtils.damp(this.rearLock, rearLockTarget, rearLockTarget > this.rearLock ? 10 : 15, dt);
    let fxR = driveForce - engineBrake * travelSign - brakeDemand * travelSign;
    fxR = clamp(fxR, -rearLimit, rearLimit);
    const lateralCapacityR = Math.sqrt(Math.max(0, rearLimit * rearLimit - fxR * fxR));
    fyR = clamp(fyR, -lateralCapacityR, lateralCapacityR) * (1 - this.rearLock * .42);

    const frontLimit = surfaceMu * loadSensitivityF * normalF;
    fyF = clamp(fyF, -frontLimit, frontLimit);

    const cosD = Math.cos(this.steerAngle), sinD = Math.sin(this.steerAngle);
    const axleScrub = Math.abs(this.steerAngle) * Math.min(this.u * this.u * 1.2, 85);
    const forceLong = fxR - fyF * sinD - resistLong - axleScrub * travelSign - mass * g * nearest.tangent.y;
    const forceLat = fyR + fyF * cosD - resistLat;
    const du = forceLong / mass + this.v * this.yawRate;
    const dv = forceLat / mass - this.u * this.yawRate;
    // A live axle has no differential: scrub from the two rear tires resists
    // sudden yaw, especially on a heavy rental chassis. The bicycle model does
    // not generate that resistance by itself, so include it explicitly.
    const yawDamping = this.yawRate * (215 + Math.abs(this.u) * 5.5);
    const dr = (a * fyF * cosD - b * fyR - yawDamping) / inertia;

    this.longitudinalAcceleration = THREE.MathUtils.damp(this.longitudinalAcceleration, du, 10, dt);
    this.u = clamp(this.u + du * dt, -18, 23);
    this.v = clamp(this.v + dv * dt, -18, 18);
    this.yawRate = clamp(this.yawRate + dr * dt, -1.65, 1.65);
    const integratedSpeed = Math.hypot(this.u, this.v);
    if (integratedSpeed < 3) {
      const kinematicYaw = this.u / wheelbase * Math.tan(this.steerAngle);
      const blend = clamp(integratedSpeed / 3, 0, 1);
      this.yawRate = THREE.MathUtils.lerp(kinematicYaw, this.yawRate, blend);
      this.v *= Math.exp(-4 * (1 - blend) * dt);
    }
    if (integratedSpeed < .12 && throttle < .04) { this.u = this.v = 0; this.yawRate *= Math.exp(-9 * dt); }
    this.heading += this.yawRate * dt;

    const forward = new THREE.Vector3(-Math.sin(this.heading), 0, -Math.cos(this.heading));
    const right = new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading));
    // v is positive to the kart's left; Three's local +X vector points right.
    this.position.addScaledVector(forward, this.u * dt).addScaledVector(right, -this.v * dt);

    const barrierLimit = ROAD_WIDTH * .5 + 1.28;
    if (absOffset > barrierLimit) {
      const penetration = absOffset - barrierLimit;
      this.position.addScaledVector(nearest.right, -Math.sign(nearest.signedDistance) * (penetration + .08));
      const impact = Math.abs(this.v) + Math.max(0, this.u * .28);
      this.u *= .42; this.v *= -.24; this.yawRate *= .4;
      this.telemetry.collision = clamp(impact / 9, .2, 1);
      if (this.onImpact) this.onImpact(this.telemetry.collision);
    } else {
      this.telemetry.collision *= Math.exp(-8 * dt);
    }

    this.trackPose = this.track.nearest(this.position);
    this.position.y = (this.trackPose.surfaceHeight ?? this.trackPose.point.y) + .08;
    this.telemetry.lateralG = forceLat / mass / g;
    this.telemetry.longitudinalG = du / g;
    this.telemetry.slip = Math.max(Math.abs(slipF), Math.abs(slipR));
    this.telemetry.rearSlip = slipR;
    this.telemetry.rearLock = this.rearLock;
    this.telemetry.rpm = engineRpm;
    this.progress = this.trackPose.progress;
    this.updateLap(dt);
    this.updateVisual(dt);
  }

  updateLap(dt) {
    if (Math.hypot(this.u, this.v) > 1) this.lapTime += dt;
    if (this.progress > .12) this.lapArmed = true;
    if (this.lapArmed && this.progress < .025 && this.u > 3) {
      this.lastLap = this.lapTime;
      if (this.lapValid && (!this.bestLap || this.lastLap < this.bestLap)) this.bestLap = this.lastLap;
      this.lap += 1;
      if (this.onLap) this.onLap({ time: this.lastLap, valid: this.lapValid, best: this.bestLap });
      this.lapTime = 0;
      this.lapArmed = false;
      this.lapValid = true;
    }
  }

  updateVisual(dt) {
    const root = this.visual;
    root.position.copy(this.position);
    const pitch = this.trackPose ? Math.asin(clamp(this.trackPose.tangent.y, -.2, .2)) : 0;
    const bank = this.trackPose && Number.isFinite(this.trackPose.bankAngle) ? clamp(this.trackPose.bankAngle, -.12, .12) : 0;
    root.rotation.set(pitch, this.heading, bank, 'YXZ');
    const data = root.userData;
    data.frontPivots.forEach(p => p.rotation.y = this.steerAngle);
    data.steeringWheel.rotation.z = this.wheelAngle;
    data.wheelRotation -= this.u * dt / .145;
    data.wheelHubs.forEach(w => w.rotation.x = data.wheelRotation);
    data.moving.rotation.z = clamp(-this.telemetry.lateralG * .008, -.025, .025);
  }

  speedKmh() { return Math.hypot(this.u, this.v) * 3.6; }
}

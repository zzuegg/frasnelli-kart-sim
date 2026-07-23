import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { ROAD_WIDTH } from './track.js';

const clamp = THREE.MathUtils.clamp;
export const KART_PHYSICS_VERSION = 3;

// Calibrated as a heavy 13-PS outdoor rental kart: rigid chassis, live rear
// axle, centrifugal clutch, one hydraulic brake disc on the rear axle.
export const KART_MODEL = Object.freeze({
  name: 'Birel ART N35-XR ST',
  kartMass: 140,
  wheelbase: 1.07,
  frontWidth: 1.208,
  rearWidth: 1.410,
  cgToFront: .62,
  kartCgHeight: .22,
  driverCgHeight: .62,
  yawInertiaFactor: .44,
  rearLoadTransferShare: .68,
  jackingLoadFactor: .13,
  tireLoadSensitivity: .16,
  tireRelaxationLength: .34,
  longitudinalGripScale: .84,
  lateralGripScale: .96,
  longitudinalStiffness: 10.5,
  tireVerticalStiffness: 26000,
  tireVerticalDamping: 950,
  wheelRadius: .138,
  frontWheelInertia: .052,
  rearWheelInertia: .16,
  axleCoupling: 9.5,
  finalDrive: 2.65,
  drivetrainEfficiency: .84,
  engineTorqueScale: 1.18,
  engineInertia: .19,
  clutchStiffness: .28,
  clutchMaxTorque: 34,
  maxBrakeTorque: 300,
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

function ackermannAngles(steerAngle, wheelbase, trackWidth) {
  if (Math.abs(steerAngle) < 1e-4) return { left: steerAngle, right: steerAngle };
  const direction = Math.sign(steerAngle);
  const radius = wheelbase / Math.max(Math.tan(Math.abs(steerAngle)), .001);
  const inner = Math.atan2(wheelbase, Math.max(.12, radius - trackWidth * .5));
  const outer = Math.atan2(wheelbase, radius + trackWidth * .5);
  return direction > 0
    ? { left: inner, right: outer }
    : { left: -outer, right: -inner };
}

function loadSensitiveMu(baseMu, normalLoad, referenceLoad) {
  if (normalLoad <= 1) return 0;
  const loadRatio = normalLoad / Math.max(referenceLoad, 1);
  return baseMu * clamp(1.02 - KART_MODEL.tireLoadSensitivity * (loadRatio - 1), .78, 1.14);
}

function smoothstep(edge0, edge1, value) {
  const x = clamp((value - edge0) / Math.max(edge1 - edge0, 1e-6), 0, 1);
  return x * x * (3 - 2 * x);
}

function combinedTireEllipse(fx, fy, normalLoad, mu, conditionGrip = 1) {
  if (normalLoad <= 1) return { fx: 0, fy: 0, utilization: 0 };
  const longPeak = Math.max(1, mu * conditionGrip * KART_MODEL.longitudinalGripScale * normalLoad);
  const latPeak = Math.max(1, mu * conditionGrip * KART_MODEL.lateralGripScale * normalLoad);
  const utilization = Math.hypot(fx / longPeak, fy / latPeak);
  const scale = utilization > 1 ? 1 / utilization : 1;
  return { fx: fx * scale, fy: fy * scale, utilization: Math.min(utilization, 1), demand: Math.min(utilization, 3) };
}

function createTireState() {
  return { omega: 0, angle: 0, fy: 0, temperature: 32, wear: 0, pressureCold: 1.0, pressure: 1.0, slipRatio: 0, utilization: 0, forceDemand: 0 };
}

function mesh(geometry, material, cast = true) {
  const object = new THREE.Mesh(geometry, material);
  object.castShadow = cast; object.receiveShadow = true;
  return object;
}

function tube(group, from, to, radius, material, segments = 10) {
  const start = new THREE.Vector3(...from);
  const end = new THREE.Vector3(...to);
  const direction = end.clone().sub(start);
  const object = mesh(new THREE.CylinderGeometry(radius, radius, direction.length(), segments), material);
  object.position.copy(start).add(end).multiplyScalar(.5);
  object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  group.add(object);
  return object;
}

function roundedBox(group, size, position, material, radius = .035, rotation = null) {
  const safeRadius = Math.min(radius, Math.min(...size) * .46);
  const object = mesh(new RoundedBoxGeometry(size[0], size[1], size[2], 3, safeRadius), material);
  object.position.set(...position);
  if (rotation) object.rotation.set(...rotation);
  group.add(object);
  return object;
}

export function createKart() {
  const root = new THREE.Group();
  const moving = new THREE.Group(); moving.rotation.y = Math.PI; root.add(moving);
  const detailed = typeof window !== 'undefined';
  const red = new THREE.MeshStandardMaterial({ color: 0xcf171f, roughness: .32, metalness: .04 });
  const redDark = new THREE.MeshStandardMaterial({ color: 0x7e0c12, roughness: .4, metalness: .08 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x111614, roughness: .42, metalness: .48 });
  const plastic = new THREE.MeshStandardMaterial({ color: 0x161a18, roughness: .62, metalness: .02 });
  const metal = new THREE.MeshStandardMaterial({ color: 0xaeb6b4, roughness: .27, metalness: .88 });
  const alloy = new THREE.MeshStandardMaterial({ color: 0xd5d9d5, roughness: .2, metalness: .9 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x080908, roughness: .94 });
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x171b19, roughness: .72 });
  const engineBlack = new THREE.MeshStandardMaterial({ color: 0x202321, roughness: .58, metalness: .36 });
  const driverMat = new THREE.MeshStandardMaterial({ color: 0x223c5b, roughness: .66 });
  const gloveMat = new THREE.MeshStandardMaterial({ color: 0x171918, roughness: .82 });
  const helmetMat = new THREE.MeshStandardMaterial({ color: 0xf1f2ed, roughness: .25, metalness: .05 });
  const visorMat = new THREE.MeshStandardMaterial({ color: 0x07131b, roughness: .08, metalness: .42 });

  if (detailed) {
    // 35 mm tubular N35 frame. Segmenting the bent rails keeps the silhouette
    // accurate without importing a licensed third-party mesh.
    const frameRadius = .0175;
    for (const side of [-1, 1]) {
      tube(moving, [side * .33, .22, -.65], [side * .36, .22, .40], frameRadius, dark, 12);
      tube(moving, [side * .36, .22, .40], [side * .27, .22, .72], frameRadius, dark, 12);
      tube(moving, [side * .45, .23, -.58], [side * .61, .25, -.36], frameRadius, dark, 12);
      tube(moving, [side * .61, .25, -.36], [side * .64, .25, .50], frameRadius, dark, 12);
      tube(moving, [side * .64, .25, .50], [side * .51, .24, .71], frameRadius, dark, 12);
    }
    tube(moving, [-.45, .23, -.60], [.45, .23, -.60], frameRadius, dark, 12);
    tube(moving, [-.38, .22, -.12], [.38, .22, -.12], frameRadius, dark, 12);
    tube(moving, [-.33, .22, .39], [.33, .22, .39], frameRadius, dark, 12);
    tube(moving, [-.27, .22, .72], [.27, .22, .72], frameRadius, dark, 12);

    const floor = roundedBox(moving, [.84, .026, 1.31], [0, .205, .06], metal, .025);
    floor.name = 'Aluminium floor tray';
    roundedBox(moving, [.44, .035, .34], [0, .225, .57], plastic, .03);

    // Energy-absorbing N35 perimeter protection and moulded bodywork.
    for (const side of [-1, 1]) {
      tube(moving, [side * .70, .27, -.56], [side * .73, .28, .49], .025, dark, 12);
      tube(moving, [side * .73, .28, .49], [side * .60, .29, .72], .025, dark, 12);
      const pod = roundedBox(moving, [.25, .20, .87], [side * .58, .33, .02], red, .065);
      pod.name = side < 0 ? 'Left N35 shock pod' : 'Right N35 shock pod';
      roundedBox(moving, [.055, .13, .79], [side * .715, .31, .02], plastic, .022);
      roundedBox(moving, [.20, .045, .72], [side * .57, .445, .02], redDark, .02);
    }

    tube(moving, [-.62, .25, .79], [.62, .25, .79], .028, dark, 12);
    tube(moving, [-.66, .25, .75], [-.70, .27, .58], .025, dark, 12);
    tube(moving, [.66, .25, .75], [.70, .27, .58], .025, dark, 12);
    roundedBox(moving, [.92, .20, .18], [0, .34, .81], red, .075);
    roundedBox(moving, [.40, .20, .56], [0, .35, .57], red, .07, [-.05, 0, 0]);
    roundedBox(moving, [.34, .055, .42], [0, .465, .56], redDark, .025);
    roundedBox(moving, [.25, .018, .18], [0, .502, .57], alloy, .008);

    // The rear cover sits inside the 1.410 m tyre width. The live axle itself
    // remains 1.060 m long and is no longer represented as an exposed wide bar.
    tube(moving, [-.68, .29, -.70], [.68, .29, -.70], .031, dark, 12);
    tube(moving, [-.68, .29, -.70], [-.72, .29, -.52], .028, dark, 12);
    tube(moving, [.68, .29, -.70], [.72, .29, -.52], .028, dark, 12);
    const rearCover = roundedBox(moving, [1.16, .25, .27], [0, .38, -.65], red, .07);
    rearCover.name = 'Rear end cover';
    roundedBox(moving, [.96, .075, .24], [0, .50, -.65], plastic, .028);
  } else {
    const chassis = mesh(new THREE.BoxGeometry(.76, .08, 1.35), dark);
    chassis.position.set(0, .23, 0);
    moving.add(chassis);
    const rearCover = mesh(new THREE.BoxGeometry(1.16, .20, .26), red);
    rearCover.name = 'Rear end cover';
    rearCover.position.set(0, .36, -.65);
    moving.add(rearCover);
  }

  // The visual axle terminates at the inner tyre faces.
  const rearAxle = mesh(new THREE.CylinderGeometry(.02, .02, 1.06, 16), metal);
  rearAxle.name = 'Rear axle';
  rearAxle.rotation.z = Math.PI / 2;
  rearAxle.position.set(0, .25, -.535);
  moving.add(rearAxle);

  if (detailed) {
    // Rear hydraulic brake disc and caliper.
    const brakeDisc = mesh(new THREE.CylinderGeometry(.09, .09, .008, 28), alloy);
    brakeDisc.rotation.z = Math.PI / 2;
    brakeDisc.position.set(.22, .25, -.535);
    moving.add(brakeDisc);
    const brakeHub = mesh(new THREE.CylinderGeometry(.035, .035, .018, 18), dark);
    brakeHub.rotation.z = Math.PI / 2;
    brakeHub.position.copy(brakeDisc.position);
    moving.add(brakeHub);
    roundedBox(moving, [.04, .10, .06], [.205, .31, -.54], redDark, .012);

    // Honda GX390-style four-stroke package on the driver's right.
    roundedBox(moving, [.37, .29, .36], [-.43, .41, -.34], engineBlack, .045);
    roundedBox(moving, [.30, .22, .27], [-.43, .53, -.32], red, .035);
    roundedBox(moving, [.25, .075, .22], [-.43, .67, -.32], plastic, .025);
    roundedBox(moving, [.17, .17, .19], [-.63, .52, -.32], plastic, .03);
    const recoil = mesh(new THREE.CylinderGeometry(.105, .105, .035, 28), engineBlack);
    recoil.rotation.z = Math.PI / 2;
    recoil.position.set(-.635, .45, -.32);
    moving.add(recoil);
    const recoilRing = mesh(new THREE.TorusGeometry(.071, .008, 8, 24), metal);
    recoilRing.rotation.y = Math.PI / 2;
    recoilRing.position.set(-.655, .45, -.32);
    moving.add(recoilRing);
    roundedBox(moving, [.16, .19, .21], [-.26, .56, -.33], dark, .025);
    tube(moving, [-.27, .60, -.38], [-.17, .66, -.53], .018, dark, 10);
    roundedBox(moving, [.18, .12, .20], [-.14, .67, -.56], engineBlack, .025);

    // Fuel tank, chain guard and final-drive sprocket.
    roundedBox(moving, [.25, .25, .33], [.43, .43, -.34], plastic, .055);
    roundedBox(moving, [.105, .025, .105], [.43, .57, -.34], red, .012);
    const sprocket = mesh(new THREE.CylinderGeometry(.105, .105, .012, 26), metal);
    sprocket.rotation.z = Math.PI / 2;
    sprocket.position.set(-.31, .25, -.535);
    moving.add(sprocket);
    roundedBox(moving, [.055, .15, .39], [-.32, .33, -.46], plastic, .035, [0, 0, -.05]);

    // Adjustable pedals, steering supports and visible tie rods.
    for (const side of [-1, 1]) {
      tube(moving, [side * .19, .23, .49], [side * .22, .34, .62], .012, metal, 10);
      roundedBox(moving, [.085, .025, .13], [side * .22, .36, .65], alloy, .012, [-.25, 0, 0]);
      tube(moving, [side * .05, .34, .41], [side * .48, .29, .53], .009, metal, 8);
    }
  }

  const wheelHubs = [];
  const frontPivots = [];
  const rearPivots = [];
  const wheels = {};
  for (const z of [-.535, .535]) {
    const isFront = z > 0;
    const xOffset = isFront ? .544 : .615;
    const tireWidth = isFront ? .12 : .18;
    const tireRadius = isFront ? .132 : .138;
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group(); pivot.position.set(side * xOffset, .25, z); moving.add(pivot);
      const wheel = new THREE.Group();
      const tire = mesh(new THREE.CylinderGeometry(tireRadius, tireRadius, tireWidth, 28), rubber);
      tire.rotation.z = Math.PI / 2;
      wheel.add(tire);
      const rim = mesh(new THREE.CylinderGeometry(.074, .074, tireWidth + .006, 24), redDark);
      rim.rotation.z = Math.PI / 2;
      wheel.add(rim);
      const hub = mesh(new THREE.CylinderGeometry(.034, .034, tireWidth + .016, 18), metal);
      hub.rotation.z = Math.PI / 2;
      wheel.add(hub);
      for (const face of [-1, 1]) {
        const rimLip = mesh(new THREE.TorusGeometry(.071, .006, 8, 24), alloy);
        rimLip.rotation.y = Math.PI / 2;
        rimLip.position.x = face * (tireWidth * .5 + .006);
        wheel.add(rimLip);
      }
      pivot.add(wheel);
      wheelHubs.push(wheel, hub);
      const axle = isFront ? 'front' : 'rear';
      const sideName = side < 0 ? 'Left' : 'Right';
      wheels[`${axle}${sideName}`] = { pivot, wheel, hub, side };
      if (isFront) frontPivots.push(pivot);
      else rearPivots.push({ pivot, side });
    }
  }

  const column = tube(moving, [0, .34, .38], [0, .91, .49], .022, metal, 12);
  column.name = 'Steering column';
  const steeringWheel = new THREE.Group();
  steeringWheel.position.set(0, .96, .51);
  steeringWheel.rotation.x = Math.PI / 2 - .54;
  moving.add(steeringWheel);
  const steeringRim = mesh(new THREE.TorusGeometry(.17, .023, 10, 30), rubber);
  steeringWheel.add(steeringRim);
  for (const angle of [0, Math.PI * 2 / 3, Math.PI * 4 / 3]) {
    const spoke = mesh(new THREE.BoxGeometry(.145, .018, .025), metal);
    spoke.position.x = Math.cos(angle) * .072;
    spoke.position.y = Math.sin(angle) * .072;
    spoke.rotation.z = angle;
    steeringWheel.add(spoke);
  }
  const steeringBoss = mesh(new THREE.CylinderGeometry(.04, .04, .025, 18), redDark);
  steeringBoss.rotation.x = Math.PI / 2;
  steeringWheel.add(steeringBoss);

  // Deep rental seat, driver and limbs. The helmet/visor remain separate for
  // cockpit-camera hiding and ghost rendering.
  const seatBack = roundedBox(moving, [.52, .68, .09], [0, .64, -.30], seatMat, .075, [-.18, 0, 0]);
  seatBack.name = 'Adjustable N35 bucket seat';
  roundedBox(moving, [.48, .09, .43], [0, .34, -.13], seatMat, .06, [-.08, 0, 0]);
  for (const side of [-1, 1]) roundedBox(moving, [.09, .32, .38], [side * .255, .51, -.22], seatMat, .045, [-.08, 0, side * .08]);

  const driverBody = mesh(new THREE.CapsuleGeometry(.23, .48, 7, 12), driverMat);
  driverBody.position.set(0, .82, -.22);
  driverBody.rotation.x = -.08;
  moving.add(driverBody);
  const helmet = mesh(new THREE.SphereGeometry(.22, 24, 18), helmetMat);
  helmet.position.set(0, 1.24, -.18);
  moving.add(helmet);
  const visor = roundedBox(moving, [.30, .10, .025], [0, 1.27, .015], visorMat, .025, [-.08, 0, 0]);
  for (const side of [-1, 1]) {
    tube(moving, [side * .17, .93, -.10], [side * .23, .84, .24], .055, driverMat, 10);
    tube(moving, [side * .23, .84, .24], [side * .13, .95, .46], .045, driverMat, 10);
    const glove = mesh(new THREE.SphereGeometry(.055, 12, 8), gloveMat);
    glove.position.set(side * .13, .95, .46);
    moving.add(glove);
    tube(moving, [side * .14, .48, -.05], [side * .18, .35, .42], .07, driverMat, 10);
    roundedBox(moving, [.12, .075, .22], [side * .20, .30, .56], gloveMat, .025, [-.05, 0, 0]);
  }

  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: .28, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = .03; root.add(shadow);

  root.userData = { moving, wheelHubs, wheels, frontPivots, rearPivots, steeringWheel, helmet, visor, wheelRotation: 0, rearLiftVisual: 0 };
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
    this.lapSector = 0;
    this.previousProgress = 0;
    this.longitudinalAcceleration = 0;
    this.lateralAcceleration = 0;
    this.engineThrottle = 0;
    this.brakePressure = 0;
    this.brakeTemperature = 35;
    this.rearLock = 0;
    this.rearLift = 0;
    this.insideRearSide = 0;
    this.chassisJacking = 0;
    this.chassisJackingRate = 0;
    this.driverLateralOffset = 0;
    this.driverLongitudinalOffset = 0;
    this.terrainTwist = 0;
    this.previousTerrainTwist = 0;
    this.previousRoadHeights = null;
    this.bodyPitch = 0;
    this.bodyRoll = 0;
    this.engineOmega = 1800 * Math.PI * 2 / 60;
    this.tires = {
      frontLeft: createTireState(),
      frontRight: createTireState(),
      rearLeft: createTireState(),
      rearRight: createTireState(),
    };
    this.tiresInitialized = false;
    this.conditions = { ambientTemperature: 24, wetness: 0, rubber: .65 };
    this.telemetry = { lateralG: 0, longitudinalG: 0, slip: 0, rearSlip: 0, rearLock: 0, rearLift: 0, wheelLoads: null, wheelSpeeds: null, tireTemperatures: null, tirePressures: null, tireSlipRatios: null, tireUtilization: null, tireForceDemand: null, chassisTwist: 0, verticalShock: 0, brakeTemperature: 35, brakeFade: 0, rpm: 1800, collision: 0, curb: false };
    this.onLap = null;
    this.onImpact = null;
    this.reset();
  }

  setDriverWeight(kg) { this.driverWeight = clamp(Number(kg) || 70, 45, 130); }

  setConditions(conditions = {}) {
    this.conditions = {
      ambientTemperature: clamp(Number(conditions.ambientTemperature ?? this.conditions.ambientTemperature), -5, 50),
      wetness: clamp(Number(conditions.wetness ?? this.conditions.wetness), 0, 1),
      rubber: clamp(Number(conditions.rubber ?? this.conditions.rubber), 0, 1),
    };
    if (Number.isFinite(conditions.tirePressure)) {
      for (const tire of Object.values(this.tires)) tire.pressureCold = clamp(Number(conditions.tirePressure), .65, 1.5);
    }
  }

  reset() {
    const pose = this.track.resetPose();
    this.position.copy(pose.point).setY(.08);
    this.heading = pose.heading;
    this.u = this.v = this.yawRate = 0;
    this.longitudinalAcceleration = 0;
    this.lateralAcceleration = 0;
    this.engineThrottle = 0;
    this.brakePressure = 0;
    this.rearLock = 0;
    this.rearLift = 0;
    this.insideRearSide = 0;
    this.chassisJacking = 0;
    this.chassisJackingRate = 0;
    this.driverLateralOffset = 0;
    this.driverLongitudinalOffset = 0;
    this.terrainTwist = 0;
    this.previousTerrainTwist = 0;
    this.previousRoadHeights = null;
    this.bodyPitch = 0;
    this.bodyRoll = 0;
    this.engineOmega = 1800 * Math.PI * 2 / 60;
    for (const tire of Object.values(this.tires)) {
      tire.omega = 0;
      tire.angle = 0;
      tire.fy = 0;
      if (!this.tiresInitialized) {
        tire.temperature = this.conditions.ambientTemperature + 8;
        tire.wear = 0;
      }
      tire.slipRatio = 0;
      tire.utilization = 0;
      tire.forceDemand = 0;
    }
    this.tiresInitialized = true;
    this.steerAngle = 0;
    this.wheelAngle = 0;
    this.lapTime = 0;
    this.lapArmed = false;
    this.lapValid = true;
    this.lapSector = 0;
    this.track.lastNearest = this.track.startIndex;
    this.trackPose = this.track.nearest(this.position, true);
    this.previousProgress = this.trackPose.progress;
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
    const inertia = mass * KART_MODEL.yawInertiaFactor;
    const g = 9.81;
    const cgHeight = (KART_MODEL.kartMass * KART_MODEL.kartCgHeight + this.driverWeight * KART_MODEL.driverCgHeight) / mass;
    const steerTarget = -clamp(input.steer, -1, 1) * KART_MODEL.maxSteer;
    this.steerAngle += clamp(steerTarget - this.steerAngle, -KART_MODEL.steerRate * dt, KART_MODEL.steerRate * dt);
    this.wheelAngle = Number.isFinite(input.wheelAngle) ? input.wheelAngle : clamp(input.steer, -1, 1) * THREE.MathUtils.degToRad(135);
    this.lastSteerInput = input.steer;

    const totalSpeed = Math.hypot(this.u, this.v);
    const frontSteer = ackermannAngles(this.steerAngle, wheelbase, KART_MODEL.frontWidth);
    const frontLateralVelocity = this.v + a * this.yawRate;
    const rearLateralVelocity = this.v - b * this.yawRate;
    const wheelLongFL = (this.u - this.yawRate * KART_MODEL.frontWidth * .5) * Math.cos(frontSteer.left) + frontLateralVelocity * Math.sin(frontSteer.left);
    const wheelLongFR = (this.u + this.yawRate * KART_MODEL.frontWidth * .5) * Math.cos(frontSteer.right) + frontLateralVelocity * Math.sin(frontSteer.right);
    const wheelLongRL = this.u - this.yawRate * KART_MODEL.rearWidth * .5;
    const wheelLongRR = this.u + this.yawRate * KART_MODEL.rearWidth * .5;
    const slipFL = Math.atan2(frontLateralVelocity * Math.cos(frontSteer.left) - this.u * Math.sin(frontSteer.left), Math.max(Math.abs(wheelLongFL), 1.35));
    const slipFR = Math.atan2(frontLateralVelocity * Math.cos(frontSteer.right) - this.u * Math.sin(frontSteer.right), Math.max(Math.abs(wheelLongFR), 1.35));
    const slipRL = Math.atan2(rearLateralVelocity, Math.max(Math.abs(wheelLongRL), 1.35));
    const slipRR = Math.atan2(rearLateralVelocity, Math.max(Math.abs(wheelLongRR), 1.35));

    const forward = new THREE.Vector3(-Math.sin(this.heading), 0, -Math.cos(this.heading));
    const right = new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading));
    const surfaceSample = (longitudinal, lateral) => {
      const probe = this.position.clone().addScaledVector(forward, longitudinal).addScaledVector(right, lateral);
      if (typeof this.track.surfaceAt === 'function') return this.track.surfaceAt(probe, nearest.index);
      return {
        height: (nearest.surfaceHeight ?? nearest.point.y) + nearest.tangent.y * longitudinal + Math.tan(nearest.bankAngle || 0) * lateral,
        curbHeight: 0,
        signedDistance: nearest.signedDistance + lateral,
      };
    };
    const roadSamples = {
      frontLeft: surfaceSample(a, -KART_MODEL.frontWidth * .5),
      frontRight: surfaceSample(a, KART_MODEL.frontWidth * .5),
      rearLeft: surfaceSample(-b, -KART_MODEL.rearWidth * .5),
      rearRight: surfaceSample(-b, KART_MODEL.rearWidth * .5),
    };
    const roadHeights = Object.fromEntries(Object.entries(roadSamples).map(([name, sample]) => [name, sample.height]));
    const surfaceGripAt = sample => {
      const distance = Math.abs(sample.signedDistance ?? nearest.signedDistance);
      return distance <= ROAD_WIDTH * .5 ? KART_MODEL.asphaltMu : distance <= ROAD_WIDTH * .5 + .75 ? .72 : .38;
    };
    const surfaceResistanceAt = sample => {
      const distance = Math.abs(sample.signedDistance ?? nearest.signedDistance);
      return distance <= ROAD_WIDTH * .5 ? 52 : distance <= ROAD_WIDTH * .5 + .75 ? 105 : 260;
    };
    const wheelOnCurb = Object.values(roadSamples).some(sample => (sample.curbHeight || 0) > .003);
    this.telemetry.curb = onCurb || wheelOnCurb;
    const frontRoadHeight = (roadHeights.frontLeft + roadHeights.frontRight) * .5;
    const rearRoadHeight = (roadHeights.rearLeft + roadHeights.rearRight) * .5;
    const leftRoadHeight = (roadHeights.frontLeft + roadHeights.rearLeft) * .5;
    const rightRoadHeight = (roadHeights.frontRight + roadHeights.rearRight) * .5;
    const roadPitch = Math.atan2(frontRoadHeight - rearRoadHeight, wheelbase);
    const roadRoll = Math.atan2(rightRoadHeight - leftRoadHeight, (KART_MODEL.frontWidth + KART_MODEL.rearWidth) * .5);
    this.bodyPitch = THREE.MathUtils.damp(this.bodyPitch, roadPitch - this.longitudinalAcceleration * .0018, 15, dt);
    this.bodyRoll = THREE.MathUtils.damp(this.bodyRoll, roadRoll - this.lateralAcceleration * .0012, 15, dt);
    this.terrainTwist = (roadHeights.frontLeft + roadHeights.rearRight - roadHeights.frontRight - roadHeights.rearLeft) * .25;
    const terrainTwistRate = (this.terrainTwist - this.previousTerrainTwist) / Math.max(dt, 1e-4);
    this.previousTerrainTwist = this.terrainTwist;
    const averageRoadHeight = Object.values(roadHeights).reduce((sum, height) => sum + height, 0) * .25;
    const wheelGeometry = {
      frontLeft: { longitudinal: a, lateral: -KART_MODEL.frontWidth * .5 },
      frontRight: { longitudinal: a, lateral: KART_MODEL.frontWidth * .5 },
      rearLeft: { longitudinal: -b, lateral: -KART_MODEL.rearWidth * .5 },
      rearRight: { longitudinal: -b, lateral: KART_MODEL.rearWidth * .5 },
    };
    const wheelBumpLoads = {};
    let verticalShock = 0;
    for (const [name, geometry] of Object.entries(wheelGeometry)) {
      const expectedHeight = averageRoadHeight
        + Math.tan(this.bodyPitch) * geometry.longitudinal
        + Math.tan(this.bodyRoll) * geometry.lateral;
      const compression = roadHeights[name] - expectedHeight;
      const previousHeight = this.previousRoadHeights?.[name] ?? roadHeights[name];
      const roadVelocity = (roadHeights[name] - previousHeight) / Math.max(dt, 1e-4);
      wheelBumpLoads[name] = clamp(
        compression * KART_MODEL.tireVerticalStiffness + roadVelocity * KART_MODEL.tireVerticalDamping,
        -mass * g * .18,
        mass * g * .18,
      );
      verticalShock = Math.max(verticalShock, Math.abs(wheelBumpLoads[name]) / Math.max(mass * g, 1));
    }
    this.previousRoadHeights = { ...roadHeights };
    const averageBumpLoad = Object.values(wheelBumpLoads).reduce((sum, load) => sum + load, 0) * .25;
    for (const name of Object.keys(wheelBumpLoads)) wheelBumpLoads[name] -= averageBumpLoad;

    this.driverLateralOffset = THREE.MathUtils.damp(this.driverLateralOffset, clamp(-this.lateralAcceleration / g * .052, -.065, .065), 4.2, dt);
    this.driverLongitudinalOffset = THREE.MathUtils.damp(this.driverLongitudinalOffset, clamp(-this.longitudinalAcceleration / g * .042, -.04, .05), 4.8, dt);

    const staticFront = mass * g * b / wheelbase;
    const transfer = mass * this.longitudinalAcceleration * cgHeight / wheelbase;
    const driverLongitudinalTransfer = this.driverWeight * g * this.driverLongitudinalOffset / wheelbase;
    const normalF = clamp(staticFront - transfer + driverLongitudinalTransfer, mass * g * .22, mass * g * .62);
    const normalR = mass * g - normalF;
    const staticRear = mass * g - staticFront;
    const bankAcceleration = g * Math.sin(nearest.bankAngle || 0);
    const loadAcceleration = this.lateralAcceleration + bankAcceleration;
    const averageTrack = (KART_MODEL.frontWidth + KART_MODEL.rearWidth) * .5;
    const driverLateralTransfer = this.driverWeight * g * this.driverLateralOffset / averageTrack;
    const totalLateralTransfer = mass * loadAcceleration * cgHeight / averageTrack - driverLateralTransfer;
    const rearTransfer = clamp(totalLateralTransfer * KART_MODEL.rearLoadTransferShare, -normalR * .495, normalR * .495);
    const frontTransfer = clamp(totalLateralTransfer - rearTransfer, -normalF * .48, normalF * .48);
    let normalFL = normalF * .5 - frontTransfer;
    let normalFR = normalF * .5 + frontTransfer;
    let normalRL = normalR * .5 - rearTransfer;
    let normalRR = normalR * .5 + rearTransfer;

    const turnSign = Math.abs(loadAcceleration) > .15 ? Math.sign(loadAcceleration) : Math.sign(this.steerAngle);
    const steeringFraction = clamp(Math.abs(this.steerAngle) / KART_MODEL.maxSteer, 0, 1);
    const corneringBuild = .25 + .75 * clamp(Math.abs(loadAcceleration) / (g * .9), 0, 1);
    const driverJackingFactor = 1 + (this.driverWeight - 70) * .008;
    const jackingTarget = turnSign * mass * g * KART_MODEL.jackingLoadFactor * driverJackingFactor * steeringFraction * corneringBuild;
    const jackingFrequency = 10.5;
    const jackingAcceleration = (jackingTarget - this.chassisJacking) * jackingFrequency ** 2 - 2 * .78 * jackingFrequency * this.chassisJackingRate;
    this.chassisJackingRate += jackingAcceleration * dt;
    this.chassisJacking += this.chassisJackingRate * dt;
    const terrainDiagonalLoad = clamp(terrainTwistRate * KART_MODEL.tireVerticalDamping * .18, -mass * g * .05, mass * g * .05);
    normalFL += wheelBumpLoads.frontLeft + terrainDiagonalLoad;
    normalFR += wheelBumpLoads.frontRight - terrainDiagonalLoad;
    normalRL += wheelBumpLoads.rearLeft - terrainDiagonalLoad;
    normalRR += wheelBumpLoads.rearRight + terrainDiagonalLoad;
    if (turnSign > 0) {
      const applied = Math.min(Math.abs(this.chassisJacking), Math.max(0, normalRL));
      normalRL -= applied;
      normalFL += applied;
    } else if (turnSign < 0) {
      const applied = Math.min(Math.abs(this.chassisJacking), Math.max(0, normalRR));
      normalRR -= applied;
      normalFR += applied;
    }
    normalFL = Math.max(0, normalFL); normalFR = Math.max(0, normalFR);
    normalRL = Math.max(0, normalRL); normalRR = Math.max(0, normalRR);

    const pedalThrottle = clamp(input.throttle, 0, 1);
    const brake = clamp(input.brake, 0, 1);
    this.brakePressure = THREE.MathUtils.damp(this.brakePressure, brake, brake > this.brakePressure ? 9 : 14, dt);
    const throttle = brake > .08 ? 0 : pedalThrottle;
    this.engineThrottle = THREE.MathUtils.damp(this.engineThrottle, throttle, throttle > this.engineThrottle ? 7 : 10, dt);
    const engineRpmBefore = this.engineOmega * 60 / (Math.PI * 2);
    const rearAxleOmega = (this.tires.rearLeft.omega + this.tires.rearRight.omega) * .5;
    const clutchEngagement = smoothstep(1550, 2250, engineRpmBefore);
    const clutchCapacity = KART_MODEL.clutchMaxTorque * clutchEngagement;
    const clutchSlip = this.engineOmega - rearAxleOmega * KART_MODEL.finalDrive;
    const clutchTorque = clamp(clutchSlip * KART_MODEL.clutchStiffness, -clutchCapacity, clutchCapacity);
    const combustionTorque = this.engineThrottle * engineTorque(engineRpmBefore) * KART_MODEL.engineTorqueScale;
    const idleTorque = clamp((1680 - engineRpmBefore) * .016, 0, 11);
    const engineDragTorque = (1 - this.engineThrottle) * (2.4 + Math.max(0, engineRpmBefore - 1500) * .0028);
    this.engineOmega = clamp(
      this.engineOmega + (combustionTorque + idleTorque - clutchTorque - engineDragTorque) / KART_MODEL.engineInertia * dt,
      1200 * Math.PI * 2 / 60,
      4100 * Math.PI * 2 / 60,
    );
    const engineRpm = this.engineOmega * 60 / (Math.PI * 2);

    const weatherGrip = 1 - this.conditions.wetness * (onRoad ? .38 : .18);
    const rubberGrip = 1 + (this.conditions.rubber - .5) * .07 * (1 - this.conditions.wetness);
    const tireEntries = [
      ['frontLeft', normalFL, wheelLongFL, slipFL, KART_MODEL.frontCornerStiffness * .5, surfaceGripAt(roadSamples.frontLeft)],
      ['frontRight', normalFR, wheelLongFR, slipFR, KART_MODEL.frontCornerStiffness * .5, surfaceGripAt(roadSamples.frontRight)],
      ['rearLeft', normalRL, wheelLongRL, slipRL, KART_MODEL.rearCornerStiffness * .5, surfaceGripAt(roadSamples.rearLeft)],
      ['rearRight', normalRR, wheelLongRR, slipRR, KART_MODEL.rearCornerStiffness * .5, surfaceGripAt(roadSamples.rearRight)],
    ];
    const tireForces = {};
    for (const [name, normalLoad, wheelLong, slipAngle, cornerStiffness, baseSurfaceMu] of tireEntries) {
      const tire = this.tires[name];
      tire.pressure = tire.pressureCold * (tire.temperature + 273.15) / (this.conditions.ambientTemperature + 281.15);
      const temperatureGrip = 1 - clamp(Math.abs(tire.temperature - 48) / 120, 0, .13);
      const pressureGrip = 1 - clamp(((tire.pressure - 1.06) / .58) ** 2, 0, .12);
      const wearGrip = 1 - tire.wear * .18;
      const conditionGrip = weatherGrip * rubberGrip * temperatureGrip * pressureGrip * wearGrip;
      const referenceLoad = name.startsWith('front') ? staticFront * .5 : staticRear * .5;
      const mu = loadSensitiveMu(baseSurfaceMu, normalLoad, referenceLoad);
      const slipDenominator = Math.max(Math.abs(wheelLong), 2);
      const slipRatio = (tire.omega * KART_MODEL.wheelRadius - wheelLong) / slipDenominator;
      tire.slipRatio = clamp(slipRatio, -3, 3);
      const longitudinalPeak = mu * conditionGrip * KART_MODEL.longitudinalGripScale * normalLoad;
      const rawFx = longitudinalPeak * Math.tanh(KART_MODEL.longitudinalStiffness * tire.slipRatio);
      const implicitFrontScale = name.startsWith('front')
        ? 1 / (1 + dt * longitudinalPeak * KART_MODEL.longitudinalStiffness * KART_MODEL.wheelRadius ** 2 / (KART_MODEL.frontWheelInertia * slipDenominator))
        : 1;
      const pureFx = rawFx * implicitFrontScale;
      const pureFy = lateralTireForce(slipAngle, normalLoad, mu * conditionGrip, cornerStiffness);
      const relaxationRate = Math.max(Math.abs(wheelLong), 1.2) / KART_MODEL.tireRelaxationLength;
      tire.fy += (pureFy - tire.fy) * (1 - Math.exp(-relaxationRate * dt));
      const combined = combinedTireEllipse(pureFx, tire.fy, normalLoad, mu, conditionGrip);
      tire.utilization = combined.utilization;
      tire.forceDemand = combined.demand;
      tireForces[name] = { ...combined, slipAngle, wheelLong, normalLoad };
    }

    const driveTorquePerRearWheel = clutchTorque * KART_MODEL.finalDrive * KART_MODEL.drivetrainEfficiency * .5;
    const brakeFade = clamp((this.brakeTemperature - 420) / 350, 0, .25);
    const brakeTorquePerRearWheel = this.brakePressure ** 1.55 * KART_MODEL.maxBrakeTorque * .5 * (1 - brakeFade);
    const axleTorque = (this.tires.rearRight.omega - this.tires.rearLeft.omega) * KART_MODEL.axleCoupling;
    const integrateWheel = (name, inertiaValue, appliedTorque, brakingTorque = 0) => {
      const tire = this.tires[name];
      const force = tireForces[name];
      const rotationSign = Math.abs(tire.omega) > .5 ? Math.sign(tire.omega) : Math.sign(force.wheelLong || 1);
      const netTorque = appliedTorque - brakingTorque * rotationSign - force.fx * KART_MODEL.wheelRadius;
      const previousOmega = tire.omega;
      tire.omega = clamp(tire.omega + netTorque / inertiaValue * dt, -220, 220);
      if (brakingTorque > 0 && previousOmega * tire.omega < 0) tire.omega = 0;
      tire.angle -= tire.omega * dt;
      const slipPower = Math.abs(force.fx * (tire.omega * KART_MODEL.wheelRadius - force.wheelLong))
        + Math.abs(force.fy * force.wheelLong * Math.tan(force.slipAngle));
      tire.temperature += (slipPower * .000032 - (tire.temperature - this.conditions.ambientTemperature) * (.014 + totalSpeed * .0012)) * dt;
      tire.wear = clamp(tire.wear + slipPower * dt * 4.5e-9, 0, 1);
    };
    integrateWheel('frontLeft', KART_MODEL.frontWheelInertia, 0);
    integrateWheel('frontRight', KART_MODEL.frontWheelInertia, 0);
    integrateWheel('rearLeft', KART_MODEL.rearWheelInertia, driveTorquePerRearWheel + axleTorque, brakeTorquePerRearWheel);
    integrateWheel('rearRight', KART_MODEL.rearWheelInertia, driveTorquePerRearWheel - axleTorque, brakeTorquePerRearWheel);
    const brakePower = brakeTorquePerRearWheel * (Math.abs(this.tires.rearLeft.omega) + Math.abs(this.tires.rearRight.omega));
    this.brakeTemperature += (brakePower * .00011 - (this.brakeTemperature - this.conditions.ambientTemperature) * (.016 + totalSpeed * .0007)) * dt;

    const fxFL = tireForces.frontLeft.fx;
    const fxFR = tireForces.frontRight.fx;
    const fxRL = tireForces.rearLeft.fx;
    const fxRR = tireForces.rearRight.fx;
    const fyFL = tireForces.frontLeft.fy;
    const fyFR = tireForces.frontRight.fy;
    const fyRL = tireForces.rearLeft.fy;
    const fyRR = tireForces.rearRight.fy;
    const frontLongFL = fxFL * Math.cos(frontSteer.left) - fyFL * Math.sin(frontSteer.left);
    const frontLongFR = fxFR * Math.cos(frontSteer.right) - fyFR * Math.sin(frontSteer.right);
    const frontLatFL = fyFL * Math.cos(frontSteer.left) + fxFL * Math.sin(frontSteer.left);
    const frontLatFR = fyFR * Math.cos(frontSteer.right) + fxFR * Math.sin(frontSteer.right);

    const rolling = Object.values(roadSamples).reduce((sum, sample) => sum + surfaceResistanceAt(sample), 0) * .25 * (totalSpeed > .15 ? 1 : 0);
    const aero = .40 * totalSpeed * totalSpeed;
    const resistance = rolling + aero;
    const resistLong = totalSpeed > .01 ? resistance * this.u / totalSpeed : 0;
    const resistLat = totalSpeed > .01 ? resistance * this.v / totalSpeed : 0;
    const axleScrub = Math.abs(this.steerAngle) * Math.min(this.u * this.u * 1.2, 85);
    const travelSign = Math.abs(this.u) > .12 ? Math.sign(this.u) : 1;
    const forceLong = fxRL + fxRR + frontLongFL + frontLongFR - resistLong - axleScrub * travelSign - mass * g * nearest.tangent.y;
    const forceLat = fyRL + fyRR + frontLatFL + frontLatFR - resistLat;
    const du = forceLong / mass + this.v * this.yawRate;
    const dv = forceLat / mass - this.u * this.yawRate + bankAcceleration;
    const rearInsideLoad = turnSign > 0 ? normalRL : turnSign < 0 ? normalRR : Math.min(normalRL, normalRR);
    const rearContact = clamp(rearInsideLoad / Math.max(staticRear * .5, 1), 0, 1);
    const yawDampingCoefficient = 188 + rearContact * (88 + Math.abs(this.u) * 1.05);
    const yawDamping = this.yawRate * yawDampingCoefficient;
    const frontMoment = a * (frontLatFL + frontLatFR) + KART_MODEL.frontWidth * .5 * (frontLongFR - frontLongFL);
    const rearMoment = -b * (fyRL + fyRR) + KART_MODEL.rearWidth * .5 * (fxRR - fxRL);
    const dr = (frontMoment + rearMoment - yawDamping) / inertia;

    this.longitudinalAcceleration = THREE.MathUtils.damp(this.longitudinalAcceleration, du, 10, dt);
    this.lateralAcceleration = THREE.MathUtils.damp(this.lateralAcceleration, forceLat / mass, 12, dt);
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

    this.position.addScaledVector(forward, this.u * dt).addScaledVector(right, -this.v * dt);

    const barrierLimit = ROAD_WIDTH * .5 + 1.28;
    if (absOffset > barrierLimit) {
      const penetration = absOffset - barrierLimit;
      const barrierSide = Math.sign(nearest.signedDistance);
      this.position.addScaledVector(nearest.right, -barrierSide * (penetration + .08));
      const worldVelocity = forward.clone().multiplyScalar(this.u).addScaledVector(right, -this.v);
      const outwardNormal = nearest.right.clone().multiplyScalar(barrierSide);
      const outwardSpeed = Math.max(0, worldVelocity.dot(outwardNormal));
      const tangentialVelocity = worldVelocity.clone().addScaledVector(outwardNormal, -worldVelocity.dot(outwardNormal));
      const postImpactVelocity = tangentialVelocity.multiplyScalar(.72).addScaledVector(outwardNormal, -outwardSpeed * .18);
      this.u = postImpactVelocity.dot(forward);
      this.v = -postImpactVelocity.dot(right);
      this.yawRate = clamp(this.yawRate - barrierSide * outwardSpeed * .075, -1.65, 1.65) * .72;
      const impact = outwardSpeed + Math.max(0, Math.abs(this.u) * .08);
      this.telemetry.collision = clamp(impact / 9, .2, 1);
      if (this.onImpact) this.onImpact(this.telemetry.collision);
    } else {
      this.telemetry.collision *= Math.exp(-8 * dt);
    }

    this.trackPose = this.track.nearest(this.position);
    this.position.y = (this.trackPose.surfaceHeight ?? this.trackPose.point.y) + .08;
    this.telemetry.lateralG = (forceLat / mass + bankAcceleration) / g;
    this.telemetry.longitudinalG = du / g;
    this.telemetry.slip = Math.max(Math.abs(slipFL), Math.abs(slipFR), Math.abs(slipRL), Math.abs(slipRR));
    this.telemetry.rearSlip = Math.abs(slipRL) >= Math.abs(slipRR) ? slipRL : slipRR;
    const rearGroundOmega = Math.abs(this.u) / KART_MODEL.wheelRadius;
    const rearRollingOmega = (Math.abs(this.tires.rearLeft.omega) + Math.abs(this.tires.rearRight.omega)) * .5;
    const rearLockTarget = this.brakePressure * clamp(1 - rearRollingOmega / Math.max(rearGroundOmega, 2), 0, 1);
    this.rearLock = THREE.MathUtils.damp(this.rearLock, rearLockTarget, rearLockTarget > this.rearLock ? 16 : 11, dt);
    this.telemetry.rearLock = this.rearLock;
    this.insideRearSide = turnSign;
    this.rearLift = clamp(1 - rearInsideLoad / Math.max(staticRear * .08, 1), 0, 1);
    this.telemetry.rearLift = this.rearLift;
    this.telemetry.wheelLoads = { frontLeft: normalFL, frontRight: normalFR, rearLeft: normalRL, rearRight: normalRR };
    this.telemetry.wheelSpeeds = Object.fromEntries(Object.entries(this.tires).map(([name, tire]) => [name, tire.omega * KART_MODEL.wheelRadius * 3.6]));
    this.telemetry.tireTemperatures = Object.fromEntries(Object.entries(this.tires).map(([name, tire]) => [name, tire.temperature]));
    this.telemetry.tirePressures = Object.fromEntries(Object.entries(this.tires).map(([name, tire]) => [name, tire.pressure]));
    this.telemetry.tireSlipRatios = Object.fromEntries(Object.entries(this.tires).map(([name, tire]) => [name, tire.slipRatio]));
    this.telemetry.tireUtilization = Object.fromEntries(Object.entries(this.tires).map(([name, tire]) => [name, tire.utilization]));
    this.telemetry.tireForceDemand = Object.fromEntries(Object.entries(this.tires).map(([name, tire]) => [name, tire.forceDemand]));
    this.telemetry.chassisTwist = this.chassisJacking / Math.max(mass * g, 1);
    this.telemetry.verticalShock = verticalShock;
    this.telemetry.brakeTemperature = this.brakeTemperature;
    this.telemetry.brakeFade = brakeFade;
    this.telemetry.rpm = engineRpm;
    this.progress = this.trackPose.progress;
    this.updateLap(dt);
    this.updateVisual(dt);
  }

  updateLap(dt) {
    if (Math.hypot(this.u, this.v) > 1) this.lapTime += dt;
    if (this.progress > .12) this.lapArmed = true;
    if (this.lapSector === 0 && this.progress > .18 && this.progress < .38) this.lapSector = 1;
    else if (this.lapSector === 1 && this.progress > .43 && this.progress < .63) this.lapSector = 2;
    else if (this.lapSector === 2 && this.progress > .68 && this.progress < .86) this.lapSector = 3;
    else if (this.lapSector === 3 && this.progress > .90) this.lapSector = 4;
    const crossedStart = this.previousProgress > .88 && this.progress < .04;
    const forwardAlignment = this.trackPose
      ? -Math.sin(this.heading) * this.trackPose.tangent.x - Math.cos(this.heading) * this.trackPose.tangent.z
      : 1;
    if (this.lapArmed && crossedStart && this.u > 3) {
      const completedCourse = this.lapSector === 4 && this.lapTime > 35 && forwardAlignment > .35;
      this.lastLap = this.lapTime;
      const validLap = this.lapValid && completedCourse;
      if (validLap && (!this.bestLap || this.lastLap < this.bestLap)) this.bestLap = this.lastLap;
      this.lap += 1;
      if (this.onLap) this.onLap({ time: this.lastLap, valid: validLap, best: this.bestLap });
      this.lapTime = 0;
      this.lapArmed = false;
      this.lapValid = true;
      this.lapSector = 0;
    }
    this.previousProgress = this.progress;
  }

  updateVisual(dt) {
    const root = this.visual;
    root.position.copy(this.position);
    root.rotation.set(clamp(this.bodyPitch, -.2, .2), this.heading, clamp(this.bodyRoll, -.16, .16), 'YXZ');
    const data = root.userData;
    const visualSteer = ackermannAngles(this.steerAngle, KART_MODEL.wheelbase, KART_MODEL.frontWidth);
    if (data.wheels?.frontLeft) data.wheels.frontLeft.pivot.rotation.y = visualSteer.left;
    if (data.wheels?.frontRight) data.wheels.frontRight.pivot.rotation.y = visualSteer.right;
    data.steeringWheel.rotation.z = this.wheelAngle;
    data.rearLiftVisual = THREE.MathUtils.damp(data.rearLiftVisual || 0, this.rearLift, 12, dt);
    data.rearPivots?.forEach(({ pivot, side }) => {
      pivot.position.y = .25 + (side === this.insideRearSide ? data.rearLiftVisual * .045 : 0);
    });
    if (data.wheels) {
      for (const [name, wheelData] of Object.entries(data.wheels)) {
        if (this.tires[name]) wheelData.wheel.rotation.x = this.tires[name].angle;
      }
    }
    data.moving.rotation.z = clamp(-this.telemetry.lateralG * .008 + this.driverLateralOffset * .08, -.035, .035);
    data.moving.rotation.x = clamp(this.driverLongitudinalOffset * .11, -.02, .02);
  }

  speedKmh() { return Math.hypot(this.u, this.v) * 3.6; }
}

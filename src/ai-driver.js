import * as THREE from 'three';
import { KART_MODEL } from './kart.js';
import { RACING_LINE_DRIVER_CONFIG, RACING_LINE_POINTS, RACING_LINE_LAP_TIME, RACING_POLICY_POINTS } from './generated/racing-line-data.js';

const clamp = THREE.MathUtils.clamp;
const wrap = (value, length) => (value % length + length) % length;

/**
 * Deterministic virtual rental-kart driver. The driver follows the numerically
 * optimized line with speed-dependent preview, finite steering speed and a
 * deliberately small grip reserve instead of teleporting the kart to it.
 */
export class RacingDriver {
  constructor({
    pace = RACING_LINE_DRIVER_CONFIG?.pace ?? 1,
    points = RACING_POLICY_POINTS ?? RACING_LINE_POINTS,
    previewBase = RACING_LINE_DRIVER_CONFIG?.previewBase ?? 5.6,
    previewGain = RACING_LINE_DRIVER_CONFIG?.previewGain ?? .43,
    steeringGrip = RACING_LINE_DRIVER_CONFIG?.steeringGrip ?? .88,
    steeringScale = RACING_LINE_DRIVER_CONFIG?.steeringScale ?? .78,
    steeringRate = RACING_LINE_DRIVER_CONFIG?.steeringRate ?? 2.15,
    recordedSteerBlend = RACING_LINE_DRIVER_CONFIG?.recordedSteerBlend ?? 1,
    limitRecordedSteer = RACING_LINE_DRIVER_CONFIG?.limitRecordedSteer ?? false,
    headingGain = RACING_LINE_DRIVER_CONFIG?.headingGain ?? .72,
    crossTrackGain = RACING_LINE_DRIVER_CONFIG?.crossTrackGain ?? 1.55,
    speedPreviewBase = 12,
    speedPreviewGain = .9,
    brakingRamp = RACING_LINE_DRIVER_CONFIG?.brakingRamp ?? .82,
    driverMode = RACING_LINE_DRIVER_CONFIG?.driverMode ?? 'speed',
    recordedHeadingGain = RACING_LINE_DRIVER_CONFIG?.recordedHeadingGain ?? .12,
    recordedCrossTrackGain = RACING_LINE_DRIVER_CONFIG?.recordedCrossTrackGain ?? .28,
    recordedCorrectionLimit = RACING_LINE_DRIVER_CONFIG?.recordedCorrectionLimit ?? .18,
    recordedSteerScale = RACING_LINE_DRIVER_CONFIG?.recordedSteerScale ?? 1,
    recordedThrottleGain = RACING_LINE_DRIVER_CONFIG?.recordedThrottleGain ?? 0,
    recordedBrakeGain = RACING_LINE_DRIVER_CONFIG?.recordedBrakeGain ?? 0,
    precomputedSpeedProfile = RACING_LINE_DRIVER_CONFIG?.precomputedSpeedProfile ?? false,
    physicsLimitedSteering = RACING_LINE_DRIVER_CONFIG?.physicsLimitedSteering ?? true,
  } = {}) {
    this.pace = pace;
    this.previewBase = previewBase;
    this.previewGain = previewGain;
    this.steeringGrip = steeringGrip;
    this.steeringScale = steeringScale;
    this.steeringRate = steeringRate;
    this.recordedSteerBlend = recordedSteerBlend;
    this.limitRecordedSteer = limitRecordedSteer;
    this.headingGain = headingGain;
    this.crossTrackGain = crossTrackGain;
    this.speedPreviewBase = speedPreviewBase;
    this.speedPreviewGain = speedPreviewGain;
    this.brakingRamp = brakingRamp;
    this.driverMode = driverMode;
    this.recordedHeadingGain = recordedHeadingGain;
    this.recordedCrossTrackGain = recordedCrossTrackGain;
    this.recordedCorrectionLimit = recordedCorrectionLimit;
    this.recordedSteerScale = recordedSteerScale;
    this.recordedThrottleGain = recordedThrottleGain;
    this.recordedBrakeGain = recordedBrakeGain;
    this.precomputedSpeedProfile = precomputedSpeedProfile;
    this.physicsLimitedSteering = physicsLimitedSteering;
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.integral = 0;
    this.referenceLapTime = RACING_LINE_LAP_TIME / pace;
    this.points = points;
    let lineLength = 0;
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      const next = points[(index + 1) % points.length];
      lineLength += Math.hypot(next.x - point.x, next.z - point.z);
    }
    this.pointsPerMeter = points.length / Math.max(lineLength, 1);
  }

  reset() {
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.integral = 0;
  }

  update(dt, physics) {
    if (this.driverMode === 'recorded') return this.updateRecorded(dt, physics);
    const count = this.points.length;
    const index = wrap(physics.trackPose?.index ?? 0, count);
    const speed = physics.speedKmh() / 3.6;
    const previewMeters = clamp(this.previewBase + speed * this.previewGain, 5.0, 15.0);
    const controlIndex = wrap(index + Math.round(previewMeters * this.pointsPerMeter), count);
    const target = this.points[controlIndex];
    const before = this.points[wrap(controlIndex - 3, count)];
    const after = this.points[wrap(controlIndex + 3, count)];
    const tangentLength = Math.hypot(after.x - before.x, after.z - before.z) || 1;
    const tangentX = (after.x - before.x) / tangentLength;
    const tangentZ = (after.z - before.z) / tangentLength;
    const lineRightX = -tangentZ;
    const lineRightZ = tangentX;
    const crossTrack = (physics.position.x - target.x) * lineRightX + (physics.position.z - target.z) * lineRightZ;
    const lineHeading = Math.atan2(-tangentX, -tangentZ);
    const headingError = Math.atan2(Math.sin(lineHeading - physics.heading), Math.cos(lineHeading - physics.heading));
    let curvature = 0;
    for (let step = -3; step <= 3; step++) curvature += this.points[wrap(controlIndex + step, count)].curvature || 0;
    curvature /= 7;
    const recordedSteer = this.points[index].steer;
    const hasRecordedSteer = this.recordedSteerBlend > 0 && Number.isFinite(recordedSteer);
    const geometricFeedForward = Math.atan(KART_MODEL.wheelbase * curvature) / KART_MODEL.maxSteer;
    const feedForward = hasRecordedSteer
      ? THREE.MathUtils.lerp(geometricFeedForward, recordedSteer, this.recordedSteerBlend)
      : geometricFeedForward;
    const headingCorrection = -headingError * (hasRecordedSteer ? .24 : this.headingGain) / KART_MODEL.maxSteer;
    const crossTrackCorrection = -Math.atan2((hasRecordedSteer ? .55 : this.crossTrackGain) * crossTrack, Math.max(speed, 3)) / KART_MODEL.maxSteer;
    const desiredRoadWheel = (feedForward + headingCorrection + crossTrackCorrection) * KART_MODEL.maxSteer;
    const gripLimitedRoadWheel = Math.atan2(this.steeringGrip * 9.81 * KART_MODEL.wheelbase, Math.max(speed * speed, 9));
    const steeringLimit = !this.physicsLimitedSteering || (hasRecordedSteer && !this.limitRecordedSteer)
      ? .78
      : clamp(gripLimitedRoadWheel * this.steeringScale / KART_MODEL.maxSteer, .09, .72);
    const desiredSteer = clamp(desiredRoadWheel / KART_MODEL.maxSteer, -steeringLimit, steeringLimit);
    this.steer += clamp(desiredSteer - this.steer, -this.steeringRate * dt, this.steeringRate * dt);

    // Look farther ahead for braking than for steering. A real driver reacts to
    // the upcoming minimum, not just the target at the front bumper.
    let targetKmh = this.points[index].speed;
    const speedPreview = this.precomputedSpeedProfile
      ? 4
      : Math.round(clamp(this.speedPreviewBase + speed * this.speedPreviewGain, 12, 38));
    for (let step = 1; step <= speedPreview; step++) {
      const planned = this.points[wrap(index + step, count)].speed;
      targetKmh = Math.min(targetKmh, planned + step * (this.precomputedSpeedProfile ? 2.4 : this.brakingRamp));
    }
    targetKmh *= this.pace;
    const error = targetKmh - physics.speedKmh();
    this.integral = clamp(this.integral + error * dt, -8, 8);

    let desiredThrottle = 0;
    let desiredBrake = 0;
    if (error < -1.0) {
      desiredBrake = clamp((-error - .4) / 7.5, 0, 1);
    } else if (error > .35) {
      desiredThrottle = clamp(.20 + error / 7.5 + this.integral * .012, 0, 1);
    }

    if (desiredBrake > .05) desiredThrottle = 0;

    this.throttle = THREE.MathUtils.damp(this.throttle, desiredThrottle, desiredThrottle > this.throttle ? 4.5 : 8, dt);
    this.brake = THREE.MathUtils.damp(this.brake, desiredBrake, desiredBrake > this.brake ? 7 : 10, dt);
    if (this.brake > .04) this.throttle = 0;

    return {
      steer: this.steer,
      throttle: this.throttle,
      brake: this.brake,
      wheelAngle: this.steer * THREE.MathUtils.degToRad(135),
      source: 'KI',
      targetKmh,
      lineIndex: index,
    };
  }

  updateRecorded(dt, physics) {
    const count = this.points.length;
    const index = wrap(physics.trackPose?.index ?? 0, count);
    const target = this.points[index];
    const before = this.points[wrap(index - 3, count)];
    const after = this.points[wrap(index + 3, count)];
    const tangentLength = Math.hypot(after.x - before.x, after.z - before.z) || 1;
    const tangentX = (after.x - before.x) / tangentLength;
    const tangentZ = (after.z - before.z) / tangentLength;
    const rightX = -tangentZ;
    const rightZ = tangentX;
    const crossTrack = (physics.position.x - target.x) * rightX + (physics.position.z - target.z) * rightZ;
    const lineHeading = Math.atan2(-tangentX, -tangentZ);
    const headingError = Math.atan2(Math.sin(lineHeading - physics.heading), Math.cos(lineHeading - physics.heading));
    const speedMs = physics.speedKmh() / 3.6;
    const headingCorrection = -headingError * this.recordedHeadingGain / KART_MODEL.maxSteer;
    const crossTrackCorrection = -Math.atan2(this.recordedCrossTrackGain * crossTrack, Math.max(speedMs, 3)) / KART_MODEL.maxSteer;
    const correction = clamp(headingCorrection + crossTrackCorrection, -this.recordedCorrectionLimit, this.recordedCorrectionLimit);
    this.steer = clamp((Number.isFinite(target.steer) ? target.steer : 0) * this.recordedSteerScale + correction, -.98, .98);

    const targetKmh = Number.isFinite(target.speed) ? target.speed : physics.speedKmh();
    const speedError = targetKmh - physics.speedKmh();
    this.throttle = clamp((target.throttle || 0) + Math.max(0, speedError) * this.recordedThrottleGain, 0, 1);
    this.brake = clamp((target.brake || 0) + Math.max(0, -speedError) * this.recordedBrakeGain, 0, 1);
    if (this.brake > .04) this.throttle = 0;

    return {
      steer: this.steer,
      throttle: this.throttle,
      brake: this.brake,
      wheelAngle: this.steer * THREE.MathUtils.degToRad(135),
      source: 'KI-REPLAY',
      targetKmh,
      lineIndex: index,
    };
  }
}

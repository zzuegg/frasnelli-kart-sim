import * as THREE from 'three';

const clamp = THREE.MathUtils.clamp;

export function normalizedTouchAxis(value, deadzone = .08) {
  const magnitude = Math.abs(clamp(value, -1, 1));
  if (magnitude <= deadzone) return 0;
  return Math.sign(value) * (magnitude - deadzone) / (1 - deadzone);
}

export class MobileControls {
  constructor(steerZone, pedalZone) {
    this.steerZone = steerZone;
    this.pedalZone = pedalZone;
    this.enabled = false;
    this.raw = { steer: 0, pedal: 0 };
    this.state = { steer: 0, throttle: 0, brake: 0 };
    this.pointers = { steer: null, pedal: null };
    this.bindZone('steer', steerZone);
    this.bindZone('pedal', pedalZone);
  }

  bindZone(kind, zone) {
    const move = event => {
      if (!this.enabled || this.pointers[kind] !== event.pointerId) return;
      event.preventDefault();
      this.updatePointer(kind, event.clientX, event.clientY);
    };
    zone.addEventListener('pointerdown', event => {
      if (!this.enabled || this.pointers[kind] !== null) return;
      event.preventDefault();
      this.pointers[kind] = event.pointerId;
      zone.setPointerCapture?.(event.pointerId);
      this.updatePointer(kind, event.clientX, event.clientY);
    });
    zone.addEventListener('pointermove', move);
    const release = event => {
      if (this.pointers[kind] !== event.pointerId) return;
      event.preventDefault();
      this.pointers[kind] = null;
      this.raw[kind] = 0;
      this.updateKnob(kind, 0);
    };
    zone.addEventListener('pointerup', release);
    zone.addEventListener('pointercancel', release);
    zone.addEventListener('lostpointercapture', release);
  }

  updatePointer(kind, clientX, clientY) {
    const zone = kind === 'steer' ? this.steerZone : this.pedalZone;
    const rect = zone.getBoundingClientRect();
    const radius = Math.max(1, Math.min(rect.width, rect.height) * .42);
    const value = kind === 'steer'
      ? (clientX - (rect.left + rect.width / 2)) / radius
      : ((rect.top + rect.height / 2) - clientY) / radius;
    this.raw[kind] = normalizedTouchAxis(value);
    this.updateKnob(kind, this.raw[kind]);
  }

  updateKnob(kind, value) {
    const zone = kind === 'steer' ? this.steerZone : this.pedalZone;
    const knob = zone.querySelector('.touch-stick');
    if (!knob) return;
    const travel = 40;
    knob.style.transform = kind === 'steer'
      ? `translate(calc(-50% + ${value * travel}%), -50%)`
      : `translate(-50%, calc(-50% - ${value * travel}%))`;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) this.reset();
  }

  reset() {
    this.raw.steer = 0;
    this.raw.pedal = 0;
    this.state.steer = 0;
    this.state.throttle = 0;
    this.state.brake = 0;
    this.pointers.steer = null;
    this.pointers.pedal = null;
    this.updateKnob('steer', 0);
    this.updateKnob('pedal', 0);
  }

  getInput(dt) {
    const targetThrottle = Math.max(0, this.raw.pedal);
    const targetBrake = Math.max(0, -this.raw.pedal);
    this.state.steer = THREE.MathUtils.damp(this.state.steer, this.raw.steer, this.raw.steer ? 14 : 18, dt);
    this.state.throttle = THREE.MathUtils.damp(this.state.throttle, targetThrottle, targetThrottle ? 12 : 18, dt);
    this.state.brake = THREE.MathUtils.damp(this.state.brake, targetBrake, targetBrake ? 15 : 20, dt);
    return {
      steer: this.state.steer,
      wheelAngle: this.state.steer * THREE.MathUtils.degToRad(135),
      throttle: this.state.throttle,
      brake: this.state.brake,
      source: 'TOUCH',
    };
  }
}

import * as THREE from 'three';

export class InputManager {
  constructor() {
    this.keys = new Set();
    this.gamepadIndex = null;
    this.mapping = this.loadMapping();
    this.keyboardState = { steer: 0, throttle: 0, brake: 0 };
    this.onDeviceChange = null;
    window.addEventListener('keydown', e => this.keys.add(e.code));
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('gamepadconnected', e => {
      this.gamepadIndex = e.gamepad.index;
      if (this.onDeviceChange) this.onDeviceChange(e.gamepad);
    });
    window.addEventListener('gamepaddisconnected', e => {
      if (this.gamepadIndex === e.gamepad.index) this.gamepadIndex = null;
      if (this.onDeviceChange) this.onDeviceChange(null);
    });
  }

  loadMapping() {
    try {
      return { steer: 0, throttle: 1, brake: 2, wheelRange: 270, invertSteer: false, invertThrottle: true, invertBrake: true, ...JSON.parse(localStorage.getItem('frasnelli-g923-map') || '{}') };
    } catch {
      return { steer: 0, throttle: 1, brake: 2, wheelRange: 270, invertSteer: false, invertThrottle: true, invertBrake: true };
    }
  }

  saveMapping(mapping) {
    this.mapping = { ...this.mapping, ...mapping };
    localStorage.setItem('frasnelli-g923-map', JSON.stringify(this.mapping));
  }

  scanGamepads() {
    const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
    if (pads.length && this.gamepadIndex === null) {
      const preferred = pads.find(p => /G923|Logitech|Driving Force/i.test(p.id)) || pads[0];
      this.gamepadIndex = preferred.index;
    }
    return pads;
  }

  get gamepad() {
    if (this.gamepadIndex === null) return null;
    return navigator.getGamepads?.()[this.gamepadIndex] || null;
  }

  getInput(dt) {
    const left = this.keys.has('KeyA') || this.keys.has('ArrowLeft');
    const right = this.keys.has('KeyD') || this.keys.has('ArrowRight');
    const throttleKey = this.keys.has('KeyW') || this.keys.has('ArrowUp');
    const brakeKey = this.keys.has('KeyS') || this.keys.has('ArrowDown') || this.keys.has('Space');
    const targetSteer = (right ? 1 : 0) - (left ? 1 : 0);
    this.keyboardState.steer = THREE.MathUtils.damp(this.keyboardState.steer, targetSteer, targetSteer ? 8 : 11, dt);
    this.keyboardState.throttle = THREE.MathUtils.damp(this.keyboardState.throttle, throttleKey ? 1 : 0, throttleKey ? 8 : 12, dt);
    this.keyboardState.brake = THREE.MathUtils.damp(this.keyboardState.brake, brakeKey ? 1 : 0, brakeKey ? 12 : 15, dt);

    const pad = this.gamepad;
    if (!pad) return { ...this.keyboardState, wheelAngle: this.keyboardState.steer * THREE.MathUtils.degToRad(135), source: 'TASTATUR' };
    const m = this.mapping;
    const rawSteer = pad.axes[m.steer] ?? 0;
    const signedSteer = rawSteer * (m.invertSteer ? -1 : 1);
    const isWheel = /G923|Logitech|Driving Force/i.test(pad.id);
    const wheelRange = clampWheelRange(m.wheelRange);
    let steer = signedSteer * (isWheel ? wheelRange / 270 : 1);
    steer = THREE.MathUtils.clamp(steer, -1, 1);
    if (Math.abs(steer) < .018) steer = 0;
    steer = Math.sign(steer) * Math.pow(Math.abs(steer), 1.08);
    const pedal = (raw, invert) => THREE.MathUtils.clamp(invert ? (1 - raw) * .5 : (raw + 1) * .5, 0, 1);
    const throttle = pedal(pad.axes[m.throttle] ?? 1, m.invertThrottle);
    const brake = pedal(pad.axes[m.brake] ?? 1, m.invertBrake);
    return {
      steer: Math.abs(steer) > .025 ? steer : this.keyboardState.steer,
      wheelAngle: isWheel
        ? THREE.MathUtils.clamp(signedSteer * THREE.MathUtils.degToRad(wheelRange / 2), -THREE.MathUtils.degToRad(135), THREE.MathUtils.degToRad(135))
        : steer * THREE.MathUtils.degToRad(135),
      throttle: throttle > .02 ? throttle : this.keyboardState.throttle,
      brake: brake > .02 ? brake : this.keyboardState.brake,
      source: /G923/i.test(pad.id) ? 'G923' : 'LENKRAD',
    };
  }

  axisValues() {
    const pad = this.gamepad;
    return pad ? Array.from(pad.axes) : [];
  }

  haptic(strength = .25, duration = 80) {
    const pad = this.gamepad;
    if (!pad) return;
    const actuator = pad.vibrationActuator || pad.hapticActuators?.[0];
    if (!actuator) return;
    try {
      if (actuator.playEffect) {
        actuator.playEffect('dual-rumble', {
          duration,
          strongMagnitude: Math.min(1, strength),
          weakMagnitude: Math.min(1, strength * .65),
        }).catch(() => {});
      } else if (actuator.pulse) {
        actuator.pulse(Math.min(1, strength), duration).catch(() => {});
      }
    } catch { /* Browser/device does not expose haptics. */ }
  }
}

function clampWheelRange(value) {
  return THREE.MathUtils.clamp(Number(value) || 270, 180, 900);
}

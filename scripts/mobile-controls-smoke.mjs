import assert from 'node:assert/strict';
import { MobileControls, normalizedTouchAxis } from '../src/mobile-controls.js';

class FakeZone extends EventTarget {
  constructor(left, top, width, height) {
    super();
    this.rect = { left, top, width, height };
    this.knob = { style: {} };
  }
  getBoundingClientRect() { return this.rect; }
  querySelector(selector) { return selector === '.touch-stick' ? this.knob : null; }
  setPointerCapture() {}
}

assert.equal(normalizedTouchAxis(.04), 0, 'Die Touch-Achse braucht eine kleine Ruhezone.');
assert.ok(normalizedTouchAxis(1) > .99);
assert.ok(normalizedTouchAxis(-1) < -.99);

const steerZone = new FakeZone(0, 0, 160, 160);
const pedalZone = new FakeZone(200, 0, 160, 160);
const controls = new MobileControls(steerZone, pedalZone);
controls.setEnabled(true);

controls.updatePointer('steer', 160, 80);
let input = controls.getInput(1);
assert.ok(input.steer > .95, 'Rechter linker-Daumen-Ausschlag muss nach rechts lenken.');
assert.equal(input.source, 'TOUCH');

controls.updatePointer('pedal', 280, 0);
input = controls.getInput(1);
assert.ok(input.throttle > .95 && input.brake < .01, 'Rechter Daumen nach oben muss Gas geben.');

controls.updatePointer('pedal', 280, 160);
input = controls.getInput(1);
assert.ok(input.brake > .95 && input.throttle < .01, 'Rechter Daumen nach unten muss bremsen.');

controls.setEnabled(false);
input = controls.getInput(1);
assert.equal(input.steer, 0);
assert.equal(input.throttle, 0);
assert.equal(input.brake, 0);

console.log('Mobile controls smoke test OK: Lenken, Gas, Bremse, Deadzone und Reset geprüft.');

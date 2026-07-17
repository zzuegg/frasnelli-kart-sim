import assert from 'node:assert/strict';
import * as THREE from 'three';

const values = new Map();
globalThis.localStorage = {
  getItem: key => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, String(value)),
};

const { LapGhost } = await import('../src/ghost.js');
const { createKart } = await import('../src/kart.js');
const scene = new THREE.Scene();
const physics = {
  position: new THREE.Vector3(),
  heading: 0,
  steerAngle: 0,
  wheelAngle: 0,
  lapTime: 0,
  driverWeight: 70,
  trackPose: { tangent: new THREE.Vector3(0, 0, -1), bankAngle: 0 },
  speedKmh: () => 60,
};

const recorder = new LapGhost(scene);
assert.equal(recorder.best.time, 57.667, 'Ohne lokale Runde muss der öffentliche Referenz-Ghost aktiv sein.');
assert.equal(recorder.bestSource, 'reference');
recorder.resetRecording(physics);
for (let sample = 1; sample <= 900; sample++) {
  physics.lapTime = sample / 30;
  physics.position.set(physics.lapTime, .08, -physics.lapTime * .4);
  physics.heading = physics.lapTime * .01;
  recorder.capture(1 / 30, physics);
}
assert.equal(recorder.finish(30, true, physics), true, 'Die gültige manuelle Bestzeit muss gespeichert werden.');
assert.equal(recorder.best.time, 30);
assert.equal(recorder.bestSource, 'local', 'Eine schnellere lokale Runde muss den Referenz-Ghost ersetzen.');

const restored = new LapGhost(new THREE.Scene());
assert.equal(restored.best.time, 30, 'Der Ghost muss nach einem Neustart aus dem persistenten Speicher geladen werden.');
restored.setLead(2.5);
physics.lapTime = 5;
restored.update(physics, 1 / 60);
assert.equal(restored.visual.visible, true);
assert.ok(Math.abs(restored.visual.position.x - 7.5) < .08, 'Der eingestellte Ghost-Vorsprung muss die Wiedergabe zeitlich vorziehen.');

physics.lapTime = 0;
restored.update(physics, 1 / 60);
assert.ok(Math.abs(restored.visual.position.x - 2.5) < .08, 'Der Ghost muss mit der nächsten Runde neu starten.');

const replayKart = createKart();
restored.resetPlayback();
const replayFrame = restored.playAt(12, 1 / 60, replayKart);
assert.ok(replayFrame, 'Die gespeicherte Ghost-Runde muss als unabhängiges Replay abspielbar sein.');
assert.ok(Math.abs(replayKart.position.x - 12) < .08, 'Das Replay muss das sichtbare Kart auf die aufgezeichnete Position setzen.');
assert.equal(Math.round(replayFrame.speedKmh), 60, 'Das Replay muss die aufgezeichnete Geschwindigkeit an das HUD liefern.');

console.log('Ghost smoke test OK: manuelle Bestzeit persistent, Rundensynchronisation, Vorsprung und Menü-Replay geprüft.');

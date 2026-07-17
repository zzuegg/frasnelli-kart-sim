import * as THREE from 'three';
import './style.css';
import { createTrack, ROAD_WIDTH } from './track.js';
import { createKart, KartPhysics } from './kart.js';
import { InputManager } from './input.js';
import { RacingDriver } from './ai-driver.js';
import { LapGhost } from './ghost.js';
import { MobileControls } from './mobile-controls.js';
import { RACING_LINE_LAP_TIME, RACING_LINE_POINTS, RACING_LINE_REFERENCE_WEIGHT } from './generated/racing-line-data.js';

const app = document.getElementById('app');
app.innerHTML = `
  <main class="game-shell">
    <canvas id="game-canvas" aria-label="Frasnelli Kart Simulator"></canvas>
    <div class="topbar">
      <div class="brand"><div class="brand-mark">FK</div><div><h1>Frasnelli Kart Sim</h1><p>Pfatten · Südtirol</p></div></div>
      <div class="hud-cluster">
        <div class="hud-box"><span class="hud-label">Runde</span><span class="hud-value" id="lap">0</span></div>
        <div class="hud-box"><span class="hud-label">Aktuell</span><span class="hud-value" id="lap-time">0:00.000</span></div>
        <div class="hud-box"><span class="hud-label">Bestzeit</span><span class="hud-value" id="best-time">—</span></div>
        <div class="hud-box reference"><span class="hud-label">KI-Bestzeit · 70 kg</span><span class="hud-value" id="reference-time">—</span></div>
      </div>
    </div>
    <div class="minimap-wrap"><canvas id="minimap" width="380" height="184"></canvas></div>
    <div class="speedo"><div><div class="speed-num" id="speed">0</div><div class="speed-unit">km/h · <span id="surface">Asphalt</span></div></div><div class="rpm-bar"><span id="rpm"></span></div></div>
    <div class="pedals"><div class="pedal gas"><span id="gas-bar"></span></div><div class="pedal brake"><span id="brake-bar"></span></div></div>
    <div class="racing-legend"><span><i class="legend-swatch accel"></i>Beschleunigen</span><span><i class="legend-swatch coast"></i>Rollen</span><span><i class="legend-swatch brake"></i>Bremsen</span><b id="drive-mode">DU</b></div>
    <div class="ghost-controls">
      <label class="ghost-toggle"><input type="checkbox" id="ghost-visible"> Ghost</label>
      <label class="line-toggle"><input type="checkbox" id="racing-line-visible"> Optimallinie</label>
      <label class="ghost-lead" for="ghost-lead">Vorsprung <output id="ghost-lead-value">0,0 s</output><input type="range" id="ghost-lead" min="0" max="10" step="0.1" value="0"></label>
      <span id="ghost-best">Kein Ghost gespeichert</span>
    </div>
    <div class="notice" id="notice"></div>
    <div class="help">WASD fahren · I KI-Fahrer · G Ghost · L Optimallinie · C Kamera · R Reset · P Pause · Esc Setup</div>

    <button class="camera-button" id="camera-button" type="button">Kamera</button>
    <button class="reset-button" id="reset-button" type="button">Reset</button>
    <button class="exit-button" id="exit-button" type="button">Exit</button>
    <div class="touch-controls" id="touch-controls" aria-hidden="true">
      <div class="touch-zone touch-steer" id="touch-steer" aria-label="Mobile Lenkung">
        <span class="touch-zone-label">Lenken</span><span class="touch-direction left">Links</span><span class="touch-direction right">Rechts</span><span class="touch-stick"></span>
      </div>
      <div class="touch-zone touch-pedal" id="touch-pedal" aria-label="Mobiles Gas und Bremse">
        <span class="touch-zone-label">Gas / Bremse</span><span class="touch-direction gas">Gas</span><span class="touch-direction brake">Bremse</span><span class="touch-stick"></span>
      </div>
    </div>

    <section class="start-screen" id="start-screen">
      <div class="start-card">
        <span class="eyebrow">1.030 Meter · amtliches DTM 20/50 cm</span>
        <h2>Frasnelli<br>Kart Sim</h2>
        <p>Fahre die georeferenzierte Strecke mit einem Birel ART N35 auf dem amtlichen LiDAR-Höhenmodell Südtirols. Steigung, Gefälle, Querneigung, Reifenlast, Schlupf, Fahrergewicht, Curbs, Gras und Leitplanken wirken sich auf das Fahrverhalten aus.</p>
        <div class="actions">
          <button class="primary" id="start-btn">Training starten</button>
          <button class="primary ai" id="ai-btn">KI-Runde fahren</button>
          <button class="secondary replay" id="ghost-replay-btn" disabled>Kein Ghost-Replay</button>
          <button class="secondary" id="ghost-export-btn" disabled>Eigenen Ghost exportieren</button>
          <button class="secondary" id="calibrate-btn">G923 kalibrieren</button>
          <label class="secondary control-switch"><input type="checkbox" id="mobile-controls-toggle"> Mobile-Steuerung</label>
          <select class="secondary" id="driver-weight" aria-label="Fahrergewicht">
            <option value="70">Fahrer 70 kg</option><option value="80">Fahrer 80 kg</option><option value="90">Fahrer 90 kg</option><option value="100">Fahrer 100 kg</option>
          </select>
        </div>
        <div class="start-meta">
          <div class="meta-item"><b>N35</b><span>Birel ART Mietkart</span></div>
          <div class="meta-item"><b>3,57 m</b><span>DTM-Höhenprofil</span></div>
          <div class="meta-item"><b id="device-summary">Tastatur</b><span>aktives Eingabegerät</span></div>
        </div>
      </div>
    </section>

    <section class="calibration hidden" id="calibration">
      <div class="calibration-panel">
        <span class="eyebrow">Logitech G923 / Gamepad API</span>
        <h2>Lenkrad kalibrieren</h2>
        <p>Den hier gewählten Lenkradbereich auch in G HUB einstellen; für ein Mietkart sind 270° empfohlen. Lenkrad und Pedale bewegen und die reagierenden Achsen auswählen.</p>
        <div class="device-state" id="device-state">Drücke eine Taste am Lenkrad, damit der Browser es erkennt.</div>
        <div class="axis-grid">
          <div class="axis-control"><label for="steer-axis">Lenkung</label><select id="steer-axis"></select><div class="axis-meter"><span id="steer-meter"></span></div><label class="check"><input type="checkbox" id="invert-steer"> Umkehren</label></div>
          <div class="axis-control"><label for="throttle-axis">Gaspedal</label><select id="throttle-axis"></select><div class="axis-meter"><span id="throttle-meter"></span></div><label class="check"><input type="checkbox" id="invert-throttle"> Umkehren</label></div>
          <div class="axis-control"><label for="brake-axis">Bremspedal</label><select id="brake-axis"></select><div class="axis-meter"><span id="brake-meter"></span></div><label class="check"><input type="checkbox" id="invert-brake"> Umkehren</label></div>
          <div class="axis-control"><label for="wheel-range">Lenkradbereich</label><select id="wheel-range"><option value="180">180°</option><option value="270">270° (empfohlen)</option><option value="360">360°</option><option value="540">540°</option><option value="900">900°</option></select></div>
        </div>
        <div class="calibration-actions"><button class="secondary" id="scan-btn">Erneut suchen</button><button class="primary" id="save-calibration">Übernehmen</button></div>
      </div>
    </section>
  </main>`;

const canvas = document.getElementById('game-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9bb7c3);
scene.fog = new THREE.FogExp2(0xa9bec2, .0017);
const hemi = new THREE.HemisphereLight(0xc9e1ec, 0x38512c, 1.65); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff3d4, 2.25);
sun.position.set(-120, 180, 90); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = sun.shadow.camera.bottom = -260; sun.shadow.camera.right = sun.shadow.camera.top = 260;
sun.shadow.camera.near = 10; sun.shadow.camera.far = 430; sun.shadow.bias = -.00018; scene.add(sun);

const track = createTrack(scene);
const kart = createKart(); scene.add(kart);
const physics = new KartPhysics(track, kart);
const lapGhost = new LapGhost(scene);
physics.bestLap = lapGhost.best?.time ?? null;
const input = new InputManager();
const gameShell = document.querySelector('.game-shell');
const touchControlsElement = document.getElementById('touch-controls');
const mobileControlsToggle = document.getElementById('mobile-controls-toggle');
const resetButton = document.getElementById('reset-button');
const cameraButton = document.getElementById('camera-button');
const exitButton = document.getElementById('exit-button');
const mobileControls = new MobileControls(document.getElementById('touch-steer'), document.getElementById('touch-pedal'));
let mobileControlsEnabled;
try {
  const savedMobileSetting = localStorage.getItem('frasnelli-mobile-controls-enabled');
  mobileControlsEnabled = savedMobileSetting === null ? matchMedia('(pointer: coarse)').matches : savedMobileSetting === 'true';
} catch { mobileControlsEnabled = matchMedia('(pointer: coarse)').matches; }
mobileControls.setEnabled(mobileControlsEnabled);
mobileControlsToggle.checked = mobileControlsEnabled;
let aiDriver = new RacingDriver();
const camera = new THREE.PerspectiveCamera(67, window.innerWidth / window.innerHeight, .08, 900);
let cameraMode = 0;
let running = false;
let paused = false;
let noticeTimer = 0;
let curbHapticTime = 0;
let aiEnabled = false;
let replayActive = false;
let replayTime = 0;
let replayHold = 0;
let replayFrame = null;
let humanLapBuckets = createHumanLapBuckets();

function createHumanLapBuckets() {
  return Array.from({ length: RACING_LINE_POINTS.length }, () => ({
    count: 0, x: 0, y: 0, z: 0, offset: 0, speed: 0, throttle: 0, brake: 0, steer: 0,
  }));
}

function resetHumanLapCapture() { humanLapBuckets = createHumanLapBuckets(); }

function captureHumanLapSample(driverInput) {
  if (aiEnabled || !physics.trackPose) return;
  const bucket = humanLapBuckets[physics.trackPose.index];
  bucket.count++;
  bucket.x += physics.position.x;
  bucket.y += physics.position.y + .025;
  bucket.z += physics.position.z;
  bucket.offset += physics.trackPose.signedDistance;
  bucket.speed += physics.speedKmh();
  bucket.throttle += driverInput.throttle;
  bucket.brake += driverInput.brake;
  bucket.steer += driverInput.steer;
}

function humanLapPoints() {
  return humanLapBuckets.map((bucket, index) => {
    const fallback = RACING_LINE_POINTS[index];
    if (!bucket.count) return { ...fallback };
    const throttle = bucket.throttle / bucket.count;
    const brake = bucket.brake / bucket.count;
    return {
      x: bucket.x / bucket.count,
      y: bucket.y / bucket.count,
      z: bucket.z / bucket.count,
      offset: bucket.offset / bucket.count,
      curvature: fallback.curvature,
      speed: bucket.speed / bucket.count,
      throttle,
      brake,
      steer: bucket.steer / bucket.count,
      mode: brake > .055 ? 'brake' : throttle > .14 ? 'accel' : 'coast',
    };
  });
}

function loadHumanBest() {
  try { return JSON.parse(localStorage.getItem('frasnelli-human-best')); }
  catch { return null; }
}

async function saveHumanLap(time, points) {
  const previous = loadHumanBest();
  if (previous && previous.time <= time) return;
  const lap = { time, driverWeight: physics.driverWeight, recordedAt: new Date().toISOString(), points };
  localStorage.setItem('frasnelli-human-best', JSON.stringify(lap));
  try {
    const response = await fetch('/api/laps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lap) });
    const result = await response.json();
    if (result.accepted) {
      const trainingState = result.training?.queued ? 'Training vorgemerkt' : 'Training läuft im Hintergrund';
      showNotice(`Deine ${formatTime(time)} ist neuer Ghost-Benchmark · globale KI ohne Fahrerlinie: ${trainingState}`, 6);
    }
  } catch { /* Production builds keep the lap in localStorage. */ }
}

function configureAiDriver() {
  aiDriver = new RacingDriver();
  return null;
}

class EngineAudio {
  constructor() { this.ready = false; }
  start() {
    if (this.ready) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain(); this.master.gain.value = .18; this.master.connect(this.ctx.destination);
    this.filter = this.ctx.createBiquadFilter(); this.filter.type = 'lowpass'; this.filter.frequency.value = 1400; this.filter.Q.value = 1.2; this.filter.connect(this.master);
    this.engine = this.ctx.createOscillator(); this.engine.type = 'sawtooth'; this.engineGain = this.ctx.createGain(); this.engineGain.gain.value = .12; this.engine.connect(this.engineGain).connect(this.filter); this.engine.start();
    this.sub = this.ctx.createOscillator(); this.sub.type = 'square'; this.subGain = this.ctx.createGain(); this.subGain.gain.value = .055; this.sub.connect(this.subGain).connect(this.filter); this.sub.start();
    const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
    const data = buffer.getChannelData(0); for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = this.ctx.createBufferSource(); this.noise.buffer = buffer; this.noise.loop = true;
    this.noiseFilter = this.ctx.createBiquadFilter(); this.noiseFilter.type = 'bandpass'; this.noiseFilter.frequency.value = 1800;
    this.noiseGain = this.ctx.createGain(); this.noiseGain.gain.value = 0; this.noise.connect(this.noiseFilter).connect(this.noiseGain).connect(this.master); this.noise.start();
    this.ready = true;
  }
  update(rpm, throttle, slip, surface) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const frequency = 48 + rpm / 60 * 1.55;
    this.engine.frequency.setTargetAtTime(frequency, now, .035);
    this.sub.frequency.setTargetAtTime(frequency * .5, now, .04);
    this.engineGain.gain.setTargetAtTime(.07 + throttle * .15, now, .05);
    this.filter.frequency.setTargetAtTime(720 + throttle * 1900 + rpm * .08, now, .05);
    const tire = Math.min(.2, Math.max(0, slip - .13) * .9) + (surface === 'GRASS' ? .045 : 0);
    this.noiseGain.gain.setTargetAtTime(tire, now, .06);
  }
}
const audio = new EngineAudio();

const hud = {
  lap: document.getElementById('lap'), lapTime: document.getElementById('lap-time'), best: document.getElementById('best-time'),
  speed: document.getElementById('speed'), surface: document.getElementById('surface'), rpm: document.getElementById('rpm'),
  gas: document.getElementById('gas-bar'), brake: document.getElementById('brake-bar'), notice: document.getElementById('notice'),
  reference: document.getElementById('reference-time'), driveMode: document.getElementById('drive-mode'),
};

function formatTime(seconds) {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const minutes = Math.floor(seconds / 60); const secs = Math.floor(seconds % 60); const ms = Math.floor((seconds % 1) * 1000);
  return `${minutes}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function showNotice(message, duration = 2) {
  hud.notice.textContent = message; hud.notice.classList.add('show'); noticeTimer = duration;
}

function refreshControlSurfaces() {
  const touchActive = mobileControlsEnabled && running && !replayActive;
  touchControlsElement.classList.toggle('active', touchActive);
  touchControlsElement.setAttribute('aria-hidden', String(!touchActive));
  gameShell.classList.toggle('touch-active', touchActive);
  resetButton.classList.toggle('active', running && !replayActive);
  cameraButton.classList.toggle('active', touchActive);
  exitButton.classList.toggle('active', touchActive);
  if (!touchActive) mobileControls.reset();
}

function setMobileControlsEnabled(enabled) {
  mobileControlsEnabled = Boolean(enabled);
  mobileControls.setEnabled(mobileControlsEnabled);
  mobileControlsToggle.checked = mobileControlsEnabled;
  try { localStorage.setItem('frasnelli-mobile-controls-enabled', String(mobileControlsEnabled)); } catch {}
  refreshControlSurfaces();
  populateAxes();
}

const ghostVisible = document.getElementById('ghost-visible');
const ghostLead = document.getElementById('ghost-lead');
const ghostLeadValue = document.getElementById('ghost-lead-value');
const ghostBest = document.getElementById('ghost-best');
const ghostReplayButton = document.getElementById('ghost-replay-btn');
const ghostExportButton = document.getElementById('ghost-export-btn');
function refreshGhostControls() {
  ghostVisible.checked = lapGhost.enabled;
  ghostVisible.disabled = !lapGhost.best;
  ghostLead.value = String(lapGhost.lead);
  ghostLeadValue.value = `${lapGhost.lead.toFixed(1).replace('.', ',')} s`;
  const ghostSource = lapGhost.bestSource === 'local' ? 'Persönlich' : 'Referenz';
  ghostBest.textContent = lapGhost.best ? `${ghostSource} ${formatTime(lapGhost.best.time)}` : 'Kein Ghost gespeichert';
  ghostReplayButton.disabled = !lapGhost.best;
  ghostReplayButton.textContent = lapGhost.best ? `Ghost-Replay · ${ghostSource} ${formatTime(lapGhost.best.time)}` : 'Kein Ghost-Replay';
  ghostExportButton.disabled = !lapGhost.localBest;
}

function exportPersonalGhost() {
  const lap = lapGhost.localBest;
  if (!lap) return;
  const publicLap = { version: 1, time: lap.time, driverWeight: lap.driverWeight, samples: lap.samples };
  const blob = new Blob([JSON.stringify(publicLap)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `frasnelli-ghost-${lap.time.toFixed(3)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showNotice('Persönlicher Ghost exportiert');
}

let racingLineVisible = localStorage.getItem('frasnelli-racing-line-visible') !== 'false';
const racingLineToggle = document.getElementById('racing-line-visible');
function setRacingLineVisible(visible) {
  racingLineVisible = Boolean(visible);
  track.racingLine.visible = racingLineVisible;
  racingLineToggle.checked = racingLineVisible;
  try { localStorage.setItem('frasnelli-racing-line-visible', String(racingLineVisible)); } catch {}
}
ghostVisible.addEventListener('change', () => lapGhost.setEnabled(ghostVisible.checked));
racingLineToggle.addEventListener('change', () => setRacingLineVisible(racingLineToggle.checked));
mobileControlsToggle.addEventListener('change', () => setMobileControlsEnabled(mobileControlsToggle.checked));
ghostLead.addEventListener('input', () => {
  lapGhost.setLead(ghostLead.value);
  ghostLeadValue.value = `${lapGhost.lead.toFixed(1).replace('.', ',')} s`;
});
refreshGhostControls();
setRacingLineVisible(racingLineVisible);
refreshControlSurfaces();

hud.reference.textContent = formatTime(RACING_LINE_LAP_TIME);
physics.onLap = ({ time, valid, best }) => {
  const delta = time - RACING_LINE_LAP_TIME;
  const comparison = `${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(3)} s zur KI-Bestzeit`;
  if (!aiEnabled && valid) void saveHumanLap(time, humanLapPoints());
  const newGhost = !aiEnabled && lapGhost.finish(time, valid, physics);
  if (newGhost) refreshGhostControls();
  resetHumanLapCapture();
  showNotice(valid ? `Runde ${formatTime(time)} · ${comparison} · Best ${formatTime(best)}${newGhost ? ' · Neuer Ghost' : ''}` : `Runde ${formatTime(time)} · ungültig`, 5);
};
physics.onImpact = strength => { input.haptic(.35 + strength * .5, 130); showNotice('Leitplanke', 1.1); };

function updateCamera(dt) {
  const position = replayActive ? kart.position : physics.position;
  let forward;
  let right;
  let slope;
  let steerAngle;
  let lateralVelocity;
  let speedMs;
  if (replayActive) {
    const orientedForward = new THREE.Vector3(0, 0, -1).applyQuaternion(kart.quaternion);
    slope = orientedForward.y;
    forward = orientedForward.setY(0).normalize();
    right = new THREE.Vector3(-forward.z, 0, forward.x);
    steerAngle = replayFrame?.steerAngle ?? 0;
    lateralVelocity = 0;
    speedMs = (replayFrame?.speedKmh ?? 0) / 3.6;
  } else {
    const heading = physics.heading;
    forward = new THREE.Vector3(-Math.sin(heading), 0, -Math.cos(heading));
    right = new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading));
    slope = physics.trackPose?.tangent?.y ?? 0;
    steerAngle = physics.steerAngle;
    lateralVelocity = physics.v;
    speedMs = physics.speedKmh() / 3.6;
  }
  let desired, target;
  if (cameraMode === 0) {
    desired = position.clone().addScaledVector(forward, -5.6).addScaledVector(right, lateralVelocity * .04).add(new THREE.Vector3(0, 2.75, 0));
    target = position.clone().addScaledVector(forward, 3.2).add(new THREE.Vector3(0, .72, 0));
    camera.position.lerp(desired, 1 - Math.exp(-6.5 * dt));
  } else {
    // Rigid driver-eye camera: no chase-camera lag under acceleration or yaw.
    desired = position.clone().addScaledVector(forward, -.18).add(new THREE.Vector3(0, 1.27, 0));
    target = desired.clone().addScaledVector(forward, 14).addScaledVector(right, -steerAngle * 1.2);
    target.y += slope * 14 - .12;
    camera.position.copy(desired);
  }
  kart.userData.helmet.visible = cameraMode === 0;
  kart.userData.visor.visible = cameraMode === 0;
  camera.lookAt(target);
  const speedFov = cameraMode === 0 ? 65 + speedMs * .32 : 72 + speedMs * .42;
  camera.fov = THREE.MathUtils.damp(camera.fov, speedFov, 5, dt); camera.updateProjectionMatrix();
}

const minimap = document.getElementById('minimap');
const mini = minimap.getContext('2d');
const miniPoints = track.samples.map(s => s.point);
const miniBounds = miniPoints.reduce((b,p) => ({ minX:Math.min(b.minX,p.x),maxX:Math.max(b.maxX,p.x),minZ:Math.min(b.minZ,p.z),maxZ:Math.max(b.maxZ,p.z) }), {minX:Infinity,maxX:-Infinity,minZ:Infinity,maxZ:-Infinity});
function drawMinimap() {
  const w = minimap.width, h = minimap.height, pad = 18;
  const scale = Math.min((w-pad*2)/(miniBounds.maxX-miniBounds.minX),(h-pad*2)/(miniBounds.maxZ-miniBounds.minZ));
  const map = p => ({ x:(p.x-miniBounds.minX)*scale+pad, y:(p.z-miniBounds.minZ)*scale+pad });
  mini.clearRect(0,0,w,h); mini.lineJoin='round'; mini.lineCap='round'; mini.strokeStyle='rgba(255,255,255,.2)'; mini.lineWidth=13; mini.beginPath();
  miniPoints.forEach((p,i)=>{const q=map(p); i?mini.lineTo(q.x,q.y):mini.moveTo(q.x,q.y)}); mini.closePath(); mini.stroke();
  mini.lineWidth=3;
  for (let i = 0; i < RACING_LINE_POINTS.length; i++) {
    const a = map(RACING_LINE_POINTS[i]); const b = map(RACING_LINE_POINTS[(i + 1) % RACING_LINE_POINTS.length]);
    mini.strokeStyle = RACING_LINE_POINTS[i].mode === 'brake' ? '#ff3e36' : RACING_LINE_POINTS[i].mode === 'accel' ? '#35ed72' : '#ffc43d';
    mini.beginPath(); mini.moveTo(a.x,a.y); mini.lineTo(b.x,b.y); mini.stroke();
  }
  const k=map(replayActive ? kart.position : physics.position); mini.fillStyle='#ffffff'; mini.beginPath(); mini.arc(k.x,k.y,6,0,Math.PI*2); mini.fill();
  if (lapGhost.visual.visible) {
    const g=map(lapGhost.visual.position); mini.fillStyle='#47d9ff'; mini.beginPath(); mini.arc(g.x,g.y,5,0,Math.PI*2); mini.fill();
  }
}

function updateHud(currentInput) {
  if (replayActive) {
    const speedKmh = replayFrame?.speedKmh ?? 0;
    hud.lap.textContent = '1';
    hud.lapTime.textContent = formatTime(replayTime);
    hud.best.textContent = formatTime(lapGhost.best?.time ?? null);
    hud.speed.textContent = String(Math.round(speedKmh));
    hud.surface.textContent = 'Replay';
    hud.rpm.style.width = `${THREE.MathUtils.clamp(speedKmh / 72.9 * 100, 0, 100)}%`;
    hud.gas.style.height = '0%';
    hud.brake.style.height = '0%';
    hud.driveMode.textContent = 'GHOST REPLAY';
    hud.driveMode.classList.add('active');
    if (noticeTimer > 0) noticeTimer -= 1/60; else hud.notice.classList.remove('show');
    return;
  }
  hud.lap.textContent = String(physics.lap);
  hud.lapTime.textContent = formatTime(physics.lapTime);
  hud.best.textContent = formatTime(lapGhost.best?.time ?? physics.bestLap);
  hud.speed.textContent = String(Math.round(physics.speedKmh()));
  hud.surface.textContent = physics.surface;
  hud.rpm.style.width = `${THREE.MathUtils.clamp((physics.telemetry.rpm - 1700) / 2100 * 100, 0, 100)}%`;
  hud.gas.style.height = `${currentInput.throttle * 100}%`;
  hud.brake.style.height = `${currentInput.brake * 100}%`;
  hud.driveMode.textContent = aiEnabled ? `KI · ${Math.round(currentInput.targetKmh || 0)} km/h` : currentInput.source === 'TOUCH' ? 'MOBIL' : 'DU';
  hud.driveMode.classList.toggle('active', aiEnabled || currentInput.source === 'TOUCH');
  if (noticeTimer > 0) noticeTimer -= 1/60; else hud.notice.classList.remove('show');
}

function populateAxes() {
  const pads = input.scanGamepads(); const pad = input.gamepad;
  const state = document.getElementById('device-state');
  document.getElementById('device-summary').textContent = mobileControlsEnabled ? 'Mobile Touch' : pad ? (/G923/i.test(pad.id) ? 'Logitech G923' : 'Lenkrad') : 'Tastatur';
  state.textContent = pad ? `${pad.id} · ${pad.axes.length} Achsen erkannt` : 'Noch kein Lenkrad erkannt. Pedal oder Taste am G923 drücken und „Erneut suchen“ wählen.';
  state.classList.toggle('connected', Boolean(pad));
  for (const [id, value] of [['steer-axis',input.mapping.steer],['throttle-axis',input.mapping.throttle],['brake-axis',input.mapping.brake]]) {
    const select = document.getElementById(id); const count = pad?.axes.length || 4;
    select.innerHTML = Array.from({length:count},(_,i)=>`<option value="${i}" ${i===value?'selected':''}>Achse ${i}</option>`).join('');
  }
  document.getElementById('invert-steer').checked = input.mapping.invertSteer;
  document.getElementById('invert-throttle').checked = input.mapping.invertThrottle;
  document.getElementById('invert-brake').checked = input.mapping.invertBrake;
  document.getElementById('wheel-range').value = String(input.mapping.wheelRange || 270);
  return pads;
}

function saveCalibration() {
  input.saveMapping({
    steer: Number(document.getElementById('steer-axis').value), throttle: Number(document.getElementById('throttle-axis').value), brake: Number(document.getElementById('brake-axis').value),
    invertSteer: document.getElementById('invert-steer').checked, invertThrottle: document.getElementById('invert-throttle').checked, invertBrake: document.getElementById('invert-brake').checked,
    wheelRange: Number(document.getElementById('wheel-range').value),
  });
  document.getElementById('calibration').classList.add('hidden');
  showNotice(input.gamepad ? 'Lenkrad-Kalibrierung gespeichert' : 'Kalibrierung gespeichert');
}

function updateAxisMeters() {
  const values = input.axisValues();
  for (const [selectId,meterId] of [['steer-axis','steer-meter'],['throttle-axis','throttle-meter'],['brake-axis','brake-meter']]) {
    const index=Number(document.getElementById(selectId).value||0); const value=values[index]??0;
    document.getElementById(meterId).style.width=`${(value+1)*50}%`;
  }
}

function resetKartToStart() {
  physics.reset();
  aiDriver.reset();
  mobileControls.reset();
  resetHumanLapCapture();
  lapGhost.resetRecording(physics);
  showNotice('Kart zurückgesetzt');
}

function toggleCamera() {
  cameraMode = (cameraMode + 1) % 2;
  showNotice(cameraMode ? 'Cockpitkamera' : 'Verfolgerkamera');
}

function exitToMenu() {
  if (replayActive) {
    endGhostReplay(true);
    return;
  }
  running = false;
  paused = false;
  aiEnabled = false;
  mobileControls.reset();
  document.getElementById('start-screen').classList.remove('hidden');
  refreshControlSurfaces();
}

function endGhostReplay(showMenu = true) {
  replayActive = false;
  replayTime = 0;
  replayHold = 0;
  replayFrame = null;
  running = false;
  paused = false;
  lapGhost.resetPlayback();
  lapGhost.visual.visible = false;
  physics.reset();
  kart.visible = true;
  if (showMenu) document.getElementById('start-screen').classList.remove('hidden');
  refreshControlSurfaces();
}

function startGhostReplay() {
  if (!lapGhost.best) return;
  physics.reset();
  resetHumanLapCapture();
  lapGhost.resetPlayback();
  lapGhost.visual.visible = false;
  replayActive = true;
  replayTime = 0;
  replayHold = 0;
  replayFrame = lapGhost.playAt(0, 0, kart);
  running = false;
  paused = false;
  aiEnabled = false;
  currentInput = { steer: 0, throttle: 0, brake: 0, source: 'GHOST REPLAY' };
  audio.start();
  document.getElementById('start-screen').classList.add('hidden');
  refreshControlSurfaces();
  showNotice(`Ghost-Replay · ${formatTime(lapGhost.best.time)} · Esc zurück`, 4);
}

function startSession(withAi) {
  if (replayActive) endGhostReplay(false);
  physics.setDriverWeight(document.getElementById('driver-weight').value);
  const humanSeed = withAi ? configureAiDriver() : null;
  physics.reset(); aiDriver.reset(); resetHumanLapCapture(); lapGhost.resetRecording(physics); aiEnabled = withAi; audio.start(); running = true; paused = false;
  document.getElementById('start-screen').classList.add('hidden');
  refreshControlSurfaces();
  showNotice(withAi ? humanSeed ? `KI folgt deiner ${formatTime(humanSeed.time)} als Lernbasis` : `KI-Fahrer aktiv · schnellste simulierte Runde ${formatTime(RACING_LINE_LAP_TIME)} bei ${RACING_LINE_REFERENCE_WEIGHT} kg` : 'Boxenausfahrt frei · Reifen kalt', 4);
}
document.getElementById('start-btn').addEventListener('click', () => startSession(false));
document.getElementById('ai-btn').addEventListener('click', () => startSession(true));
ghostReplayButton.addEventListener('click', startGhostReplay);
ghostExportButton.addEventListener('click', exportPersonalGhost);
resetButton.addEventListener('click', resetKartToStart);
cameraButton.addEventListener('click', toggleCamera);
exitButton.addEventListener('click', exitToMenu);
document.getElementById('calibrate-btn').addEventListener('click', () => { populateAxes(); document.getElementById('calibration').classList.remove('hidden'); });
document.getElementById('scan-btn').addEventListener('click', populateAxes);
document.getElementById('save-calibration').addEventListener('click', saveCalibration);
input.onDeviceChange = populateAxes;

window.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (replayActive) {
    if (e.code === 'KeyC') toggleCamera();
    if (e.code === 'Escape') endGhostReplay(true);
    return;
  }
  if (e.code === 'KeyC') toggleCamera();
  if (e.code === 'KeyR') resetKartToStart();
  if (e.code === 'KeyG' && lapGhost.best) { lapGhost.setEnabled(!lapGhost.enabled); refreshGhostControls(); showNotice(lapGhost.enabled ? 'Ghost sichtbar' : 'Ghost ausgeblendet'); }
  if (e.code === 'KeyL') { setRacingLineVisible(!racingLineVisible); showNotice(racingLineVisible ? 'Optimallinie sichtbar' : 'Optimallinie ausgeblendet'); }
  if (e.code === 'KeyI' && running) {
    aiEnabled = !aiEnabled;
    if (aiEnabled) configureAiDriver();
    aiDriver.reset(); physics.reset(); resetHumanLapCapture(); lapGhost.resetRecording(physics);
    showNotice(aiEnabled ? `KI-Fahrer aktiv · Bestzeit ${formatTime(RACING_LINE_LAP_TIME)}` : 'Fahrersteuerung aktiv', 3);
  }
  if (e.code === 'KeyP' && running) { paused = !paused; showNotice(paused ? 'Pause' : 'Weiter'); }
  if (e.code === 'Escape') exitToMenu();
});

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
});

const clock = new THREE.Clock();
let accumulator = 0;
const fixedStep = 1 / 120;
let currentInput = { steer:0, throttle:0, brake:0, source:'TASTATUR' };
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), .05);
  const manualInput = mobileControlsEnabled ? mobileControls.getInput(dt) : input.getInput(dt);
  if (replayActive) {
    const duration = lapGhost.best?.time ?? 0;
    if (replayTime < duration) {
      replayTime = Math.min(duration, replayTime + dt);
      replayFrame = lapGhost.playAt(replayTime, dt, kart);
    } else {
      replayHold += dt;
      if (replayHold >= 1.25) endGhostReplay(true);
    }
    currentInput = { steer: 0, throttle: 0, brake: 0, source: 'GHOST REPLAY' };
  } else if (running && !paused) {
    accumulator = Math.min(accumulator + dt, .1);
    while (accumulator >= fixedStep) {
      currentInput = aiEnabled ? aiDriver.update(fixedStep, physics) : manualInput;
      physics.update(fixedStep, currentInput);
      if (!aiEnabled) { captureHumanLapSample(currentInput); lapGhost.capture(fixedStep, physics); }
      accumulator -= fixedStep;
    }
    if (physics.telemetry.curb && performance.now() - curbHapticTime > 130) { input.haptic(.18, 45); curbHapticTime = performance.now(); }
  } else if (!aiEnabled) currentInput = manualInput;
  if (!replayActive) lapGhost.update(physics, dt);
  updateCamera(dt); updateHud(currentInput); drawMinimap(); updateAxisMeters();
  if (replayActive) {
    const speedKmh = replayFrame?.speedKmh ?? 0;
    audio.update(1700 + speedKmh / 72.9 * 2100, .45, 0, 'ASPHALT');
  } else {
    audio.update(physics.telemetry.rpm, currentInput.throttle, physics.telemetry.slip, physics.surface);
  }
  renderer.render(scene, camera);
}

populateAxes();
updateCamera(1);
frame();

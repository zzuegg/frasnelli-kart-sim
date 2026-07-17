import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const liveDataPath = resolve(projectRoot, 'src/generated/racing-line-data.js');
const shadowDirectory = resolve(projectRoot, '.ai-training');
const dataPath = resolve(shadowDirectory, 'global-racing-line-data.js');
const targetTime = Number(process.env.AI_GLOBAL_TARGET_TIME || 57.5);
const maximumGenerations = Number(process.env.AI_GLOBAL_GENERATIONS || 20);
const plateauLimit = Number(process.env.AI_GLOBAL_PLATEAU_GENERATIONS || 8);

await mkdir(shadowDirectory, { recursive: true });
try { await access(dataPath); }
catch { await copyFile(liveDataPath, dataPath); }

async function currentLapTime() {
  const source = await readFile(dataPath, 'utf8');
  const match = source.match(/RACING_LINE_LAP_TIME\s*=\s*([\d.]+)/);
  if (!match) throw new Error('Globale KI-Bestzeit konnte nicht gelesen werden.');
  return Number(match[1]);
}

function runGeneration(exploration = 1) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [resolve(here, 'train-ai-driver.mjs'), '--shadow', '--global'], {
      cwd: projectRoot,
      env: { ...process.env, AI_GLOBAL: '1', AI_GLOBAL_EXPLORATION: String(exploration) },
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', rejectPromise);
    child.on('exit', code => code === 0 ? resolvePromise() : rejectPromise(new Error(`Globale KI-Generation endete mit Code ${code}.`)));
  });
}

let best = await currentLapTime();
let plateau = 0;
console.log(`Globale KI startet bei ${best.toFixed(3)} s; Ziel ${targetTime.toFixed(3)} s. Fahreraufzeichnungen werden nicht verwendet.`);
for (let generation = 1; generation <= maximumGenerations && best > targetTime; generation++) {
  const before = best;
  const exploration = plateau < 2 ? 1 : Math.min(3.2, 1 + (plateau - 1) * .55);
  await runGeneration(exploration);
  best = await currentLapTime();
  const improvement = before - best;
  plateau = improvement > .005 ? 0 : plateau + 1;
  console.log(`Globale Generation ${generation}: ${best.toFixed(3)} s (${improvement > 0 ? `−${improvement.toFixed(3)}` : 'keine Verbesserung'}).`);
  if (plateau >= plateauLimit) {
    console.log(`Stopp nach ${plateauLimit} Generationen ohne relevante Verbesserung.`);
    break;
  }
}
console.log(`Globale KI beendet: ${best.toFixed(3)} s. Eine schnellere Linie kann mit "npm run ai:apply" einmalig übernommen werden.`);

import { copyFile, readFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { KART_PHYSICS_VERSION } from '../src/kart.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const shadowPaths = [resolve(projectRoot, '.ai-training/global-racing-line-data.js')];
if (process.env.AI_APPLY_REPLAY === '1') shadowPaths.push(resolve(projectRoot, '.ai-training/racing-line-data.js'));
const livePath = resolve(projectRoot, 'src/generated/racing-line-data.js');
const temporaryPath = resolve(projectRoot, 'src/generated/racing-line-data.apply.tmp');

const lapTime = source => Number(source.match(/RACING_LINE_LAP_TIME\s*=\s*([\d.]+)/)?.[1]);
const physicsVersion = source => Number(source.match(/RACING_LINE_PHYSICS_VERSION\s*=\s*(\d+)/)?.[1]);
const liveSource = await readFile(livePath, 'utf8');
const trained = [];
for (const path of shadowPaths) {
  try {
    const source = await readFile(path, 'utf8');
    const time = lapTime(source);
    const version = physicsVersion(source);
    if (Number.isFinite(time) && time > 35 && time < 180 && version === KART_PHYSICS_VERSION) trained.push({ path, time, version });
  } catch {}
}
if (!trained.length) throw new Error('Kein gültiger KI-Trainingsstand gefunden.');
trained.sort((a, b) => a.time - b.time);
const fastest = trained[0];
const shadowTime = fastest.time;
const liveTime = lapTime(liveSource);
const liveVersion = physicsVersion(liveSource);
if (liveVersion === KART_PHYSICS_VERSION && Number.isFinite(liveTime) && shadowTime >= liveTime) {
  console.log(`Keine Übernahme: Trainingsstand ${shadowTime.toFixed(3)} s ist nicht schneller als Spielstand ${liveTime.toFixed(3)} s.`);
  process.exit(0);
}
await copyFile(fastest.path, temporaryPath);
await rename(temporaryPath, livePath);
console.log(`KI-Linie übernommen: ${liveTime.toFixed(3)} s → ${shadowTime.toFixed(3)} s. Das Spiel lädt genau einmal neu.`);

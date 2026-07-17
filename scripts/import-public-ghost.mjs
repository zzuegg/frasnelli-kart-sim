import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error('Bitte eine exportierte Ghost-Datei angeben.');

const source = JSON.parse(await readFile(resolve(sourcePath), 'utf8'));
const valid = Number.isFinite(source?.time)
  && source.time > 20
  && source.time < 300
  && Array.isArray(source.samples)
  && source.samples.length > 100
  && source.samples.every(sample => Array.isArray(sample) && sample.length >= 11 && sample.every(Number.isFinite));
if (!valid) throw new Error('Die Ghost-Datei ist ungültig.');

const reference = {
  version: 1,
  publicReference: true,
  time: Number(source.time.toFixed(3)),
  driverWeight: Number(source.driverWeight) || 70,
  samples: source.samples.map(sample => sample.slice(0, 11)),
};
const output = `// Generated public reference ghost. Contains no name, device id or timestamp.\nexport const REFERENCE_GHOST = ${JSON.stringify(reference)};\n`;
await writeFile(resolve('src/generated/reference-ghost-data.js'), output, 'utf8');
console.log(`Public ghost imported: ${reference.time.toFixed(3)} s, ${reference.samples.length} samples.`);

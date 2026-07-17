import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs work both on GitHub Pages (repository subpath) and locally.
  base: './',
  plugins: [{
    name: 'frasnelli-human-lap-recorder',
    configureServer(server) {
      let optimizerProcess = null;
      let optimizerQueued = false;
      const startOptimizer = () => {
        if (optimizerProcess) {
          optimizerQueued = true;
          return { started: false, queued: true };
        }
        const projectRoot = process.cwd();
        const child = spawn(process.execPath, [resolve(projectRoot, 'scripts/optimize-ai-global.mjs')], {
          cwd: projectRoot,
          env: { ...process.env, AI_SHADOW: '1' },
          stdio: 'inherit',
          windowsHide: true,
        });
        optimizerProcess = child;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          optimizerProcess = null;
          if (optimizerQueued) {
            optimizerQueued = false;
            startOptimizer();
          }
        };
        child.once('error', finish);
        child.once('exit', finish);
        return { started: true, queued: false };
      };

      server.middlewares.use('/api/laps', (request, response, next) => {
        if (request.method !== 'POST') return next();
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => {
          body += chunk;
          if (body.length > 2_000_000) request.destroy();
        });
        request.on('end', async () => {
          try {
            const lap = JSON.parse(body);
            if (!Number.isFinite(lap.time) || lap.time < 30 || lap.time > 180 || !Array.isArray(lap.points) || lap.points.length < 900) {
              throw new Error('Ungültige Rundendaten');
            }
            const directory = resolve(process.cwd(), '.ai-training');
            const target = resolve(directory, 'human-best.json');
            const temporary = `${target}.tmp`;
            await mkdir(directory, { recursive: true });
            let previousTime = Infinity;
            try { previousTime = JSON.parse(await readFile(target, 'utf8')).time; } catch {}
            const accepted = lap.time < previousTime;
            if (accepted) {
              await writeFile(temporary, JSON.stringify(lap), 'utf8');
              await rename(temporary, target);
            }
            const training = accepted ? startOptimizer() : { started: false, queued: false };
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ accepted, best: Math.min(previousTime, lap.time), training }));
          } catch (error) {
            response.statusCode = 400;
            response.end(JSON.stringify({ error: error.message }));
          }
        });
      });
    },
  }],
});

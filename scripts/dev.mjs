import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
const require = createRequire(import.meta.url);
await import('./build-electron.mjs');
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], {
  stdio: 'inherit',
  windowsHide: true,
});
let desktop;
function stop() {
  desktop?.kill();
  vite.kill();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (vite.exitCode !== null)
      throw new Error('The development server exited. Check whether port 5174 is in use.');
    try {
      ready = (await fetch('http://127.0.0.1:5174')).ok;
    } catch {
      /* Wait for local Vite. */
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('The development server did not become ready.');
  const env = { ...process.env, VITE_DEV_SERVER_URL: 'http://127.0.0.1:5174' };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = spawn(require('electron'), ['.'], { stdio: 'inherit', env, windowsHide: true });
  desktop.on('error', (error) => {
    console.error(error.message);
    stop();
  });
  await once(desktop, 'exit');
} finally {
  stop();
}

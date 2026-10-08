import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'codex-dashboard-smoke-'));
const fixtures = join(directory, 'fixtures');
await mkdir(join(fixtures, 'sessions'), { recursive: true });
const stamp = new Date().toISOString();
await writeFile(
  join(fixtures, 'sessions', 'fixture.jsonl'),
  [
    { type: 'session_meta', timestamp: stamp, payload: { id: 'fixture-session' } },
    { type: 'turn_context', timestamp: stamp, payload: { model: 'test-model' } },
    {
      type: 'event_msg',
      timestamp: stamp,
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 800,
            output_tokens: 200,
            cached_input_tokens: 400,
            total_tokens: 1000,
          },
          last_token_usage: {
            input_tokens: 800,
            output_tokens: 200,
            cached_input_tokens: 400,
            total_tokens: 1000,
          },
        },
        rate_limits: {
          limit_id: 'codex',
          plan_type: 'pro',
          primary: {
            used_percent: 25,
            window_minutes: 10080,
            resets_at: Math.floor(Date.now() / 1000) + 86400,
          },
        },
      },
    },
  ]
    .map(JSON.stringify)
    .join('\n') + '\n',
);
const env = {
  ...process.env,
  CODEX_DASHBOARD_SMOKE: '1',
  CODEX_DASHBOARD_USER_DATA: join(directory, 'app'),
  CODEX_DASHBOARD_FIXTURES: fixtures,
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
let output = '',
  errors = '';
try {
  const packaged = process.argv.includes('--packaged');
  const executable = packaged
    ? resolve('release/win-unpacked/Codex Dashboard.exe')
    : require('electron');
  const child = spawn(executable, packaged ? [] : ['.'], {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => {
    output += d;
  });
  child.stderr.on('data', (d) => {
    errors += d;
  });
  const timeout = setTimeout(() => child.kill(), 45000);
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  }).finally(() => clearTimeout(timeout));
  if (code !== 0 || !output.includes('CODEX_DASHBOARD_SMOKE_OK')) {
    console.error(output, errors);
    throw new Error(`Desktop smoke failed (exit ${code}).`);
  }
  console.log(output.trim());
} finally {
  const target = resolve(directory);
  if (
    dirname(target) === resolve(tmpdir()) &&
    basename(target).startsWith('codex-dashboard-smoke-')
  )
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

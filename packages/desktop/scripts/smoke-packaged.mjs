import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const desktopDir = resolve(scriptPath, '..', '..');
const executable = process.env.ALLEN_DESKTOP_APP_EXECUTABLE
  ?? resolve(desktopDir, 'release', 'mac-arm64', 'Allen.app', 'Contents', 'MacOS', 'Allen');

if (!existsSync(executable)) {
  console.error(`[desktop-smoke] Missing packaged app executable: ${executable}`);
  process.exit(1);
}

const userDataDir = mkdtempSync(resolve(tmpdir(), 'allen-desktop-smoke-'));
const child = spawn(executable, ['--smoke'], {
  env: {
    ...process.env,
    ALLEN_DESKTOP_SMOKE: '1',
    ALLEN_DISABLE_AUTO_UPDATE: '1',
    ALLEN_DESKTOP_USER_DATA_DIR: userDataDir,
    ELECTRON_ENABLE_LOGGING: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const timeout = setTimeout(() => {
  child.kill('SIGTERM');
  console.error('[desktop-smoke] Timed out waiting for packaged app smoke check');
  process.exit(1);
}, 90_000);

child.stdout.on('data', (chunk) => process.stdout.write(chunk));
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
child.on('exit', (code, signal) => {
  clearTimeout(timeout);
  rmSync(userDataDir, { recursive: true, force: true });
  if (code === 0) {
    console.log('[desktop-smoke] Packaged app smoke check passed');
    process.exit(0);
  }
  console.error(`[desktop-smoke] Packaged app exited with code=${code} signal=${signal ?? ''}`);
  process.exit(code ?? 1);
});

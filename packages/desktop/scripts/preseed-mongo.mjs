import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoBinary } from 'mongodb-memory-server-core';

const scriptPath = fileURLToPath(import.meta.url);
const desktopDir = resolve(scriptPath, '..', '..');
const downloadDir = resolve(desktopDir, 'assets', 'mongo-binaries');
const version = process.env.ALLEN_DESKTOP_MONGODB_VERSION;

await mkdir(downloadDir, { recursive: true });

const binaryPath = await MongoBinary.getPath({
  ...(version ? { version } : {}),
  downloadDir,
});
const seededPath = resolve(downloadDir, basename(binaryPath));
if (seededPath !== binaryPath) {
  await copyFile(binaryPath, seededPath);
  await chmod(seededPath, 0o755);
}

console.log(`[desktop] MongoDB binary ready: ${seededPath}`);

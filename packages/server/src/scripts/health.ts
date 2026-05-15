import dotenv from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSystemHealth, type HealthCheckStatus } from '../services/system-health.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '..', '..', '..', '.env'), quiet: true });

function mark(status: HealthCheckStatus): string {
  if (status === 'pass') return 'PASS';
  if (status === 'warn') return 'WARN';
  return 'FAIL';
}

function printText(summary: Awaited<ReturnType<typeof runSystemHealth>>): void {
  console.log(`Allen health: ${mark(summary.status)}`);
  console.log(`Generated: ${summary.generatedAt}`);
  console.log('');

  for (const check of summary.checks) {
    const required = check.required ? 'required' : 'optional';
    const version = check.version ? ` (${check.version})` : '';
    console.log(`${mark(check.status).padEnd(4)} ${check.label}${version} - ${required}`);
    console.log(`     ${check.detail}`);
    if (check.fix) {
      console.log(`     Fix: ${check.fix.summary}`);
      for (const command of check.fix.commands ?? []) {
        console.log(`          ${command}`);
      }
    }
  }
}

async function main(): Promise<void> {
  const json = process.argv.includes('--json');
  const summary = await runSystemHealth();

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printText(summary);
  }

  process.exitCode = summary.requiredPassed ? 0 : 1;
}

main().catch((err) => {
  console.error('[health] failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

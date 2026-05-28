import dotenv from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import { startAllenServer } from './server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '..', '..', '.env') });

process.on('uncaughtException', (err: Error) => {
  try {
    logger.error('uncaughtException', { error: err.message, stack: err.stack });
  } catch {
    console.error('uncaughtException', err);
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  try {
    logger.error('unhandledRejection', { error: err.message, stack: err.stack });
  } catch {
    console.error('unhandledRejection', reason);
  }
  process.exit(1);
});

let handle: Awaited<ReturnType<typeof startAllenServer>>;
try {
  handle = await startAllenServer({
    mode: 'web',
    host: process.env.HOST,
    port: Number.parseInt(process.env.PORT ?? '4023', 10),
    terminalWsPort: process.env.TERMINAL_WS_PORT
      ? Number.parseInt(process.env.TERMINAL_WS_PORT, 10)
      : undefined,
  });
} catch (err) {
  logger.error('Failed to start server', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
}

async function shutdown(signal: string): Promise<void> {
  logger.info('stopping Allen server', { component: 'server', signal });
  try {
    await handle.stop();
    process.exit(0);
  } catch (err) {
    logger.error('failed to stop Allen server cleanly', {
      component: 'server',
      signal,
      error: (err as Error).message,
    });
    process.exit(1);
  }
}

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });

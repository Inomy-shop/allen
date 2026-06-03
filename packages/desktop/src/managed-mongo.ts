import { basename, resolve } from 'node:path';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { MongoMemoryServer } from 'mongodb-memory-server';

export interface ManagedMongoRuntime {
  uri: string;
  dbPath: string;
  binaryDir: string;
  systemBinary: string | null;
  stop(): Promise<void>;
}

function findBundledMongoBinary(): string | null {
  if (!process.resourcesPath) return null;
  const root = resolve(process.resourcesPath, 'mongo-binaries');
  if (!existsSync(root)) return null;

  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      const full = resolve(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!st.isFile()) continue;
      const name = basename(full);
      if (name === 'mongod' || name.startsWith('mongod-')) return full;
    }
  }

  return null;
}

export async function startManagedMongo(dataDir: string, options: { port?: number } = {}): Promise<ManagedMongoRuntime> {
  const dbPath = resolve(dataDir, 'mongo-data');
  const binaryDir = resolve(dataDir, 'mongo-binaries');
  const systemBinary = process.env.ALLEN_DESKTOP_MONGOD_BINARY || findBundledMongoBinary();
  mkdirSync(dbPath, { recursive: true });
  mkdirSync(binaryDir, { recursive: true });

  const mongo = await MongoMemoryServer.create({
    binary: {
      ...(systemBinary ? { systemBinary } : {}),
      downloadDir: binaryDir,
    },
    instance: {
      ip: '127.0.0.1',
      port: options.port ?? 0,
      dbName: 'allen_desktop',
      dbPath,
      storageEngine: 'wiredTiger',
      args: ['--wiredTigerCacheSizeGB', '0.25'],
    },
  });

  return {
    uri: mongo.getUri('allen_desktop'),
    dbPath,
    binaryDir,
    systemBinary,
    stop: async () => {
      await mongo.stop({ doCleanup: false, force: false });
    },
  };
}

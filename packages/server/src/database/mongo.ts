import { MongoClient, type Db } from 'mongodb';
import { DB_NAME_DEFAULT } from '@allen/engine';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectDB(uri?: string): Promise<Db> {
  if (db) return db;

  const mongoUri = uri ?? process.env.MONGODB_URI ?? `mongodb://localhost:27017/${DB_NAME_DEFAULT}`;
  client = new MongoClient(mongoUri);
  await client.connect();
  db = client.db();

  console.log(`Connected to MongoDB: ${mongoUri}`);
  return db;
}

export function getDB(): Db {
  if (!db) throw new Error('Database not connected. Call connectDB() first.');
  return db;
}

export async function disconnectDB(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

// Graceful shutdown: close Allen's own MongoDB connection when the process
// exits. Without this, the MongoClient's background heartbeat timer keeps
// a live DocumentDB socket open until the OS forcibly closes it after death.
let _shutdownStarted = false;
async function _shutdown(signal: string): Promise<void> {
  if (_shutdownStarted) return;
  _shutdownStarted = true;
  console.log(`[mongo] ${signal} received — closing MongoDB client`);
  await disconnectDB().catch((err) => {
    console.warn('[mongo] disconnectDB during shutdown:', (err as Error).message);
  });
  process.exit(0);
}

process.once('SIGTERM', () => void _shutdown('SIGTERM'));
process.once('SIGINT',  () => void _shutdown('SIGINT'));

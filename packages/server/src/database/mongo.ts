import { MongoClient, type Db, type MongoClientOptions } from 'mongodb';
import { DB_NAME_DEFAULT } from '@allen/engine';
import { logger } from '../logger.js';

let client: MongoClient | null = null;
let db: Db | null = null;

function mongoClientOptionsForUri(uri: string): MongoClientOptions {
  try {
    const parsed = new URL(uri);
    const isLocalTunnel = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
    const usesTls = parsed.searchParams.get('tls') === 'true' || parsed.searchParams.get('ssl') === 'true';
    const hasExplicitHostnamePolicy = parsed.searchParams.has('tlsAllowInvalidHostnames');
    if (isLocalTunnel && usesTls && !hasExplicitHostnamePolicy) {
      // SSH tunnels terminate locally, but managed Mongo/DocumentDB certs are
      // issued for the remote cluster hostname. Keep CA validation while
      // relaxing hostname validation only for localhost tunnel URIs.
      return { tlsAllowInvalidHostnames: true };
    }
  } catch {
    // Let MongoClient surface URI parsing errors with its normal message.
  }
  return {};
}

export async function connectDB(uri?: string): Promise<Db> {
  if (db) return db;

  const mongoUri = uri ?? process.env.MONGODB_URI ?? `mongodb://localhost:27017/${DB_NAME_DEFAULT}`;
  client = new MongoClient(mongoUri, mongoClientOptionsForUri(mongoUri));
  await client.connect();
  db = client.db();

  const safeUri = mongoUri.replace(/\/\/([^@]+)@/, '//***@');
  logger.info('Connected to MongoDB', { component: 'mongo', uri: safeUri });
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

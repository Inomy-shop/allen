import type { Db } from 'mongodb';

export async function ensureIndexes(db: Db): Promise<void> {
  // Workflows
  await db.collection('workflows').createIndex({ name: 1 }, { unique: true });
  await db.collection('workflows').createIndex({ tags: 1 });

  // Roles
  await db.collection('roles').createIndex({ name: 1 }, { unique: true });

  // Executions
  await db.collection('executions').createIndex({ id: 1 }, { unique: true });
  await db.collection('executions').createIndex({ workflowId: 1 });
  await db.collection('executions').createIndex({ workflowName: 1 });
  await db.collection('executions').createIndex({ status: 1 });
  await db.collection('executions').createIndex({ startedAt: -1 });
  // Compound index for concurrency limit checks
  await db.collection('executions').createIndex({ workflowName: 1, status: 1 });

  // Traces
  await db.collection('execution_traces').createIndex({ executionId: 1, node: 1, attempt: 1 });
  await db.collection('execution_traces').createIndex({ executionId: 1, startedAt: 1 });

  // Checkpoints
  await db.collection('checkpoints').createIndex({ executionId: 1, createdAt: -1 });

  // Secrets
  await db.collection('secrets').createIndex({ key: 1 }, { unique: true });

  console.log('Database indexes ensured');
}

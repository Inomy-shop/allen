import type { Db } from 'mongodb';

export async function ensureIndexes(db: Db): Promise<void> {
  // Workflows
  await db.collection('workflows').createIndex({ name: 1 }, { unique: true });
  await db.collection('workflows').createIndex({ tags: 1 });

  // Agents
  await db.collection('agents').createIndex({ name: 1 }, { unique: true });

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

  // Repos
  await db.collection('repos').createIndex({ path: 1 }, { unique: true });
  await db.collection('repos').createIndex({ tags: 1 });
  await db.collection('repos').createIndex({ status: 1, lastUsedAt: -1 });

  // Execution Logs
  await db.collection('execution_logs').createIndex({ executionId: 1, timestamp: 1 });
  await db.collection('execution_logs').createIndex({ executionId: 1, node: 1, timestamp: 1 });

  // Learnings
  await db.collection('learnings').createIndex({ 'scope.level': 1, status: 1, confidence: -1 });
  await db.collection('learnings').createIndex({ 'scope.contextTags': 1 });
  await db.collection('learnings').createIndex({ 'scope.workflowName': 1 });
  await db.collection('learnings').createIndex({ 'scope.agentName': 1 });
  await db.collection('learnings').createIndex({ tags: 1 });
  await db.collection('learnings').createIndex({ status: 1, lastUsedAt: 1 });
  await db.collection('learnings').createIndex({ 'source.executionId': 1 });

  // Chat Sessions
  await db.collection('chat_sessions').createIndex({ status: 1, lastMessageAt: -1 });
  await db.collection('chat_sessions').createIndex({ claudeSessionId: 1 });

  // Chat Messages
  await db.collection('chat_messages').createIndex({ sessionId: 1, createdAt: 1 });

  // Agent Conversations (delegation threads)
  await db.collection('agent_conversations').createIndex({ chatSessionId: 1, startedAt: -1 });
  await db.collection('agent_conversations').createIndex({ fromAgent: 1, toAgent: 1 });
  await db.collection('agent_conversations').createIndex({ status: 1 });

  console.log('Database indexes ensured');
}

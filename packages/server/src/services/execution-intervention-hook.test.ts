import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionService } from './execution.service.js';
import type { WorkflowDef } from '@allen/engine';

async function waitForIntervention(db: Db, timeoutMs = 1000): Promise<Record<string, unknown>> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const doc = await db.collection('workflow_interventions').findOne({});
    if (doc) return doc as Record<string, unknown>;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('Timed out waiting for workflow intervention');
}

async function waitForSlackDeliveryAudit(db: Db, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const doc = await db.collection('workflow_interventions').findOne({
      slack_delivery: { $exists: true },
    });
    if (doc) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('Timed out waiting for Slack delivery audit update');
}

describe('ExecutionService intervention hook', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('execution-intervention-hook-test');
  });

  beforeEach(async () => {
    await db.collection('executions').deleteMany({});
    await db.collection('workflow_interventions').deleteMany({});
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  it('persists the model_recovery widget from input_required events', async () => {
    await db.collection('executions').insertOne({
      id: 'exec-hook-model-recovery',
      state: {},
    });

    const workflow: WorkflowDef = {
      name: 'model-recovery-widget-test',
      version: 1,
      nodes: {
        implement: { type: 'agent', agent: 'developer', prompt: 'Implement', outputs: { ok: 'ok' } },
      },
      edges: [],
    };

    const baseEmitter = { emit: vi.fn() };
    const service = new ExecutionService(db);
    const wrapped = (service as unknown as {
      wrapEmitterWithInterventionHook: (
        baseEmitter: typeof baseEmitter,
        executionId: string,
        workflow: WorkflowDef,
        input: Record<string, unknown>,
      ) => typeof baseEmitter;
    }).wrapEmitterWithInterventionHook(baseEmitter, 'exec-hook-model-recovery', workflow, {});

    wrapped.emit({
      event: 'input_required',
      data: {
        node: 'implement',
        prompt: 'Select a replacement provider and model',
        intervention: {
          kind: 'model_recovery',
          widget: 'model_recovery',
          severity: 'escalation',
          title: 'Model Recovery — implement',
          summary: 'The selected model failed.',
          question: 'Select a replacement provider and model',
          recoveryContext: {
            failedProvider: 'codex',
            failedModel: 'gpt-5.5',
            failureCategory: 'rate_limit_exhausted',
          },
          actions: [
            { id: 'retry_with_model', label: 'Retry with selected model', intent: 'retry' },
            { id: 'cancel', label: 'Cancel workflow', intent: 'reject' },
          ],
        },
      },
    } as Parameters<typeof baseEmitter.emit>[0]);

    expect(baseEmitter.emit).toHaveBeenCalledTimes(1);

    const intervention = await waitForIntervention(db);
    expect(intervention).toMatchObject({
      workflow_run_id: 'exec-hook-model-recovery',
      stage: 'implement',
      kind: 'model_recovery',
      widget: 'model_recovery',
      severity: 'escalation',
      title: 'Model Recovery — implement',
    });
    expect(intervention.recoveryContext).toMatchObject({
      failedProvider: 'codex',
      failedModel: 'gpt-5.5',
      failureCategory: 'rate_limit_exhausted',
    });

    // InterventionService dispatches Slack notification audit updates
    // asynchronously after creating the record. Wait for that best-effort
    // update so test teardown does not close Mongo while it is still in flight.
    await waitForSlackDeliveryAudit(db);
  });
});

import type { Response } from 'express';
import type { SSEEvent, EngineEventEmitter } from '@allen/engine';
import type { Db } from 'mongodb';

type SSEClient = {
  res: Response;
  executionId: string;
};

const clients: SSEClient[] = [];

let _db: Db | null = null;

export function setStreamDb(db: Db): void {
  _db = db;
}

export function addSSEClient(executionId: string, res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('\n');

  const client: SSEClient = { res, executionId };
  clients.push(client);

  res.on('close', () => {
    const idx = clients.indexOf(client);
    if (idx !== -1) clients.splice(idx, 1);
  });

  // Safety: also clean up on error
  res.on('error', () => {
    const idx = clients.indexOf(client);
    if (idx !== -1) clients.splice(idx, 1);
  });
}

export function broadcastToExecution(executionId: string, event: SSEEvent): void {
  const data = JSON.stringify(event.data);
  for (let i = clients.length - 1; i >= 0; i--) {
    const client = clients[i];
    if (client.executionId === executionId || client.executionId === '*') {
      try {
        client.res.write(`event: ${event.event}\ndata: ${data}\n\n`);
      } catch {
        // Client disconnected — remove it
        clients.splice(i, 1);
      }
    }
  }

  // Persist execution_log events to MongoDB (fire-and-forget)
  if (event.event === 'execution_log' && _db) {
    const logData = event.data as Record<string, unknown>;
    _db.collection('execution_logs').insertOne({
      ...logData,
      timestamp: logData.timestamp ?? new Date(),
    }).catch(() => {});
  }
}

/**
 * Broadcast an SSE event to subscribers of `executionId` WITHOUT persisting
 * it to Mongo. Used by spawn-tree log fan-out: the child execution already
 * wrote its own log row under its own executionId, and we just want the
 * parent's live stream to see a mirrored copy. Persisting a duplicate row
 * under the parent's executionId would double storage and confuse the
 * /logs endpoint's sort ordering.
 *
 * The parent's page sees the fanned-out event live via SSE, and the
 * /logs endpoint's union query surfaces the same data from the child's
 * stored rows on refresh / initial load.
 */
export function broadcastSSEOnly(executionId: string, event: SSEEvent): void {
  const data = JSON.stringify(event.data);
  for (let i = clients.length - 1; i >= 0; i--) {
    const client = clients[i];
    if (client.executionId === executionId || client.executionId === '*') {
      try {
        client.res.write(`event: ${event.event}\ndata: ${data}\n\n`);
      } catch {
        clients.splice(i, 1);
      }
    }
  }
}

/**
 * Create an emitter that broadcasts SSE events for a specific executionId.
 * The executionId MUST be provided — the emitter is bound to it.
 */
export function createSSEEmitter(executionId: string): EngineEventEmitter {
  return {
    emit(event: SSEEvent): void {
      event.data.executionId = executionId;

      // Console log for server-side visibility
      const ts = new Date().toISOString().slice(11, 19);
      if (event.event === 'node_started') {
        console.log(`[${ts}] ● ${event.data.node}`);
      } else if (event.event === 'node_completed') {
        console.log(`[${ts}] ✓ ${event.data.node} (${event.data.durationMs}ms)`);
      } else if (event.event === 'node_failed') {
        console.log(`[${ts}] ✗ ${event.data.node}: ${event.data.error}`);
      }

      broadcastToExecution(executionId, event);
    },
  };
}

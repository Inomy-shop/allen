import { create } from 'zustand';
import { normalizeExecutionStatus } from '../lib/execution-status';

export type ExecutionSnapshot = {
  executionId: string;
  workflowId?: string | null;
  workflowName: string;
  status: string;
  revision: number;
  runGeneration: number;
  updatedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  currentNodes: string[];
  completedNodes: string[];
  failedNode?: string | null;
  errorMessage?: string | null;
  parentExecutionId?: string | null;
  rootExecutionId?: string | null;
  chatSessionId?: string | null;
  workspaceId?: string | null;
  source?: string | null;
};

type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

interface ExecutionStoreState {
  entities: Record<string, ExecutionSnapshot>;
  changeVersion: number;
  connectionStatus: ConnectionStatus;
  ingest: (snapshot: ExecutionSnapshot) => boolean;
  ingestMany: (snapshots: ExecutionSnapshot[]) => void;
  ingestExecution: (execution: Record<string, unknown>) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  clear: () => void;
}

function stringDate(value: unknown): string {
  const date = value ? new Date(value as string | number | Date) : new Date();
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

export function snapshotFromExecution(execution: Record<string, unknown>): ExecutionSnapshot | null {
  const executionId = typeof execution.executionId === 'string'
    ? execution.executionId
    : typeof execution.id === 'string'
      ? execution.id
      : null;
  if (!executionId || typeof execution.status !== 'string') return null;
  const meta = execution.meta && typeof execution.meta === 'object' ? execution.meta as Record<string, unknown> : {};
  const input = execution.input && typeof execution.input === 'object' ? execution.input as Record<string, unknown> : {};
  return {
    executionId,
    workflowId: typeof execution.workflowId === 'string' ? execution.workflowId : null,
    workflowName: typeof execution.workflowName === 'string' ? execution.workflowName : '',
    status: normalizeExecutionStatus(execution.status),
    revision: typeof execution.revision === 'number' ? execution.revision : 0,
    runGeneration: typeof execution.runGeneration === 'number' ? execution.runGeneration : 1,
    updatedAt: stringDate(execution.updatedAt ?? execution.completedAt ?? execution.startedAt),
    startedAt: execution.startedAt ? stringDate(execution.startedAt) : null,
    completedAt: execution.completedAt ? stringDate(execution.completedAt) : null,
    currentNodes: Array.isArray(execution.currentNodes) ? execution.currentNodes.filter((v): v is string => typeof v === 'string') : [],
    completedNodes: Array.isArray(execution.completedNodes) ? execution.completedNodes.filter((v): v is string => typeof v === 'string') : [],
    failedNode: typeof execution.failedNode === 'string' ? execution.failedNode : null,
    errorMessage: typeof execution.errorMessage === 'string' ? execution.errorMessage : null,
    parentExecutionId: typeof execution.parentExecutionId === 'string' ? execution.parentExecutionId : null,
    rootExecutionId: typeof execution.rootExecutionId === 'string' ? execution.rootExecutionId : null,
    chatSessionId: typeof meta.chatSessionId === 'string' ? meta.chatSessionId : null,
    workspaceId: typeof meta.workspaceId === 'string' ? meta.workspaceId : typeof input.workspace_id === 'string' ? input.workspace_id : null,
    source: typeof execution.source === 'string' ? execution.source : null,
  };
}

export function isNewerSnapshot(current: ExecutionSnapshot | undefined, next: ExecutionSnapshot): boolean {
  if (!current) return true;
  if (next.runGeneration !== current.runGeneration) return next.runGeneration > current.runGeneration;
  return next.revision > current.revision;
}

export const useExecutionStore = create<ExecutionStoreState>((set, get) => ({
  entities: {},
  changeVersion: 0,
  connectionStatus: 'idle',
  ingest: (snapshot) => {
    if (!snapshot?.executionId) return false;
    const normalized = snapshot.status === normalizeExecutionStatus(snapshot.status)
      ? snapshot
      : { ...snapshot, status: normalizeExecutionStatus(snapshot.status) };
    const current = get().entities[normalized.executionId];
    if (!isNewerSnapshot(current, normalized)) return false;
    set((state) => ({
      entities: { ...state.entities, [normalized.executionId]: normalized },
      changeVersion: state.changeVersion + 1,
    }));
    return true;
  },
  ingestMany: (snapshots) => {
    set((state) => {
      let changed = false;
      const entities = { ...state.entities };
      for (const snapshot of snapshots) {
        if (!snapshot?.executionId) continue;
        const normalized = snapshot.status === normalizeExecutionStatus(snapshot.status)
          ? snapshot
          : { ...snapshot, status: normalizeExecutionStatus(snapshot.status) };
        if (!isNewerSnapshot(entities[normalized.executionId], normalized)) continue;
        entities[normalized.executionId] = normalized;
        changed = true;
      }
      return changed ? { entities, changeVersion: state.changeVersion + 1 } : state;
    });
  },
  ingestExecution: (execution) => {
    const snapshot = snapshotFromExecution(execution);
    if (snapshot) get().ingest(snapshot);
  },
  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
  clear: () => set((state) => ({ entities: {}, connectionStatus: 'idle', changeVersion: state.changeVersion + 1 })),
}));

export function mergeExecutionSnapshot<T extends Record<string, unknown>>(execution: T, snapshot?: ExecutionSnapshot): T {
  if (!snapshot) return execution;
  return {
    ...execution,
    id: snapshot.executionId,
    status: snapshot.status,
    revision: snapshot.revision,
    runGeneration: snapshot.runGeneration,
    updatedAt: snapshot.updatedAt,
    startedAt: snapshot.startedAt ?? execution.startedAt,
    completedAt: snapshot.completedAt,
    currentNodes: snapshot.currentNodes,
    completedNodes: snapshot.completedNodes,
    failedNode: snapshot.failedNode,
    errorMessage: snapshot.errorMessage,
  };
}

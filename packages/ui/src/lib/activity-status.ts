export type SessionActivityState = 'running' | 'needs-you' | 'completed' | 'failed';

export type SessionActivityInput = {
  _id: string;
  status?: string;
  streaming?: boolean;
  lastMessageAt?: string;
  updatedAt?: string;
};

export type SessionExecutionInput = {
  id?: string;
  status?: string;
  startedAt?: string;
  updatedAt?: string;
  meta?: { chatSessionId?: string };
  chatSessionId?: string;
};

const RUNNING_EXECUTION_STATUSES = new Set(['running', 'queued']);
const WAITING_EXECUTION_STATUSES = new Set(['waiting_for_input', 'waiting_for_human']);
export const ACTIVITY_WINDOW_MS = 30 * 60 * 1000;

function timestamp(value?: string): number {
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function executionChatSessionId(execution: SessionExecutionInput): string | undefined {
  return execution.meta?.chatSessionId ?? execution.chatSessionId;
}

export function sessionActivityState(
  session: SessionActivityInput,
  executions: SessionExecutionInput[] = [],
  now = Date.now(),
): SessionActivityState {
  const sessionActivityAt = timestamp(session.lastMessageAt ?? session.updatedAt);
  const sessionIsFresh = sessionActivityAt > 0
    && Math.max(0, now - sessionActivityAt) <= ACTIVITY_WINDOW_MS;
  if (
    (session.streaming || session.status === 'streaming' || session.status === 'running')
    && sessionIsFresh
  ) return 'running';

  const latestExecution = executions
    .filter(execution => executionChatSessionId(execution) === session._id)
    .sort((left, right) => (
      timestamp(right.updatedAt ?? right.startedAt) - timestamp(left.updatedAt ?? left.startedAt)
    ))[0];
  const executionStatus = latestExecution?.status ?? '';

  if (WAITING_EXECUTION_STATUSES.has(executionStatus)) return 'needs-you';
  if (RUNNING_EXECUTION_STATUSES.has(executionStatus)) {
    return executionActivityState(latestExecution, now) === 'active' ? 'running' : 'completed';
  }
  if (executionStatus === 'failed') return 'failed';
  return 'completed';
}

export function executionActivityState(
  execution: SessionExecutionInput,
  now = Date.now(),
): 'active' | 'idle' {
  const status = (execution.status ?? '').trim().toLowerCase();
  if (WAITING_EXECUTION_STATUSES.has(status)) return 'active';
  if (!RUNNING_EXECUTION_STATUSES.has(status)) return 'idle';
  const activityAt = timestamp(execution.updatedAt ?? execution.startedAt);
  if (!activityAt) return 'idle';
  return Math.max(0, now - activityAt) <= ACTIVITY_WINDOW_MS ? 'active' : 'idle';
}

export type WorkspaceActivityState = 'active' | 'idle';

export type WorkspaceActivityInput = {
  status?: string;
  updatedAt?: string;
  createdAt?: string;
};

const TERMINAL_WORKSPACE_STATUSES = new Set([
  'idle',
  'stopped',
  'archived',
  'deleted',
  'failed',
  'merged',
  'closed',
]);

const ACTIVE_WORKSPACE_STATUSES = new Set([
  'active',
  'running',
  'creating',
  'provisioning',
  'setting_up',
  'setup',
]);

export const WORKSPACE_ACTIVITY_WINDOW_MS = ACTIVITY_WINDOW_MS;

export function workspaceActivityState(
  workspace: WorkspaceActivityInput,
  now = Date.now(),
): WorkspaceActivityState {
  const status = (workspace.status ?? '').trim().toLowerCase();
  if (TERMINAL_WORKSPACE_STATUSES.has(status)) return 'idle';
  if (!ACTIVE_WORKSPACE_STATUSES.has(status)) return 'idle';

  const lastActivityAt = timestamp(workspace.updatedAt ?? workspace.createdAt);
  if (!lastActivityAt) return 'idle';
  return Math.max(0, now - lastActivityAt) <= WORKSPACE_ACTIVITY_WINDOW_MS ? 'active' : 'idle';
}

export function humanizeWorkspaceName(name: string, branch?: string): string {
  const source = (name || branch || 'Untitled workspace').trim();
  if (!source || /\s/.test(source)) return source || 'Untitled workspace';

  const withoutPrefix = source.replace(/^(?:feature|feat|fix|bugfix|hotfix|chore|ui|docs|test)\//i, '');
  const withoutGeneratedSuffix = withoutPrefix.replace(
    /-([a-z0-9]{6,10})$/i,
    (match, suffix: string) => (/\d/.test(suffix) ? '' : match),
  );
  const words = withoutGeneratedSuffix.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return source;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

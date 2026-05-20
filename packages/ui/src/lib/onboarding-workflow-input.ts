type WorkflowInputSchema = Record<string, { type?: string; required?: boolean }>;

export interface OnboardingWorkflowRecord {
  parsed?: {
    input?: WorkflowInputSchema;
  };
}

export type OnboardingTaskType = 'bug' | 'feature';

function normalizeString(value: string): string {
  return value.trim();
}

function isDeclaredOrSchemaMissing(schema: WorkflowInputSchema | undefined, key: string): boolean {
  return !schema || Object.prototype.hasOwnProperty.call(schema, key);
}

function setStringIfDeclared(
  target: Record<string, unknown>,
  schema: WorkflowInputSchema | undefined,
  key: string,
  value: string,
) {
  if (!isDeclaredOrSchemaMissing(schema, key)) return;
  const trimmed = normalizeString(value);
  if (trimmed) target[key] = trimmed;
}

function setBooleanIfDeclared(
  target: Record<string, unknown>,
  schema: WorkflowInputSchema | undefined,
  key: string,
  value: boolean,
) {
  if (!isDeclaredOrSchemaMissing(schema, key)) return;
  target[key] = value;
}

export function buildOnboardingWorkflowInput(
  workflow: OnboardingWorkflowRecord | null | undefined,
  values: {
    taskType: OnboardingTaskType;
    request: string;
    repoPath: string;
    trustedMode?: boolean;
    skipRegression?: boolean;
    startedByUserId?: string;
    chatSessionId?: string;
  },
): Record<string, unknown> {
  const schema = workflow?.parsed?.input;
  const input: Record<string, unknown> = {};

  if (values.taskType === 'feature') {
    setStringIfDeclared(input, schema, 'user_request', values.request);
    setBooleanIfDeclared(input, schema, 'trusted_mode', values.trustedMode ?? false);
    setBooleanIfDeclared(input, schema, 'skip_regression', values.skipRegression ?? false);
  } else {
    setStringIfDeclared(input, schema, 'bug_report', values.request);
  }

  setStringIfDeclared(input, schema, 'repo_path', values.repoPath);
  setStringIfDeclared(input, schema, 'chat_session_id', values.chatSessionId ?? '');
  setStringIfDeclared(input, schema, 'started_by_user_id', values.startedByUserId ?? '');

  return input;
}

export function buildOnboardingBugFixInput(
  workflow: OnboardingWorkflowRecord | null | undefined,
  values: {
    bugReport: string;
    repoPath: string;
    startedByUserId?: string;
    chatSessionId?: string;
  },
): Record<string, unknown> {
  return buildOnboardingWorkflowInput(workflow, {
    taskType: 'bug',
    request: values.bugReport,
    repoPath: values.repoPath,
    startedByUserId: values.startedByUserId,
    chatSessionId: values.chatSessionId,
  });
}

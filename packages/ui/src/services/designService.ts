import { authHeaders } from './api';

const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(
      new Error(body.error ?? `Request failed: ${res.status}`),
      { code: body.code as string | undefined, httpStatus: res.status as number },
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export interface DesignSession {
  _id: string;
  kind: 'design';
  title: string;
  designRepoId: string;
  sourceRepoId?: string;
  workspaceId?: string;
  status: 'idle' | 'running' | 'failed' | 'archived';
  routingDecision?: DesignRoutingDecision;
  hasExistingOutputs?: boolean;
  outputMode: 'spec_only' | 'prototype';
  lastExecutionId?: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
}

export interface DesignMessage {
  _id: string;
  designSessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  status: 'completed' | 'streaming' | 'failed';
  error?: string;
  routingDecision?: DesignRoutingDecision;
  executionId?: string;
  agentRunId?: string;
  artifacts?: Array<{ artifactId: string; url: string; filename: string; contentType?: string }>;
  createdAt: string;
}

export interface DesignRoutingDecision {
  mode: 'workflow' | 'agent' | 'direct';
  resolvedBy: 'auto' | 'user_override';
  workflowName?: string;
  agentName?: string;
  reason: string;
  outputMode: 'spec_only' | 'prototype';
  overrideKey?: 'auto' | 'full_workflow' | 'fast_frontend' | 'design_refinement' | 'design_review';
  needsConfirmation?: boolean;
}

export interface DesignPreviewConfig {
  enabled: boolean;
  workingDirectory: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand: string;
  portMode: 'auto' | 'fixed';
  fixedPort?: number;
  healthCheckPath?: string;
  lastValidatedAt?: string;
  lastValidationStatus?: 'unknown' | 'passed' | 'failed';
  lastValidationError?: string;
}

export interface DesignRunResponse {
  designSessionId: string;
  messageId: string;
  routingDecision: DesignRoutingDecision;
  executionId?: string;
  agentRunId?: string;
  status: 'running' | 'completed';
  directResponse?: string;
}

export const designSessions = {
  list: (params?: { status?: string; designRepoId?: string; limit?: number }) => {
    const qs = params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString() : '';
    return request<DesignSession[]>(`/design/sessions${qs}`);
  },
  create: (body: { title: string; designRepoId: string; sourceRepoId?: string; outputMode?: string }) =>
    request<DesignSession>('/design/sessions', { method: 'POST', body: JSON.stringify(body) }),
  get: (id: string) => request<DesignSession>(`/design/sessions/${id}`),
  update: (id: string, patch: Partial<Pick<DesignSession, 'title' | 'sourceRepoId' | 'status' | 'outputMode'>>) =>
    request<DesignSession>(`/design/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  delete: (id: string) => request<void>(`/design/sessions/${id}`, { method: 'DELETE' }),
  listMessages: (id: string, params?: { limit?: number; before?: string }) => {
    const qs = params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString() : '';
    return request<DesignMessage[]>(`/design/sessions/${id}/messages${qs}`);
  },
  run: (id: string, body: {
    prompt: string; sourceRepoId?: string; designRepoId?: string;
    selectedDesignTarget?: string; routingOverride?: string; outputMode?: string;
  }) => request<DesignRunResponse>(`/design/sessions/${id}/run`, { method: 'POST', body: JSON.stringify(body) }),
  reconcile: (id: string) => request<{
    reconciledCount: number;
    sessionStatus: string;
    session: DesignSession;
    messages: DesignMessage[];
  }>(`/design/sessions/${id}/reconcile`),
};

export const designRepos = {
  list: (includeAll?: boolean) => request<any[]>(`/design/repos${includeAll ? '?includeAll=true' : ''}`),
  getDefault: () => request<any | null>('/design/repos/default'),
  setDefault: (repoId: string) => request<any>('/design/repos/default', { method: 'PUT', body: JSON.stringify({ repoId }) }),
  onboard: (body: { path?: string; cloneUrl?: string; name: string; makeDefault?: boolean; previewConfig?: DesignPreviewConfig }) =>
    request<any>('/design/repos/onboard', { method: 'POST', body: JSON.stringify(body) }),
  bootstrapUiDesigns: (name?: string) =>
    request<any>('/design/repos/bootstrap-ui-designs', { method: 'POST', body: JSON.stringify({ name }) }),
  getPreviewConfig: (repoId: string) => request<DesignPreviewConfig | null>(`/design/repos/${repoId}/preview-config`),
  savePreviewConfig: (repoId: string, config: DesignPreviewConfig) =>
    request<DesignPreviewConfig>(`/design/repos/${repoId}/preview-config`, { method: 'PUT', body: JSON.stringify(config) }),
  testPreviewConfig: (repoId: string, workspaceId?: string) =>
    request<{ status: 'passed' | 'failed'; logs: string[]; previewUrl?: string }>(
      `/design/repos/${repoId}/preview-config/test`, { method: 'POST', body: JSON.stringify({ workspaceId }) },
    ),
  previewStatus: (repoId: string, chatSessionId?: string | null) => {
    const qs = chatSessionId ? `?chatSessionId=${encodeURIComponent(chatSessionId)}` : '';
    return request<{ status: string; port?: number; previewUrl?: string; cwd?: string }>(`/design/repos/${repoId}/preview-status${qs}`);
  },
  previewStart: (repoId: string, chatSessionId?: string | null, workspaceId?: string | null) => {
    const body: Record<string, string> = {};
    if (chatSessionId) body.chatSessionId = chatSessionId;
    if (workspaceId) body.workspaceId = workspaceId;
    return request<{ status: string; port?: number; previewUrl?: string; cwd?: string }>(
      `/design/repos/${repoId}/preview-start`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  },
  previewStop: (repoId: string, chatSessionId?: string | null) =>
    request<{ status: string }>(`/design/repos/${repoId}/preview-stop`, {
      method: 'POST',
      body: JSON.stringify(chatSessionId ? { chatSessionId } : {}),
    }),
};

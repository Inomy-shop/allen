/**
 * Allen Design Studio — UI API client.
 *
 * Mirrors /api/design-studio/*. Uses the shared `request()` helper for auth +
 * 401 refresh. The fresh design surface; unrelated to the legacy designService.
 */
import { request } from './apiCore';

// ── Types (mirror server) ─────────────────────────────────────────────────────

export interface ColorToken { name: string; value: string; role?: string }
export interface ThemeOption { name: string; description: string; location: string }

export interface DesignProfile {
  summaryMarkdown: string;
  colors: ColorToken[];
  typography?: string;
  spacing?: string;
  components?: { name: string; description: string }[];
  iconography?: string;
  layoutPatterns?: string;
  consistency: { consistent: boolean; issues: string[]; strategy?: 'mimic' | 'normalize' };
  themes?: ThemeOption[];
  selectedTheme?: string;
}

export interface GreenfieldBrief {
  product: string; audience: string; feel: string; references: string; screens: string;
  direction?: string; assumptions?: string[];
}

export type ProfileStatus = 'pending' | 'analyzing' | 'needs_review' | 'needs_choice' | 'confirmed';

export interface Workspace {
  _id: string;
  kind: 'repo' | 'greenfield';
  name: string;
  sourceRepoId?: string;
  sourceRepoPath?: string;
  repoFingerprint?: string;
  profile?: DesignProfile;
  profileStatus: ProfileStatus;
  analysisProvider?: string;
  analysisModel?: string;
  greenfieldBrief?: GreenfieldBrief;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  _id: string;
  workspaceId: string;
  title: string;
  currentVersionId?: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
}

export interface Screen { id: string; name: string; fileName: string; html: string }

export interface WorkspaceFile { path: string; size: number; isHtml: boolean }
export interface WorkspaceFileContent { path: string; size: number; content: string; truncated: boolean }

/** Static-site URL for a workspace's design-system folder (openable in browser). */
export function workspaceSitePath(workspaceId: string, file = 'index.html'): string {
  return `/dstudio-site/${encodeURIComponent(workspaceId)}/${file}`;
}

export interface Version {
  _id: string;
  sessionId: string;
  workspaceId: string;
  seq: number;
  kind: 'generation' | 'iteration' | 'variant' | 'restore' | 'branch';
  label: string;
  prompt?: string;
  parentVersionId?: string;
  groupId?: string;
  variantLabel?: string;
  selected?: boolean;
  screens: Screen[];
  inventedElements?: string[];
  createdAt: string;
}

export interface Message {
  _id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  versionId?: string;
  groupId?: string;
  createdAt: string;
}

const B = '/design-studio';

export const designStudio = {
  // Workspaces
  listWorkspaces: () => request<Workspace[]>(`${B}/workspaces`),
  createWorkspace: (body: { kind: 'repo' | 'greenfield'; repoId?: string; name?: string }) =>
    request<Workspace>(`${B}/workspaces`, { method: 'POST', body: JSON.stringify(body) }),
  getWorkspace: (id: string) => request<Workspace>(`${B}/workspaces/${id}`),
  deleteWorkspace: (id: string) => request<void>(`${B}/workspaces/${id}`, { method: 'DELETE' }),
  analyze: (id: string, opts?: { provider?: string; model?: string }) =>
    request<Workspace>(`${B}/workspaces/${id}/analyze`, { method: 'POST', body: JSON.stringify(opts ?? {}) }),
  /** Available provider/model options for the analysis picker. */
  listModels: async (): Promise<{ provider: string; model: string; label: string }[]> => {
    const providers = await request<{ provider: string; models?: string[]; modelSuggestions?: string[]; defaultModel?: string }[]>('/chat/providers');
    const out: { provider: string; model: string; label: string }[] = [];
    for (const p of providers) {
      const models = (p.models?.length ? p.models : p.modelSuggestions) ?? (p.defaultModel ? [p.defaultModel] : []);
      for (const m of models) out.push({ provider: p.provider, model: m, label: `${p.provider} · ${m}` });
    }
    return out;
  },
  confirmProfile: (id: string, body: { profile?: Partial<DesignProfile>; strategy?: 'mimic' | 'normalize'; selectedTheme?: string }) =>
    request<Workspace>(`${B}/workspaces/${id}/profile`, { method: 'POST', body: JSON.stringify(body) }),
  repoChange: (id: string) => request<{ changed: boolean; hasProfile: boolean }>(`${B}/workspaces/${id}/repo-change`),
  /** REQ-005: Manual refresh — re-runs full analysis + context update for a confirmed repo workspace. */
  refresh: (id: string, opts?: { provider?: string; model?: string }) =>
    request<Workspace>(`${B}/workspaces/${id}/refresh`, { method: 'POST', body: JSON.stringify(opts ?? {}) }),
  greenfield: (id: string, body: { idea?: string; answers: Record<string, string> }) =>
    request<Workspace>(`${B}/workspaces/${id}/greenfield`, { method: 'POST', body: JSON.stringify(body) }),

  // Start a chat-based design session running the "UI Designer" persona.
  start: (workspaceId: string, opts?: { provider?: string; model?: string; agentOverrides?: Record<string, unknown> }) =>
    request<{ chatSessionId: string }>(`${B}/workspaces/${workspaceId}/start`, { method: 'POST', body: JSON.stringify(opts ?? {}) }),

  // Chat-based design sessions for a workspace (the persona flow).
  listDesigns: (workspaceId: string) =>
    request<{ _id: string; title: string; lastMessageAt: string; messageCount: number }[]>(`${B}/workspaces/${workspaceId}/designs`),

  // Shared design-system files for a workspace.
  listFiles: (workspaceId: string) =>
    request<WorkspaceFile[]>(`${B}/workspaces/${workspaceId}/files`),
  readFile: (workspaceId: string, path: string) =>
    request<WorkspaceFileContent>(`${B}/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(path)}`),
  exportSystem: (workspaceId: string, destinationDir?: string) =>
    request<{ dir: string; files: string[] }>(`${B}/workspaces/${workspaceId}/export`, { method: 'POST', body: JSON.stringify({ destinationDir }) }),

  // Sessions
  listSessions: (workspaceId: string) => request<Session[]>(`${B}/workspaces/${workspaceId}/sessions`),
  createSession: (workspaceId: string, title?: string) =>
    request<Session>(`${B}/workspaces/${workspaceId}/sessions`, { method: 'POST', body: JSON.stringify({ title }) }),
  getSession: (id: string) => request<Session>(`${B}/sessions/${id}`),
  deleteSession: (id: string) => request<void>(`${B}/sessions/${id}`, { method: 'DELETE' }),
  listMessages: (id: string) => request<Message[]>(`${B}/sessions/${id}/messages`),
  listVersions: (id: string) => request<Version[]>(`${B}/sessions/${id}/versions`),

  // Generation / iteration
  generate: (sessionId: string, body: { instruction: string; variants?: number }) =>
    request<{ version?: Version; variants?: Version[]; groupId?: string }>(`${B}/sessions/${sessionId}/generate`, { method: 'POST', body: JSON.stringify(body) }),
  iterate: (sessionId: string, body: { instruction: string; scopeFileName?: string }) =>
    request<{ version: Version; changedFiles: string[] }>(`${B}/sessions/${sessionId}/iterate`, { method: 'POST', body: JSON.stringify(body) }),

  // Versions
  selectVariant: (versionId: string) => request<Version>(`${B}/versions/${versionId}/select-variant`, { method: 'POST' }),
  restore: (versionId: string) => request<Version>(`${B}/versions/${versionId}/restore`, { method: 'POST' }),
  branch: (versionId: string) => request<Version>(`${B}/versions/${versionId}/branch`, { method: 'POST' }),
  preview: (versionId: string) => request<{ url: string }>(`${B}/versions/${versionId}/preview`, { method: 'POST' }),
  export: (versionId: string, destinationDir?: string) =>
    request<{ dir: string; files: string[] }>(`${B}/versions/${versionId}/export`, { method: 'POST', body: JSON.stringify({ destinationDir }) }),
};

// ── Chat-session artifacts (the persona saves the prototype as an HTML artifact) ─

export interface ChatArtifact {
  id?: string;
  _id?: string;
  filename: string;
  contentType?: string | null;
  description?: string | null;
  createdAt?: string;
}

export const studioArtifacts = {
  list: (chatSessionId: string) =>
    request<ChatArtifact[]>(`/artifacts?rootType=chat&rootId=${encodeURIComponent(chatSessionId)}`),
  /** Public content URL for a single artifact by id. */
  contentPath: (id: string) => `/api/artifacts/${id}/content`,
  /**
   * Session-scoped static preview entry point. Serves the session's HTML/CSS/JS
   * artifacts as a mini site so multi-screen prototypes (relative links + shared
   * styles.css) resolve. `file` defaults to index.html.
   */
  sitePath: (chatSessionId: string, file = 'index.html') =>
    `/dstudio-preview/chat/${encodeURIComponent(chatSessionId)}/${file}`,
};

/** Pick the prototype entry point from a chat session's artifacts. */
export function pickPrototypeArtifact(artifacts: ChatArtifact[]): ChatArtifact | null {
  const html = artifacts.filter((a) => /\.html?$/i.test(a.filename));
  if (html.length === 0) return null;
  const byNewest = [...html].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  // Prefer the newest index.html; otherwise the newest html artifact.
  return byNewest.find((a) => /(^|\/)index\.html?$/i.test(a.filename)) ?? byNewest[0];
}

/** Resolve an absolute preview URL openable in the real browser. */
export async function resolvePreviewAbsoluteUrl(relativeUrl: string): Promise<string> {
  const desktop = (window as any).allenDesktop;
  if (desktop?.getRuntimeInfo) {
    try {
      const info = await desktop.getRuntimeInfo();
      if (info?.serverUrl) return `${info.serverUrl.replace(/\/$/, '')}${relativeUrl}`;
    } catch { /* fall through */ }
  }
  return `${window.location.origin}${relativeUrl}`;
}

/** Open a URL in the user's default browser (desktop) or a new tab (web). */
export function openInBrowser(url: string): void {
  const desktop = (window as any).allenDesktop;
  if (desktop?.openExternal) void desktop.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

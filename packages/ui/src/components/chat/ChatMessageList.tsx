import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, AlertCircle, AlertTriangle, Copy, Check, Clock, Wrench, CheckCircle, ExternalLink, Loader2, Brain,
  Sparkles, Zap, Cpu, Atom, Terminal, Code, Rocket, Shield, Hexagon, Flame,
  ChevronDown, ChevronRight, GitPullRequest, FolderGit2, FileText, PlayCircle, StopCircle, Timer,
  Send, Bookmark, Search, PencilLine, Database, ListTodo, Globe2, Workflow,
} from 'lucide-react';
import type { ChatMessage, ToolCallRecord, ActiveToolCall, AgentReport, SpawnedAgent, WorkflowInterventionAnswer } from '../../hooks/useChat';
import { AgentQuestionPrompt } from './AgentQuestionPrompt';
import RoleIcon from '../common/RoleIcon';
import TokenUsageDisplay from '../common/TokenUsageDisplay';
import MermaidChatBlock from './MermaidChatBlock';
import { WatcherStatusLines } from './WatcherStatusLines';
import { agents as agentsApi, artifacts as artifactsApi, type ArtifactDoc, type WatcherUIDoc } from '../../services/api';
import { useDocumentTabStore } from '../../stores/documentTabStore';
import { chatCodeDiffs, pullRequests as pullRequestsApi, workspaces as workspacesApi } from '../../services/workspaceService';
import { WorkflowInterventionAction } from '../execution/WorkflowInterventionAction';
import { sanitizeChatAssistantResponse } from '../../lib/chat-response-sanitize';
import { workspaceChatPath } from '../../lib/workspace-routes';
import { humanLabel } from '../../lib/model-catalog';
import { getModelDisplay } from '../../hooks/useModelRegistry';
import { isCancelledExecutionStatus, isTerminalExecutionStatus } from '../../lib/execution-status';
import { chatSessionIdFromHref, filePathFromReference, mediaKindForPath, openExternalResource } from '../../lib/resource-navigation';
import { useMediaViewerStore } from '../../stores/mediaViewerStore';

const ChatExecutionsPanel = React.lazy(() =>
  import('./ChatRunSidebar').then(module => ({ default: module.ExecutionsPanel })),
);

const AGENT_ICONS: Record<string, React.ElementType> = {
  bot: Bot, brain: Brain, sparkles: Sparkles, zap: Zap, cpu: Cpu, atom: Atom,
  terminal: Terminal, code: Code, rocket: Rocket, shield: Shield, hexagon: Hexagon, flame: Flame,
};

interface ChatMessageListProps {
  messages: ChatMessage[];
  streamText: string;
  thinkingText?: string;
  streaming: boolean;
  activeToolCalls?: ActiveToolCall[];
  agentReports?: AgentReport[];
  /** Pending question from an agent to the user */
  pendingUserQuestion?: { question: string; fromAgent: string } | null;
  onAnswerUserQuestion?: (answer: string) => void;
  /** Active agent name (for labeling assistant messages) */
  activeAgent?: string | null;
  /** Routed workflow/agent executions — live tracking */
  spawnedAgents?: SpawnedAgent[];
  onAnswerWorkflowIntervention?: (input: WorkflowInterventionAnswer) => Promise<void> | void;
  onSuggestionClick?: (text: string) => void;
  onSaveToLearnings?: (content: string) => void;
  onOpenExecutionsPanel?: () => void;
  onOpenFilesPanel?: () => void;
  /** Execution watcher status lines — non-clickable per-execution updates */
  watchers?: WatcherUIDoc[];
  conversationTitle?: string;
  conversationTag?: string | null;
  conversationWorkflow?: string | null;
  documentCount?: number;
  provider?: string | null;
  model?: string | null;
  onOpenFileReference?: (path: string) => void;
  onOpenChatReference?: (sessionId: string) => void;
  onOpenInternalReference?: (path: string) => void;
  resourceScopeKey?: string;
}

type MarkdownResourceContextValue = {
  onOpenFileReference?: (path: string) => void;
  onOpenChatReference?: (sessionId: string) => void;
  onOpenInternalReference?: (path: string) => void;
  resourceScopeKey?: string;
};

const MarkdownResourceContext = React.createContext<MarkdownResourceContextValue>({});

type WorkflowInterventionField = {
  name: string;
  label?: string;
  type?: string;
  required?: boolean;
  options?: Array<string | { label?: string; value?: string }>;
  placeholder?: string;
};

type WorkflowIntervention = {
  intervention_id?: string;
  status?: string;
  stage?: string;
  severity?: string;
  title?: string;
  question?: string;
  context_summary?: string;
  created_at?: string;
  createdAt?: string;
  fields?: WorkflowInterventionField[];
  options?: Array<{ label?: string; value?: string; primary?: boolean; destructive?: boolean }>;
};

type ChatDiffFile = {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
  diff?: string;
  originalContent?: string;
  modifiedContent?: string;
  workspaceName?: string | null;
  sourceType?: 'workspace' | 'pull-request';
  sourceId?: string;
  key?: string;
};

function diffLineCounts(diff?: string): { additions: number; deletions: number } {
  if (!diff) return { additions: 0, deletions: 0 };
  return diff.split('\n').reduce((acc, line) => {
    if (line.startsWith('+++') || line.startsWith('---')) return acc;
    if (line.startsWith('+')) acc.additions += 1;
    else if (line.startsWith('-')) acc.deletions += 1;
    return acc;
  }, { additions: 0, deletions: 0 });
}

function hasChangedDiffMetadata(file: ChatDiffFile): boolean {
  return Boolean(file.path) && (
    Number(file.additions ?? 0) > 0 ||
    Number(file.deletions ?? 0) > 0 ||
    Boolean(file.status) ||
    Boolean(file.diff?.trim() || file.modifiedContent?.trim())
  );
}

function hasDiffContent(file: ChatDiffFile): boolean {
  return Boolean(file.diff?.trim() || file.originalContent?.trim() || file.modifiedContent?.trim());
}

type ChatDiffBundle = {
  workspaceId: string;
  workspaceName?: string | null;
  files: ChatDiffFile[];
};

type ChatDiffSnapshot = {
  workspaceId: string;
  workspaceName?: string | null;
  files?: ChatDiffFile[];
};

type ChatTimelineItem = { type: 'message'; key: string; message: ChatMessage; index: number; timeMs: number };

/* ── Copy button for code blocks ─────────────────────────────────────────── */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] font-mono transition-all hover:bg-white/10"
      title="Copy code"
    >
      {copied ? (
        <>
          <Check className="w-3 h-3 text-green-400" />
          <span className="text-green-400">Copied</span>
        </>
      ) : (
        <>
          <Copy className="w-3 h-3 text-theme-muted" />
          <span className="text-theme-muted">Copy</span>
        </>
      )}
    </button>
  );
}

function MessageCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title="Copy message"
      aria-label="Copy message"
    >
      {copied ? <Check className="w-3 h-3 text-accent-green" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

/* ── Thinking block ──────────────────────────────────────────────────────── */
function ThinkingBlock({ text, durationMs, active }: { text: string; durationMs?: number; active?: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const label = active ? 'Thinking' : durationMs ? `Thought for ${formatDuration(durationMs)}` : 'Thought';

  return (
    <div className="chat-activity-group thinking" data-active={Boolean(active)}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="chat-activity-summary"
        title={expanded ? 'Collapse thinking' : 'Expand thinking'}
      >
        <span>{label}</span>
        {expanded ? (
          <ChevronDown />
        ) : (
          <ChevronRight />
        )}
      </button>
      {expanded && (
        <div className="chat-activity-expansion chat-thinking-copy">
          {renderMarkdown(text)}
        </div>
      )}
    </div>
  );
}

/* ── Typing dots animation ───────────────────────────────────────────────── */
function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1">
      <span className="w-1.5 h-1.5 rounded-full bg-accent-blue/60 animate-bounce" style={{ animationDelay: '0ms' }} />
      <span className="w-1.5 h-1.5 rounded-full bg-accent-blue/60 animate-bounce" style={{ animationDelay: '150ms' }} />
      <span className="w-1.5 h-1.5 rounded-full bg-accent-blue/60 animate-bounce" style={{ animationDelay: '300ms' }} />
    </span>
  );
}

/* ── Timestamp formatting ────────────────────────────────────────────────── */
function formatTime(dateStr?: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTimestampTitle(dateStr?: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function timestampMs(value?: string | number | Date | null): number | null {
  if (value == null) return null;
  if (typeof value === 'number') {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value;
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function buildChatTimeline(messages: ChatMessage[]): ChatTimelineItem[] {
  return messages.map((message, index) => ({
    type: 'message',
    key: `message:${message._id ?? index}`,
    message,
    index,
    timeMs: timestampMs(message.createdAt) ?? index,
  }));
}

function formatClock(dateStr?: string | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(ms?: number | null): string {
  if (ms == null || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  return rem ? `${min}m ${rem}s` : `${min}m`;
}

function userDisplayName(msg: ChatMessage): string {
  const raw = msg.senderName?.trim()
    || msg.senderEmail?.split('@')[0]
    || (msg.senderSource === 'slack' ? 'Slack user' : 'User');
  return displayName(raw);
}

function displayName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'User';
  if (/\s/.test(trimmed) && /[A-Z]/.test(trimmed)) return trimmed;
  return trimmed
    .replace(/[_.-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.length <= 2 && part === part.toUpperCase()
      ? part
      : part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function assistantDisplayName(agentInfo?: { displayName?: string }): string {
  return displayName(agentInfo?.displayName ?? 'Allen');
}

function senderInitial(label: string): string {
  return label.trim().charAt(0).toUpperCase() || 'U';
}

function parseDiffSummary(code: string) {
  const files: Array<ChatDiffFile & { isNew: boolean }> = [];
  let current: { path: string; additions: number; deletions: number; isNew: boolean; lines: string[] } | null = null;
  for (const line of code.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) files.push({ ...current, diff: current.lines.join('\n') });
      const match = line.match(/ b\/(.+)$/) ?? line.match(/ a\/(.+?) /);
      current = { path: match?.[1] ?? 'changed file', additions: 0, deletions: 0, isNew: false, lines: [line] };
      continue;
    }
    if (!current && line.startsWith('+++ b/')) {
      current = { path: line.slice(6), additions: 0, deletions: 0, isNew: false, lines: [line] };
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    if (line.startsWith('new file')) current.isNew = true;
    if (line.startsWith('+') && !line.startsWith('+++')) current.additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) current.deletions += 1;
  }
  if (current) files.push({ ...current, diff: current.lines.join('\n') });
  return files.length > 0 ? files : [{ path: 'workspace changes', additions: code.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).length, deletions: code.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---')).length, isNew: false, diff: code }];
}

function diffText(file: ChatDiffFile): string {
  return file.diff?.trim() || file.modifiedContent?.trim() || 'Loading diff...';
}

function diffLineClass(line: string): 'add' | 'del' | 'hunk' | 'meta' | 'ctx' {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add';
  if (line.startsWith('-') && !line.startsWith('---')) return 'del';
  if (line.startsWith('@@')) return 'hunk';
  if (/^(diff --git|index |new file|deleted file|--- |\+\+\+ )/.test(line)) return 'meta';
  return 'ctx';
}

function diffRows(text: string): Array<{ line: string; kind: ReturnType<typeof diffLineClass>; lineNumber: string }> {
  let oldLine = 1;
  let newLine = 1;
  let sawHunk = false;
  return text
    .split('\n')
    .filter(line => !/^(diff --git|index |new file mode|deleted file mode|similarity index|rename from |rename to |--- |\+\+\+ )/.test(line))
    .map((line, index) => {
      const kind = diffLineClass(line);
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        sawHunk = true;
        return { line, kind, lineNumber: '' };
      }
      if (line.startsWith('\\ No newline')) {
        return { line, kind: 'meta' as const, lineNumber: '' };
      }
      if (kind === 'add') {
        const lineNumber = String(sawHunk ? newLine : index + 1);
        newLine += 1;
        return { line, kind, lineNumber };
      }
      if (kind === 'del') {
        const lineNumber = String(sawHunk ? oldLine : index + 1);
        oldLine += 1;
        return { line, kind, lineNumber };
      }
      const lineNumber = String(sawHunk ? newLine : index + 1);
      oldLine += 1;
      newLine += 1;
      return { line, kind, lineNumber };
    });
}

function DiffCodeView({ text }: { text: string }) {
  const rows = diffRows(text);
  return (
    <div className="chat-diff-code">
      <div className="chat-diff-lines">
        {rows.map(({ line, kind, lineNumber }, index) => {
          return (
            <div key={`${index}-${line}`} className={`chat-diff-line ${kind}`}>
              <span className="ln">{lineNumber}</span>
              <code>{line || ' '}</code>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChatCodeDiffCard({
  files,
  title,
  state,
  onOpenAllFiles,
}: {
  files: ChatDiffFile[];
  title: string;
  state?: React.ReactNode;
  onOpenAllFiles?: () => void;
}) {
  const [hydratedByKey, setHydratedByKey] = useState<Record<string, ChatDiffFile>>({});
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(() => new Set());
  const loadingKeysRef = useRef<Set<string>>(new Set());
  const normalized = files.map((file, index) => {
    const key = file.key ?? `${file.sourceType ?? 'diff'}:${file.sourceId ?? file.workspaceName ?? 'diff'}:${file.path}:${index}`;
    const hydrated = hydratedByKey[key];
    return {
      ...file,
      ...hydrated,
      key,
      additions: hydrated?.additions ?? file.additions ?? 0,
      deletions: hydrated?.deletions ?? file.deletions ?? 0,
      status: hydrated?.status ?? file.status ?? ((file as ChatDiffFile & { isNew?: boolean }).isNew ? 'added' : 'modified'),
      sourceType: hydrated?.sourceType ?? file.sourceType,
      sourceId: hydrated?.sourceId ?? file.sourceId,
    };
  });
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(
    () => new Set(normalized[0]?.key ? [normalized[0].key] : []),
  );
  const totalAdditions = normalized.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const totalDeletions = normalized.reduce((sum, file) => sum + (file.deletions ?? 0), 0);

  const toggle = (key: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    const missing = normalized.filter(file =>
      expandedFiles.has(file.key) &&
      !hasDiffContent(file) &&
      file.sourceType &&
      file.sourceId &&
      !loadingKeysRef.current.has(file.key)
    );
    if (missing.length === 0) return;

    for (const file of missing) {
      loadingKeysRef.current.add(file.key);
      setLoadingKeys(prev => new Set(prev).add(file.key));
      const request = file.sourceType === 'pull-request'
        ? pullRequestsApi.getDiffFile(file.sourceId!, file.path)
        : workspacesApi.getDiffFile(file.sourceId!, file.path, { mode: 'workspace', anchor: 'creation' });
      request
        .then(hydrated => {
          if (cancelled) return;
          setHydratedByKey(prev => ({
            ...prev,
            [file.key]: {
              ...file,
              ...hydrated,
              sourceType: file.sourceType,
              sourceId: file.sourceId,
              workspaceName: file.workspaceName,
            },
          }));
        })
        .catch(() => {
          if (cancelled) return;
          setHydratedByKey(prev => ({
            ...prev,
            [file.key]: {
              ...file,
              diff: 'Failed to load diff content.',
            },
          }));
        })
        .finally(() => {
          loadingKeysRef.current.delete(file.key);
          if (cancelled) return;
          setLoadingKeys(prev => {
            const next = new Set(prev);
            next.delete(file.key);
            return next;
          });
        });
    }

    return () => { cancelled = true; };
  }, [
    expandedFiles,
    normalized.map(file => `${file.key}:${file.sourceType ?? ''}:${file.sourceId ?? ''}:${hasDiffContent(file) ? '1' : '0'}`).join('|'),
  ]);

  if (normalized.length === 0) return null;

  return (
    <div className="ch-card code-card">
      <div className="ch-card-h">
        <span className="cc-title">
          <FileText className="cc-title-icon" />
          <span>{title}</span>
        </span>
        <span className="cc-pct">
          <span className="text-accent-green">+{totalAdditions}</span>
          <span className="text-accent-red">-{totalDeletions}</span>
          {state && <span className="chat-diff-status">{state}</span>}
          {onOpenAllFiles && (
            <button type="button" className="cc-icon-action" onClick={onOpenAllFiles} title="Show all modified files">
              <Code className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      </div>
      <div className="ch-card-b">
        <div className="cc-files">
          {normalized.map(file => {
            const key = file.key ?? file.path;
            const expanded = expandedFiles.has(key);
            return (
              <div key={key} className="cc-file-wrap">
                <button type="button" className="cc-file cc-file-btn" onClick={() => toggle(key)}>
                  {expanded ? <ChevronDown className="cf-chevron" /> : <ChevronRight className="cf-chevron" />}
                  <FileText className="cf-file-icon" />
                  <span className="cf-n">{file.path}</span>
                  {(file.status === 'added' || file.status === 'untracked') && <span className="cf-new">new</span>}
                  {file.workspaceName && <span className="cf-ws">{file.workspaceName}</span>}
                  <span className="cf-p">+{file.additions ?? 0}</span>
                  <span className="cf-m">-{file.deletions ?? 0}</span>
                </button>
                {expanded && (
                  <div className="cc-file-diff">
                    {loadingKeys.has(key) && !hasDiffContent(file) ? (
                      <div className="chat-diff-code">
                        <div className="chat-diff-lines">
                          <div className="chat-diff-line meta">
                            <span className="ln">1</span>
                            <code>Loading diff...</code>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <DiffCodeView text={diffText(file)} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function InlineCodeDiffCard({ code }: { code: string }) {
  const files = parseDiffSummary(code);
  return <ChatCodeDiffCard files={files} title="Proposed changes" state="diff" />;
}

function artifactIdFromUrl(url: string): string | null {
  const match = url.match(/(?:^|\/)api\/artifacts\/([^/?#]+)(?:\/content)?(?:[?#].*)?$/)
    ?? url.match(/(?:^|\/)artifacts\/([^/?#]+)(?:\/content)?(?:[?#].*)?$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function resolveChatHref(href: string): URL | null {
  try {
    return new URL(href, typeof window !== 'undefined' ? window.location.href : 'http://localhost/');
  } catch {
    return null;
  }
}

function isSafeChatHref(href: string): boolean {
  const resolved = resolveChatHref(href);
  if (!resolved) return false;
  return ['http:', 'https:', 'mailto:', 'tel:'].includes(resolved.protocol);
}

function ArtifactMarkdownLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  const artifactId = artifactIdFromUrl(href);
  const resolvedHref = resolveChatHref(href);
  const uploadedFileId = resolvedHref ? uploadedFileNameFromUrl(resolvedHref) : null;
  const internalAppPath = resolvedHref ? allenAppPathFromUrl(resolvedHref) : null;
  const safeHref = isSafeChatHref(href);
  const chatSessionId = chatSessionIdFromHref(href);
  const linkedFilePath = filePathFromReference(href);
  const resourceContext = React.useContext(MarkdownResourceContext);
  const [artifact, setArtifact] = useState<ArtifactDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openDocument = useDocumentTabStore(state => state.openDocument);
  const openFile = useDocumentTabStore(state => state.openFile);
  const openMedia = useMediaViewerStore(state => state.openMedia);

  if (!safeHref) {
    return <span className={className} title="Unsafe link removed">{children}</span>;
  }

  async function openUploadedFile() {
    if (!uploadedFileId) return;
    const childLabel = typeof children === 'string' ? children.trim() : '';
    const displayName = childLabel || uploadedFileId;
    const mediaKind = mediaKindForPath(displayName) ?? mediaKindForPath(uploadedFileId);
    if (mediaKind) {
      openMedia({ kind: mediaKind, src: href, downloadUrl: href, title: displayName });
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(href);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      const canRenderAsText = contentType.startsWith('text/')
        || /json|csv|javascript|typescript|xml|yaml|markdown/.test(contentType)
        || /\.(?:md|markdown|txt|json|csv|ya?ml|js|jsx|ts|tsx|css|html|xml|py|rb|go|rs|java|sh|sql|toml|ini)$/i.test(displayName);
      if (!canRenderAsText) throw new Error('Unsupported in-app file preview');
      openFile({
        path: displayName,
        content: await response.text(),
        sourceKind: 'upload',
        sourceId: uploadedFileId,
        sourceLabel: 'Chat file',
        scopeKey: resourceContext.resourceScopeKey,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load file');
    } finally {
      setLoading(false);
    }
  }

  if (!artifactId && uploadedFileId) {
    return (
      <>
        <button
          type="button"
          onClick={() => void openUploadedFile()}
          className={`inline border-0 bg-transparent p-0 text-left align-baseline font-inherit ${className ?? ''}`}
        >
          {children}{loading && <span className="ml-1 text-theme-subtle">…</span>}
        </button>
        {error && !loading && <span className="ml-1 text-[10px] text-accent-red" role="alert">Failed to open file</span>}
      </>
    );
  }

  if (!artifactId && internalAppPath && !chatSessionId && !linkedFilePath) {
    return (
      <button
        type="button"
        className={`inline border-0 bg-transparent p-0 text-left align-baseline font-inherit ${className ?? ''}`}
        onClick={() => resourceContext.onOpenInternalReference?.(internalAppPath)}
      >
        {children}
      </button>
    );
  }

  if (!artifactId) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className} onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0) return;
        event.preventDefault();
        if (chatSessionId && resourceContext.onOpenChatReference) {
          resourceContext.onOpenChatReference(chatSessionId);
          return;
        }
        if (linkedFilePath && resourceContext.onOpenFileReference) {
          resourceContext.onOpenFileReference(linkedFilePath);
          return;
        }
        openExternalResource(href);
      }}>
        {children}
      </a>
    );
  }
  const resolvedArtifactId = artifactId;

  async function openArtifact() {
    const openLoadedArtifact = (loadedArtifact: ArtifactDoc) => {
      const mediaKind = mediaKindForPath(loadedArtifact.filename);
      if (mediaKind) {
        const src = artifactsApi.contentUrl(loadedArtifact.artifactId);
        openMedia({ kind: mediaKind, src, downloadUrl: src, title: loadedArtifact.filename });
      } else {
        openDocument(loadedArtifact, { sourceLabel: 'Chat', scopeKey: resourceContext.resourceScopeKey });
      }
    };
    if (artifact) {
      openLoadedArtifact(artifact);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const loadedArtifact = await artifactsApi.get(resolvedArtifactId);
      setArtifact(loadedArtifact);
      openLoadedArtifact(loadedArtifact);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load artifact');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openArtifact}
        className={`inline border-0 bg-transparent p-0 text-left align-baseline font-inherit ${className ?? ''}`}
      >
        {children}{loading && <span className="ml-1 text-theme-subtle">…</span>}
      </button>
      {error && !loading && <span className="ml-1 text-[10px] text-accent-red" role="alert">Failed to open document</span>}
    </>
  );
}

function InlineCodeReference({ value }: { value: string }) {
  const { onOpenFileReference } = React.useContext(MarkdownResourceContext);
  const path = filePathFromReference(value);
  const className = 'px-1.5 py-0.5 bg-surface-200/80 border border-app rounded text-[12px] font-mono text-accent-blue/90';
  if (!path || !onOpenFileReference) return <code className={className}>{value}</code>;
  return (
    <button
      type="button"
      className={`${className} cursor-pointer hover:border-accent-blue/50 hover:bg-accent-blue/10 transition-colors`}
      onClick={() => onOpenFileReference(path)}
      title={`Open ${path} in the file viewer`}
    >
      {value}
    </button>
  );
}

function splitFirstDiffFence(content: string): { text: string; diff: string | null } {
  const match = content.match(/```diff\n?([\s\S]*?)```/i);
  if (!match || match.index == null) return { text: content, diff: null };
  const before = content.slice(0, match.index).trimEnd();
  const after = content.slice(match.index + match[0].length).trimStart();
  return {
    text: [before, after].filter(Boolean).join('\n\n'),
    diff: match[1].replace(/\n$/, ''),
  };
}

function splitLeadingSlashCommand(content: string): { command: string | null; rest: string } {
  const match = content.match(/^\s*(\/[A-Za-z0-9:_-]+)([\s\S]*)$/);
  if (!match) return { command: null, rest: content };
  return { command: match[1], rest: match[2].replace(/^\s+/, '') };
}

/* ── Skill load slice ─────────────────────────────────────────────────────── */

/** Compact card shown in place of the text bubble for `/skill <name>` loads. */
function SkillLoadSlice({ skillLoad }: { skillLoad: { name: string; displayName: string } }) {
  return (
    <div
      data-testid="skill-load-slice"
      className="flex items-center gap-3 rounded-[10px] border px-3.5 py-2.5"
      style={{
        borderColor: 'rgb(var(--color-accent) / 0.25)',
        backgroundColor: 'rgb(var(--color-accent) / 0.07)',
      }}
    >
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border"
        style={{
          borderColor: 'rgb(var(--color-accent) / 0.35)',
          color: 'rgb(var(--color-accent))',
        }}
        aria-hidden="true"
      >
        <Zap className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0">
        <span
          className="block font-mono text-[9px] font-medium uppercase tracking-[0.14em]"
          style={{ color: 'rgb(var(--color-accent))' }}
        >
          Skill load
        </span>
        <span className="block truncate text-[13px] font-semibold text-theme-primary">
          {skillLoad.displayName}
        </span>
        <span className="block truncate font-mono text-[11px] text-theme-muted">
          {skillLoad.name}
        </span>
      </span>
    </div>
  );
}

/* ── Markdown rendering pipeline ─────────────────────────────────────────── */

/** Top-level: split by code blocks, then render everything else as inline markdown */
export function renderMarkdown(content: string): React.ReactNode {
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <span key={key++}>{renderBlocks(content.slice(lastIndex, match.index))}</span>,
      );
    }
    const lang = match[1] || '';
    const code = match[2].replace(/\n$/, '');
    if (lang.toLowerCase() === 'mermaid') {
      parts.push(<MermaidChatBlock key={key++} code={code} />);
    } else if (lang.toLowerCase() === 'diff') {
      parts.push(<InlineCodeDiffCard key={key++} code={code} />);
    } else {
      parts.push(
        <div key={key++} className="group/code relative my-3 rounded-md overflow-hidden border border-app bg-[rgb(var(--color-editor-background))]">
          <div className="flex items-center justify-between px-3 py-1.5 bg-app-muted border-b border-app">
            <span className="text-[10px] font-mono text-theme-muted uppercase tracking-wider">
              {lang || 'code'}
            </span>
            <CopyButton text={code} />
          </div>
          <pre className="px-4 py-3 overflow-x-auto text-[13px] leading-relaxed font-mono">
            <code className="text-theme-secondary">{highlightCode(code, lang)}</code>
          </pre>
        </div>,
      );
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push(
      <span key={key++}>{renderBlocks(content.slice(lastIndex))}</span>,
    );
  }

  return <div className="markdown-body">{parts}</div>;
}

/** Basic syntax highlighting by language */
function highlightCode(code: string, lang: string): React.ReactNode {
  if (!lang) return code;

  // Simple keyword-based highlighting
  const keywords: Record<string, string[]> = {
    typescript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'import', 'export', 'from', 'default', 'class', 'extends', 'new', 'this', 'async', 'await', 'try', 'catch', 'throw', 'type', 'interface', 'enum', 'implements', 'readonly', 'private', 'public', 'protected', 'static', 'typeof', 'instanceof', 'as', 'in', 'of', 'switch', 'case', 'break', 'continue'],
    javascript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'import', 'export', 'from', 'default', 'class', 'extends', 'new', 'this', 'async', 'await', 'try', 'catch', 'throw', 'typeof', 'instanceof', 'switch', 'case', 'break', 'continue'],
    python: ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'try', 'except', 'raise', 'with', 'yield', 'lambda', 'pass', 'break', 'continue', 'and', 'or', 'not', 'in', 'is', 'True', 'False', 'None', 'self', 'async', 'await'],
    yaml: ['true', 'false', 'null', 'yes', 'no'],
    bash: ['if', 'then', 'else', 'fi', 'for', 'do', 'done', 'while', 'case', 'esac', 'function', 'return', 'exit', 'echo', 'export', 'source', 'cd', 'ls', 'rm', 'cp', 'mv', 'mkdir', 'grep', 'sed', 'awk', 'curl', 'git', 'npm', 'node'],
    sql: ['SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'TABLE', 'INTO', 'VALUES', 'SET', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'AS', 'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MAX', 'MIN'],
  };
  const ts = keywords.typescript ?? [];
  const kws = keywords[lang] ?? keywords[lang.replace('ts', 'typescript')] ?? ts;
  if (kws.length === 0) return code;

  // Build a lowercase set for case-insensitive keyword matching (handles SQL uppercase keywords)
  const kwSet = new Set(kws.map(k => k.toLowerCase()));

  // Tokenize by lines for simplicity
  const codeLines = code.split('\n');
  return codeLines.map((line, li) => {
    const tokens: React.ReactNode[] = [];
    // Match strings, comments, numbers, keywords, and rest
    const tokenRegex = /(\/\/.*$|#.*$|--.*$)|(["'`])(?:(?!\2|\\).|\\.)*\2|(\b\d+\.?\d*\b)|(\b[A-Za-z_]\w*\b)|(\S)/gm;
    let m: RegExpExecArray | null;
    let lastIdx = 0;
    let tk = 0;

    while ((m = tokenRegex.exec(line)) !== null) {
      if (m.index > lastIdx) {
        tokens.push(<span key={tk++}>{line.slice(lastIdx, m.index)}</span>);
      }
      if (m[1]) {
        // Comment
        tokens.push(<span key={tk++} className="text-theme-subtle italic">{m[0]}</span>);
      } else if (m[0].match(/^["'`]/)) {
        // String
        tokens.push(<span key={tk++} className="text-green-400/80">{m[0]}</span>);
      } else if (m[3]) {
        // Number
        tokens.push(<span key={tk++} className="text-accent-orange">{m[0]}</span>);
      } else if (m[4] && kwSet.has(m[4].toLowerCase())) {
        // Keyword (case-insensitive)
        tokens.push(<span key={tk++} className="text-accent-purple">{m[0]}</span>);
      } else if (m[4] && m[4][0] === m[4][0].toUpperCase() && m[4][0] !== m[4][0].toLowerCase()) {
        // Type/Class name (starts with capital)
        tokens.push(<span key={tk++} className="text-accent-blue/90">{m[0]}</span>);
      } else {
        tokens.push(<span key={tk++}>{m[0]}</span>);
      }
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < line.length) {
      tokens.push(<span key={tk++}>{line.slice(lastIdx)}</span>);
    }

    return (
      <span key={li}>
        {tokens}
        {li < codeLines.length - 1 ? '\n' : ''}
      </span>
    );
  });
}

/** Block-level: headers, lists, blockquotes, tables, horizontal rules */
function renderBlocks(text: string): React.ReactNode {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;
  // Monotonic key counter — the line index `i` alone is not unique because
  // branches that consume multiple lines (tables, lists, blockquotes) can
  // end up sharing an `i` value with the next iteration's element.
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Table detection (line with | and next line with |---|)
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1]?.match(/^\|?[\s-:|]+\|/)) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].includes('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      elements.push(<span key={`tbl-${k++}`}>{renderTable(tableLines)}</span>);
      continue;
    }

    // Horizontal rule
    if (line.match(/^(-{3,}|\*{3,}|_{3,})$/)) {
      elements.push(
        <hr key={`hr-${k++}`} className="border-0 h-px bg-gradient-to-r from-transparent via-border to-transparent my-4" />,
      );
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <div key={`bq-${k++}`} className="border-l-2 border-accent-blue/40 pl-3 my-2 py-1">
          <div className="text-theme-secondary italic text-sm">
            {quoteLines.map((ql, qi) => (
              <div key={qi}>{renderInline(ql)}</div>
            ))}
          </div>
        </div>,
      );
      continue;
    }

    // Headers
    if (line.startsWith('### ')) {
      elements.push(
        <h4 key={`h4-${k++}`} className="text-sm font-bold text-theme-primary mt-4 mb-1.5 font-heading tracking-wide">
          {renderInline(line.slice(4))}
        </h4>,
      );
      i++;
      continue;
    }
    if (line.startsWith('## ')) {
      elements.push(
        <h3 key={`h3-${k++}`} className="text-[15px] font-bold text-theme-primary mt-5 mb-2 font-heading tracking-wide">
          {renderInline(line.slice(3))}
        </h3>,
      );
      i++;
      continue;
    }
    if (line.startsWith('# ')) {
      elements.push(
        <h2 key={`h2-${k++}`} className="text-base font-bold text-theme-primary mt-5 mb-2 font-heading tracking-wide">
          {renderInline(line.slice(2))}
        </h2>,
      );
      i++;
      continue;
    }

    // Unordered list — collect consecutive items
    if (line.match(/^[-*] /)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^[-*] /)) {
        items.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <ul key={`ul-${k++}`} className="my-2 space-y-1">
          {items.map((item, idx) => (
            <li key={idx} className="flex gap-2.5 ml-1">
              <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-accent-blue/50 mt-[7px]" />
              <span className="flex-1">{renderInline(item)}</span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list — collect consecutive items
    if (line.match(/^\d+\. /)) {
      const items: { num: string; text: string }[] = [];
      while (i < lines.length && lines[i].match(/^\d+\. /)) {
        const numMatch = lines[i].match(/^(\d+)\. (.*)/);
        if (numMatch) items.push({ num: numMatch[1], text: numMatch[2] });
        i++;
      }
      elements.push(
        <ol key={`ol-${k++}`} className="my-2 space-y-1">
          {items.map((item, idx) => (
            <li key={idx} className="flex gap-2.5 ml-1">
              <span className="shrink-0 text-accent-blue/60 font-mono text-xs mt-[2px] w-4 text-right">{item.num}.</span>
              <span className="flex-1">{renderInline(item.text)}</span>
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      elements.push(<div key={`sp-${k++}`} className="h-2" />);
      i++;
      continue;
    }

    // Regular paragraph
    elements.push(
      <p key={`p-${k++}`} className="my-0.5 leading-relaxed">{renderInline(line)}</p>,
    );
    i++;
  }

  return <>{elements}</>;
}

/** Render a markdown table */
function renderTable(lines: string[]): React.ReactNode {
  const parseRow = (line: string) =>
    line.split('|').map(c => c.trim()).filter(Boolean);

  const headers = parseRow(lines[0]);
  // Skip separator line (lines[1])
  const rows = lines.slice(2).map(parseRow);

  return (
    <div className="my-3 overflow-x-auto rounded-md border border-app">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-app-muted">
            {headers.map((h, i) => (
              <th key={i} className="px-3 py-2 text-left overline text-theme-secondary border-b border-app">
                {renderInline(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-b border-app last:border-0 hover:bg-app-muted/50 transition-colors">
              {row.map((cell, ci) => (
                <td key={ci} className="px-3 py-1.5 text-theme-secondary">
                  {renderInline(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Inline rendering: code, bold, italic, links, strikethrough, mentions */
function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  // Regex: inline code, bold, italic, links, strikethrough, mentions
  const regex = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_[^_]+_)|(~~[^~]+~~)|(\[([^\]]+)\]\(([^)]+)\))|(@[\w-]+)/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let k = 0;

  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIdx) {
      parts.push(<span key={k++}>{text.slice(lastIdx, m.index)}</span>);
    }
    if (m[1]) {
      // inline code
      parts.push(<InlineCodeReference key={k++} value={m[1].slice(1, -1)} />);
    } else if (m[2]) {
      // bold **text**
      parts.push(
        <strong key={k++} className="text-theme-primary font-semibold">
          {renderInline(m[2].slice(2, -2))}
        </strong>,
      );
    } else if (m[3]) {
      // italic *text*
      parts.push(
        <em key={k++} className="text-theme-secondary italic">
          {renderInline(m[3].slice(1, -1))}
        </em>,
      );
    } else if (m[4]) {
      // italic _text_
      parts.push(
        <em key={k++} className="text-theme-secondary italic">
          {renderInline(m[4].slice(1, -1))}
        </em>,
      );
    } else if (m[5]) {
      // strikethrough ~~text~~
      parts.push(
        <del key={k++} className="text-theme-muted line-through">
          {renderInline(m[5].slice(2, -2))}
        </del>,
      );
    } else if (m[6]) {
      // link [text](url)
      const linkClass = 'text-accent-blue hover:text-accent-blue/80 underline underline-offset-2 decoration-accent-blue/30 hover:decoration-accent-blue/60 transition-colors';
      parts.push(
        <ArtifactMarkdownLink
          key={k++}
          href={m[8]}
          className={linkClass}
        >
          {m[7]}
        </ArtifactMarkdownLink>,
      );
    } else if (m[9]) {
      // @mention
      parts.push(
        <span
          key={k++}
          className="inline-flex items-center px-1.5 py-0.5 rounded bg-accent-blue/15 text-accent-blue text-xs font-mono border border-accent-blue/20"
        >
          {m[9]}
        </span>,
      );
    }
    lastIdx = m.index + m[0].length;
  }

  if (lastIdx < text.length) {
    parts.push(<span key={k++}>{text.slice(lastIdx)}</span>);
  }

  return <>{parts}</>;
}

/* ── Tool Call Card ───────────────────────────────────────────────────────── */

const TOOL_LABELS: Record<string, { label: string; color: string }> = {
  // Chat-native file and shell activity
  read: { label: 'Read File', color: 'text-accent-blue' },
  read_file: { label: 'Read File', color: 'text-accent-blue' },
  write: { label: 'Write File', color: 'text-accent-orange' },
  write_file: { label: 'Write File', color: 'text-accent-orange' },
  edit: { label: 'Edit File', color: 'text-accent-orange' },
  edit_file: { label: 'Edit File', color: 'text-accent-orange' },
  apply_patch: { label: 'Edit File', color: 'text-accent-orange' },
  exec_command: { label: 'Run Command', color: 'text-accent-purple' },
  bash: { label: 'Run Command', color: 'text-accent-purple' },
  grep: { label: 'Search', color: 'text-accent-cyan' },
  glob: { label: 'Find Files', color: 'text-accent-cyan' },
  create_pull_request: { label: 'Create Pull Request', color: 'text-accent-green' },
  linear_get_issue: { label: 'Read Linear Issue', color: 'text-accent-purple' },
  // Phase 3-4: Core
  run_workflow: { label: 'Run Workflow', color: 'text-accent-green' },
  list_workflows: { label: 'List Workflows', color: 'text-accent-blue' },
  wait_for_execution: { label: 'Wait for Execution', color: 'text-accent-blue' },
  list_executions: { label: 'List Executions', color: 'text-accent-blue' },
  cancel_execution: { label: 'Cancel Execution', color: 'text-accent-red' },
  list_repos: { label: 'List Repos', color: 'text-accent-blue' },
  prepare_repo_context_curation: { label: 'Prepare Curation', color: 'text-accent-blue' },
  plan_repo_context_curation_assignments: { label: 'Plan Curation Workers', color: 'text-accent-purple' },
  register_repo_context_curation_assignments: { label: 'Register Curation', color: 'text-accent-purple' },
  get_repo_context_curation_stage_status: { label: 'Curation Status', color: 'text-accent-blue' },
  promote_repo_context_curation_stage: { label: 'Promote Curation', color: 'text-accent-green' },
  save_repo_context_curation_stage: { label: 'Save Curation Stage', color: 'text-accent-green' },
  save_repo_mandatory_context_mappings: { label: 'Save Mandatory Context', color: 'text-accent-green' },
  list_agents: { label: 'List Agents', color: 'text-accent-purple' },
  get_agent: { label: 'Get Agent', color: 'text-accent-purple' },
  spawn_agent: { label: 'Spawn Agent', color: 'text-accent-purple' },
  move_agent_to_team: { label: 'Move Agent', color: 'text-accent-purple' },
  report_to_user: { label: 'Progress Update', color: 'text-accent-green' },
  search_learnings: { label: 'Search Learnings', color: 'text-accent-yellow' },
  // Advanced queries
  query_database: { label: 'Query Database', color: 'text-accent-orange' },
  search_executions: { label: 'Search Executions', color: 'text-accent-blue' },
  get_workflow: { label: 'Get Workflow', color: 'text-accent-green' },
  get_team: { label: 'Get Team', color: 'text-accent-cyan' },
  get_dashboard_stats: { label: 'Dashboard Stats', color: 'text-accent-green' },
  // Debugging
  get_node_trace: { label: 'Node Trace', color: 'text-accent-yellow' },
  get_execution_logs: { label: 'Execution Logs', color: 'text-accent-yellow' },
  // Human-in-the-loop
  submit_execution_input: { label: 'Submit Input', color: 'text-accent-green' },
};

function toolBaseName(tool: string): string {
  const parts = tool.split('__');
  return parts[parts.length - 1] || tool;
}

function humanizeToolName(tool: string): string {
  const base = toolBaseName(tool);
  return TOOL_LABELS[base.toLowerCase()]?.label
    ?? TOOL_LABELS[tool.toLowerCase()]?.label
    ?? base
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, ch => ch.toUpperCase());
}

function toolColor(tool: string): string {
  const base = toolBaseName(tool);
  return TOOL_LABELS[base.toLowerCase()]?.color ?? TOOL_LABELS[tool.toLowerCase()]?.color ?? 'text-theme-secondary';
}

type ChatToolKind = 'read' | 'write' | 'command' | 'search' | 'linear' | 'pull-request' | 'database' | 'workflow' | 'web' | 'generic';

type ChatToolResource = {
  url: string;
  label: string;
  title?: string;
  kind: 'pull-request' | 'linear' | 'artifact' | 'file' | 'internal' | 'external';
  appPath?: string;
};

function chatToolKind(tool: string): ChatToolKind {
  const normalized = `${tool} ${toolBaseName(tool)}`.toLowerCase();
  if (/pull.?request|create.?pr|open.?pr|github.*pr/.test(normalized)) return 'pull-request';
  if (/linear|issue|ticket/.test(normalized)) return 'linear';
  if (/apply.?patch|write|edit|replace|create.?file|save.?file/.test(normalized)) return 'write';
  if (/exec.?command|run.?command|bash|shell|terminal/.test(normalized)) return 'command';
  if (/grep|glob|search|find/.test(normalized)) return 'search';
  if (/database|query|mongo|postgres|sql/.test(normalized)) return 'database';
  if (/workflow|execution|spawn.?agent/.test(normalized)) return 'workflow';
  if (/read|open.?file|get.?file|cat.?file/.test(normalized)) return 'read';
  if (/web|browser|fetch|http/.test(normalized)) return 'web';
  return 'generic';
}

function ToolKindIcon({ kind }: { kind: ChatToolKind }) {
  const Icon = kind === 'read' ? FileText
    : kind === 'write' ? PencilLine
      : kind === 'command' ? Terminal
        : kind === 'search' ? Search
          : kind === 'linear' ? ListTodo
            : kind === 'pull-request' ? GitPullRequest
              : kind === 'database' ? Database
                : kind === 'workflow' ? Workflow
                  : kind === 'web' ? Globe2
                    : Wrench;
  return <Icon className="h-3.5 w-3.5" />;
}

function firstString(source: unknown, keys: string[]): string | undefined {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function firstText(source: unknown, keys: string[]): string | undefined {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function validExternalUrl(value: string): string | null {
  let normalized = value.trim();
  let previous = '';
  while (normalized !== previous) {
    previous = normalized;
    normalized = normalized
      .replace(/[.,;:!?]+$/, '')
      .replace(/(?:\*{1,3}|_{2,3}|~{2}|`{1,3})+$/, '');
  }
  try {
    const url = new URL(normalized);
    return url.protocol === 'http:' || url.protocol === 'https:' ? normalized : null;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function isAllenOwnedUrl(url: URL): boolean {
  if (typeof window === 'undefined') return isLoopbackHostname(url.hostname);
  if (window.allenDesktop && isLoopbackHostname(url.hostname)) return true;
  const current = new URL(window.location.href);
  return url.hostname === current.hostname || (isLoopbackHostname(url.hostname) && isLoopbackHostname(current.hostname));
}

function allenAppPathFromUrl(url: URL): string | null {
  if (!isAllenOwnedUrl(url)) return null;
  const apiResource = url.pathname.match(/^\/api\/(workflows|executions)\/([^/]+)\/?$/);
  if (apiResource) {
    return `/${apiResource[1]}/${apiResource[2]}${url.search}${url.hash}`;
  }
  if (url.pathname.startsWith('/api/')) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

function uploadedFileNameFromUrl(url: URL): string | null {
  const match = url.pathname.match(/^\/api\/files\/([^/?#]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function resourceLabelFromKey(key?: string): string | undefined {
  if (!key) return undefined;
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
  if (['url', 'html_url', 'web_url', 'public_url', 'permalink'].includes(normalized)) return undefined;
  const base = normalized
    .replace(/_(?:html_|web_|public_)?url$/, '')
    .replace(/_artifact$/, '')
    .replace(/^resolved_/, '')
    .replace(/^final_/, '');
  return base ? humanLabel(base) : undefined;
}

function resourceFromUrl(url: string, context?: Record<string, unknown>, sourceKey?: string): ChatToolResource {
  const prMatch = url.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/i);
  const contextTitle = firstString(context, ['originalName', 'filename', 'relativePath', 'title', 'name', 'summary']);
  const contextDescription = firstString(context, ['description', 'summary', 'title']);
  const keyTitle = resourceLabelFromKey(sourceKey);
  if (prMatch) {
    return { url, kind: 'pull-request', label: `PR #${prMatch[1]}`, title: contextTitle };
  }
  if (/linear\.app\//i.test(url)) {
    const identifier = firstString(context, ['identifier', 'issueIdentifier', 'issue_id', 'issueId'])
      ?? url.match(/\/issue\/([^/?#]+)/i)?.[1];
    return { url, kind: 'linear', label: identifier || 'Linear issue', title: contextTitle };
  }
  const parsed = new URL(url);
  if (artifactIdFromUrl(url)) {
    return { url, kind: 'artifact', label: contextTitle || keyTitle || 'Untitled artifact', title: contextDescription };
  }
  const uploadedFilename = uploadedFileNameFromUrl(parsed);
  if (uploadedFilename) {
    return { url, kind: 'file', label: contextTitle || uploadedFilename, title: contextDescription };
  }
  const appPath = allenAppPathFromUrl(parsed);
  if (appPath) {
    return { url, kind: 'internal', label: contextTitle || humanLabel(parsed.pathname.split('/').filter(Boolean).pop() || 'Allen'), title: contextDescription, appPath };
  }
  let label = contextTitle || 'Open resource';
  try { label = contextTitle || parsed.hostname.replace(/^www\./, ''); } catch {}
  return { url, kind: 'external', label, title: contextTitle };
}

function extractToolResources(value: unknown): ChatToolResource[] {
  const found = new Map<string, ChatToolResource>();
  const addResource = (candidate: string, context?: Record<string, unknown>, sourceKey?: string) => {
    const url = validExternalUrl(candidate);
    if (!url || found.has(url)) return;
    const parsed = new URL(url);
    const resource = resourceFromUrl(url, context, sourceKey);
    const isWorkflowResource = resource.kind === 'internal' && resource.appPath?.startsWith('/workflows/');
    if (
      isAllenOwnedUrl(parsed)
      && resource.kind !== 'artifact'
      && resource.kind !== 'file'
      && !isWorkflowResource
    ) return;
    found.set(url, resource);
  };
  const walk = (current: unknown, depth: number, context?: Record<string, unknown>, sourceKey?: string) => {
    if (depth > 5 || current == null) return;
    if (typeof current === 'string') {
      for (const match of current.matchAll(/https?:\/\/[^\s<>()\[\]{}"']+/g)) {
        addResource(match[0], context, sourceKey);
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach(item => walk(item, depth + 1, context, sourceKey));
      return;
    }
    if (typeof current !== 'object') return;
    const record = current as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      if (typeof child === 'string' && /(^|_)(html_?url|web_?url|public_?url|permalink|url)$/i.test(key)) {
        addResource(child, record, key);
      }
      walk(child, depth + 1, record, key);
    }
  };
  walk(value, 0);
  return [...found.values()].slice(0, 5);
}

function toolPath(args?: Record<string, unknown>, result?: Record<string, unknown>): string | undefined {
  return firstString(args, ['path', 'file_path', 'filePath', 'filename', 'target_file', 'targetFile'])
    ?? firstString(result, ['path', 'file_path', 'filePath', 'filename'])
    ?? pathFromToolReceipt(firstString(result, ['raw', 'output', 'message']));
}

function toolFileSummary(args?: Record<string, unknown>, result?: Record<string, unknown>): string | undefined {
  const direct = toolPath(args, result);
  if (direct) return direct;
  const files = (Array.isArray(args?.files) ? args.files : Array.isArray(result?.files) ? result.files : [])
    .map(file => firstString(file, ['path', 'file_path', 'filePath', 'filename']))
    .filter((path): path is string => Boolean(path));
  if (files.length === 0) return undefined;
  return files.length === 1 ? files[0] : `${files[0]} + ${files.length - 1} more`;
}

function pathFromToolReceipt(text?: string): string | undefined {
  if (!text) return undefined;
  const match = text.match(/File\s+(?:created|written|updated|edited)\s+successfully\s+at:\s*(.+?)(?:\s+\(|\n|$)/i)
    ?? text.match(/The\s+file\s+(.+?)\s+has\s+been\s+(?:created|written|updated|edited)\s+successfully/i)
    ?? text.match(/^(?:Created|Wrote|Updated|Edited)\s+(?:file\s+)?[`"]?(.+?)[`"]?(?:\s+successfully)?$/im);
  return match?.[1]?.trim();
}

function toolCommand(args?: Record<string, unknown>): string | undefined {
  return firstString(args, ['cmd', 'command', 'script', 'shell_command', 'shellCommand']);
}

function linesAsDiff(text: string, prefix: '+' | '-'): string {
  return text.split('\n').map(line => `${prefix}${line}`).join('\n');
}

function toolDiff(call: ToolCallRecord | ActiveToolCall): string | null {
  const result = 'result' in call ? call.result : undefined;
  const args = call.args ?? {};
  const direct = firstText(args, ['diff', 'patch']) ?? firstText(result, ['diff', 'patch']);
  if (direct) return direct;
  const rawResult = firstText(result, ['raw']);
  if (rawResult && (/^diff --git /m.test(rawResult) || (/^---\s+/m.test(rawResult) && /^\+\+\+\s+/m.test(rawResult)))) {
    return rawResult;
  }

  const resultFiles = result?.files;
  if (Array.isArray(resultFiles)) {
    const diffs = resultFiles
      .map(file => firstText(file, ['diff', 'patch']))
      .filter((diff): diff is string => Boolean(diff));
    if (diffs.length > 0) return diffs.join('\n');
  }

  const oldText = firstText(args, ['old_string', 'oldString', 'originalContent', 'before']);
  const newText = firstText(args, ['new_string', 'newString', 'modifiedContent', 'after']);
  const path = toolPath(args, result) ?? 'changed file';
  if (oldText !== undefined || newText !== undefined) {
    return [
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@',
      oldText ? linesAsDiff(oldText, '-') : '',
      newText ? linesAsDiff(newText, '+') : '',
    ].filter(Boolean).join('\n');
  }

  const content = firstText(args, ['content', 'contents', 'text']);
  if (content && chatToolKind(call.tool) === 'write') {
    return [
      '--- /dev/null',
      `+++ b/${path}`,
      `@@ -0,0 +1,${content.split('\n').length} @@`,
      linesAsDiff(content, '+'),
    ].join('\n');
  }
  return null;
}

function toolDiffFiles(call: ToolCallRecord | ActiveToolCall): Array<{ path: string; diff: string }> {
  const result = 'result' in call ? call.result : undefined;
  const candidates = Array.isArray(result?.files) ? result.files : Array.isArray(call.args?.files) ? call.args.files : [];
  return candidates.flatMap((file, index) => {
    const diff = firstText(file, ['diff', 'patch']);
    if (!diff) return [];
    return [{ path: firstString(file, ['path', 'file_path', 'filePath', 'filename']) ?? `File ${index + 1}`, diff }];
  });
}

function toolOutputText(result?: Record<string, unknown>): string | undefined {
  return firstText(result, ['output', 'stdout', 'content', 'text', 'message', 'stderr', 'raw']);
}

function descriptionSummary(call: ToolCallRecord | ActiveToolCall): string {
  const description = call.description?.trim();
  if (!description || description.toLowerCase() === call.tool.toLowerCase()) return '';
  const base = toolBaseName(call.tool).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return description
    .replace(new RegExp(`^${base}\\s*:?\\s*`, 'i'), '')
    .replace(/^\((?:file|notebook)\)$/i, '')
    .trim();
}

function actionSummary(call: ToolCallRecord | ActiveToolCall, result?: Record<string, unknown>): string {
  const kind = chatToolKind(call.tool);
  const described = descriptionSummary(call);
  if (kind === 'command') return toolCommand(call.args) || described || argsSummary(call.args) || 'Command completed';
  if (kind === 'read') return toolFileSummary(call.args, result) || described || argsSummary(call.args) || 'File contents';
  if (kind === 'write') return toolFileSummary(call.args, result) || described || argsSummary(call.args) || 'File updated';
  if (kind === 'search') {
    const pattern = firstString(call.args, ['pattern', 'query', 'q']);
    const path = toolPath(call.args, result);
    return [pattern ? `“${pattern}”` : '', path].filter(Boolean).join(' · ') || described || argsSummary(call.args);
  }
  if (kind === 'linear') {
    return firstString(result, ['identifier', 'title', 'name']) ?? firstString(call.args, ['identifier', 'issue_id', 'query']) ?? argsSummary(call.args);
  }
  if (kind === 'pull-request') {
    const number = firstString(result, ['number', 'prNumber', 'pull_number']);
    const title = firstString(result, ['title', 'name']);
    return [number ? `PR #${number}` : '', title].filter(Boolean).join(' · ') || argsSummary(call.args);
  }
  return argsSummary(call.args) || described || resultSummary(result);
}

function compactValue(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length ? `{ ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', ...' : ''} }` : '{}';
  }
  return String(value);
}

function argsSummary(args?: Record<string, unknown>): string {
  const entries = Object.entries(args ?? {}).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return '';
  return entries.slice(0, 3).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${compactValue(v)}`).join(' · ');
}

function resultSummary(result?: Record<string, unknown>): string {
  if (!result) return '';
  if (result.error) return `Error: ${compactValue(result.error)}`;
  const raw = firstString(result, ['raw']);
  if (raw) return raw.split('\n').find(line => line.trim())?.trim() || 'Completed';
  const preferred = ['message', 'summary', 'status', 'title', 'name', 'execution_id'];
  for (const key of preferred) {
    if (result[key] !== undefined) return `${key.replace(/_/g, ' ')}: ${compactValue(result[key])}`;
  }
  const entries = Object.entries(result);
  if (entries.length === 0) return 'No output';
  return entries.slice(0, 2).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${compactValue(v)}`).join(' · ');
}

type ToolDataRow = { key: string; value: string; multiline: boolean };

function flattenToolData(value: unknown, prefix = '', depth = 0): ToolDataRow[] {
  if (value == null) return prefix ? [{ key: prefix, value: String(value), multiline: false }] : [];
  if (typeof value === 'string') return [{ key: prefix, value, multiline: value.includes('\n') || value.length > 90 }];
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [{ key: prefix, value: String(value), multiline: false }];
  }
  if (Array.isArray(value)) {
    if (value.every(item => ['string', 'number', 'boolean'].includes(typeof item))) {
      const text = value.map(String).join('\n');
      return [{ key: prefix, value: text, multiline: value.length > 1 || text.length > 90 }];
    }
    if (depth >= 2) return [{ key: prefix, value: `${value.length} items`, multiline: false }];
    return value.flatMap((item, index) => flattenToolData(item, `${prefix || 'item'} ${index + 1}`, depth + 1));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [];
    if (depth >= 2) return [{ key: prefix, value: entries.map(([key]) => key).join(', '), multiline: false }];
    return entries.flatMap(([key, child]) => flattenToolData(child, prefix ? `${prefix} · ${key}` : key, depth + 1));
  }
  return [{ key: prefix, value: String(value), multiline: false }];
}

function ToolDataBlock({ label, value }: { label: string; value: unknown }) {
  const rows = flattenToolData(value);
  if (rows.length === 0) return null;
  const rawOnly = rows.length === 1 && rows[0]?.key === 'raw';
  return (
    <div className="chat-tool-data-block">
      <div className="chat-tool-json-label">{label}</div>
      <div className="chat-tool-data-rows">
        {rows.map((row, index) => (
          <div className="chat-tool-data-row" key={`${row.key}:${index}`}>
            {!rawOnly && <span>{row.key.replace(/_/g, ' ')}</span>}
            {row.multiline || rawOnly ? <pre>{row.value}</pre> : <code>{row.value}</code>}
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolResourceLink({ resource }: { resource: ChatToolResource }) {
  const Icon = resource.kind === 'pull-request' ? GitPullRequest
    : resource.kind === 'linear' ? ListTodo
      : resource.kind === 'internal' ? Workflow
        : resource.kind === 'artifact' || resource.kind === 'file' ? FileText
          : ExternalLink;
  const resourceContext = React.useContext(MarkdownResourceContext);
  const openDocument = useDocumentTabStore(state => state.openDocument);
  const openFile = useDocumentTabStore(state => state.openFile);
  const openMedia = useMediaViewerStore(state => state.openMedia);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [artifactDoc, setArtifactDoc] = useState<ArtifactDoc | null>(null);
  useEffect(() => {
    if (resource.kind !== 'artifact') return;
    const artifactId = artifactIdFromUrl(resource.url);
    if (!artifactId) return;
    let cancelled = false;
    void (async () => {
      try {
        const artifact = await artifactsApi.get(artifactId);
        if (!cancelled && artifact) setArtifactDoc(artifact);
      } catch {
        // Keep the key-derived title and load again if the user opens it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resource.kind, resource.url]);
  const isInternal = resource.kind === 'artifact' || resource.kind === 'file' || resource.kind === 'internal';
  const displayLabel = artifactDoc?.filename || resource.label;
  const content = (
    <>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="chat-tool-resource-label">{displayLabel}</span>
      {resource.title && resource.title !== displayLabel && <span className="chat-tool-resource-title">{resource.title}</span>}
      {loading ? <Loader2 className="h-3 w-3 animate-spin chat-tool-resource-open" aria-hidden="true" />
        : isInternal ? <ChevronRight className="h-3 w-3 chat-tool-resource-open" aria-hidden="true" />
          : <ExternalLink className="h-3 w-3 chat-tool-resource-open" aria-hidden="true" />}
    </>
  );

  async function openInternalResource() {
    setError(false);
    if (resource.kind === 'internal' && resource.appPath) {
      resourceContext.onOpenInternalReference?.(resource.appPath);
      return;
    }

    if (resource.kind === 'artifact') {
      const artifactId = artifactIdFromUrl(resource.url);
      if (!artifactId) return;
      setLoading(true);
      try {
        const artifact = artifactDoc ?? await artifactsApi.get(artifactId);
        const mediaKind = mediaKindForPath(artifact.filename);
        if (mediaKind) {
          const src = artifactsApi.contentUrl(artifact.artifactId);
          openMedia({ kind: mediaKind, src, downloadUrl: src, title: artifact.filename });
        } else {
          openDocument(artifact, { sourceLabel: 'Chat', scopeKey: resourceContext.resourceScopeKey });
        }
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
      return;
    }

    if (resource.kind === 'file') {
      const parsed = new URL(resource.url, window.location.href);
      const fileId = uploadedFileNameFromUrl(parsed);
      if (!fileId) return;
      const displayName = resource.label || fileId;
      const mediaKind = mediaKindForPath(displayName) ?? mediaKindForPath(fileId);
      if (mediaKind) {
        openMedia({ kind: mediaKind, src: resource.url, downloadUrl: resource.url, title: displayName });
        return;
      }
      setLoading(true);
      try {
        const response = await fetch(resource.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
        const canRenderAsText = contentType.startsWith('text/')
          || /json|csv|javascript|typescript|xml|yaml|markdown/.test(contentType)
          || /\.(?:md|markdown|txt|json|csv|ya?ml|js|jsx|ts|tsx|css|html|xml|py|rb|go|rs|java|sh|sql|toml|ini)$/i.test(displayName);
        if (!canRenderAsText) throw new Error('Unsupported in-app file preview');
        openFile({
          path: displayName,
          content: await response.text(),
          sourceKind: 'upload',
          sourceId: fileId,
          sourceLabel: 'Chat file',
          scopeKey: resourceContext.resourceScopeKey,
        });
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    }
  }

  if (isInternal) {
    return (
      <button
        type="button"
        className={`chat-tool-resource-link internal${error ? ' error' : ''}`}
        title={error ? `Unable to preview ${displayLabel}` : resource.title ? `${displayLabel} — ${resource.title}` : `Open ${displayLabel} in Allen`}
        onClick={() => void openInternalResource()}
        disabled={loading}
      >
        {content}
      </button>
    );
  }

  return (
    <a
      href={resource.url}
      target="_blank"
      rel="noopener noreferrer"
      className="chat-tool-resource-link"
      title={resource.title ? `${displayLabel} — ${resource.title}` : displayLabel}
    >
      {content}
    </a>
  );
}

function ToolSpecializedDetails({
  call,
  kind,
  result,
  diff,
}: {
  call: ToolCallRecord | ActiveToolCall;
  kind: ChatToolKind;
  result?: Record<string, unknown>;
  diff: string | null;
}) {
  const command = kind === 'command' ? toolCommand(call.args) : undefined;
  const output = toolOutputText(result);
  const path = toolFileSummary(call.args, result);
  const diffFiles = toolDiffFiles(call);

  if (diff) {
    if (diffFiles.length > 0) {
      return (
        <div className="chat-tool-diff-stack">
          {diffFiles.map((file, index) => (
            <div className="chat-tool-diff-block" key={`${file.path}:${index}`}>
              <div className="chat-tool-detail-head">
                <span><PencilLine className="h-3.5 w-3.5" /> Diff</span>
                <code>{file.path}</code>
              </div>
              <DiffCodeView text={file.diff} />
            </div>
          ))}
        </div>
      );
    }
    return (
      <div className="chat-tool-diff-block">
        <div className="chat-tool-detail-head">
          <span><PencilLine className="h-3.5 w-3.5" /> Diff</span>
          {path && <code>{path}</code>}
        </div>
        <DiffCodeView text={diff} />
      </div>
    );
  }

  if (kind === 'command' && (command || output)) {
    return (
      <div className="chat-tool-terminal-block">
        <div className="chat-tool-detail-head">
          <span><Terminal className="h-3.5 w-3.5" /> Command</span>
        </div>
        {command && <pre className="chat-tool-command"><span aria-hidden="true">$</span> {command}</pre>}
        {output && <pre className="chat-tool-command-output">{output}</pre>}
      </div>
    );
  }

  if (kind === 'read' && output) {
    const lines = output.split('\n').map((line, index) => {
      const match = line.match(/^\s*(\d+)(?:→|\t)(.*)$/);
      return { number: match?.[1] ?? String(index + 1), content: match?.[2] ?? line };
    });
    return (
      <div className="chat-tool-file-block">
        <div className="chat-tool-detail-head">
          <span><FileText className="h-3.5 w-3.5" /> Read</span>
          {path && <code>{path}</code>}
        </div>
        <div className="chat-tool-code-lines">
          {lines.map((line, index) => (
            <div className="chat-tool-code-line" key={`${line.number}:${index}`}>
              <span aria-hidden="true">{line.number}</span>
              <code>{line.content || ' '}</code>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (kind === 'write' && output) {
    return (
      <div className="chat-tool-receipt-block">
        <CheckCircle className="h-3.5 w-3.5" aria-hidden="true" />
        <span>{output}</span>
      </div>
    );
  }

  return null;
}

function ToolCallCard({ call, active }: { call: ToolCallRecord | ActiveToolCall; active?: boolean }) {
  const isRunning = active && (call as ActiveToolCall).status === 'running';
  const result = 'result' in call ? call.result : undefined;
  const kind = chatToolKind(call.tool);
  const diff = toolDiff(call);
  const [expanded, setExpanded] = useState(Boolean(diff));
  const openedDiffRef = useRef(Boolean(diff));
  useEffect(() => {
    if (diff && !openedDiffRef.current) {
      openedDiffRef.current = true;
      setExpanded(true);
    }
  }, [diff]);
  const label = humanizeToolName(call.tool);
  const duration = 'durationMs' in call ? call.durationMs : undefined;
  const hasArgs = call.args && Object.keys(call.args).length > 0;
  const providerPrefix = call.tool.includes('__') ? call.tool.split('__').slice(0, -1).join(' / ').replace(/^mcp \/ /, '') : '';
  const executionId = result?.execution_id as string | undefined;
  const hasError = Boolean(result?.error);
  const state = isRunning ? 'running' : hasError ? 'error' : 'complete';
  const summary = actionSummary(call, result) || (isRunning ? 'Running...' : providerPrefix || call.tool);
  const resources = extractToolResources({ args: call.args, result });
  const specialized = Boolean(diff || ((kind === 'command' || kind === 'read' || kind === 'write') && toolOutputText(result)) || (kind === 'command' && toolCommand(call.args)));

  return (
    <div className="chat-tool-row" data-state={state} data-kind={kind}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="chat-tool-row-button"
        type="button"
        aria-expanded={expanded}
        title={expanded ? 'Collapse tool result' : 'Expand tool result'}
      >
        <span className="chat-tool-row-status" aria-hidden="true">
          {isRunning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : hasError ? (
            <AlertCircle className="h-3.5 w-3.5" />
          ) : (
            <ToolKindIcon kind={kind} />
          )}
        </span>
        <span className="chat-tool-row-title"><span>{label}</span></span>
        <span className="chat-tool-row-summary">{summary}</span>
        <span className="chat-tool-row-meta">
          {providerPrefix && <span>{providerPrefix}</span>}
          {duration != null && <span>{formatDuration(duration)}</span>}
          {!isRunning && !hasError && <Check className="chat-tool-state-check h-3 w-3" aria-hidden="true" />}
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
      </button>

      {(resources.length > 0 || executionId) && (
        <div className="chat-tool-resource-list" aria-label="Tool resources">
          {resources.map(resource => <ToolResourceLink key={resource.url} resource={resource} />)}
          {executionId && (
            <Link to={`/executions/${executionId}`} className="chat-tool-resource-link internal" title="View execution">
              <Workflow className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="chat-tool-resource-label">Execution</span>
              <span className="chat-tool-resource-title">{executionId}</span>
              <ChevronRight className="h-3 w-3 chat-tool-resource-open" aria-hidden="true" />
            </Link>
          )}
        </div>
      )}

      {expanded && (
        <div className="chat-tool-row-details">
          <ToolSpecializedDetails call={call} kind={kind} result={result} diff={diff} />
          {hasArgs && !specialized && (
            <ToolDataBlock label="Input" value={call.args} />
          )}
          {result && !specialized && (
            <ToolDataBlock label="Output" value={result} />
          )}
          {!hasArgs && !result && !specialized && (
            <div className="chat-tool-empty-detail">Waiting for tool input/output details...</div>
          )}
        </div>
      )}
    </div>
  );
}

function toolCallLineText(call: ToolCallRecord | ActiveToolCall): string {
  const label = humanizeToolName(call.tool);
  const result = 'result' in call ? call.result : undefined;
  const detail = actionSummary(call, result);
  return detail ? `${label} · ${detail}` : label;
}

function toolFileKeys(call: ToolCallRecord): string[] {
  const result = call.result;
  const direct = toolPath(call.args, result);
  if (direct) return [direct];
  const files = (Array.isArray(call.args?.files) ? call.args.files : Array.isArray(result?.files) ? result.files : [])
    .map(file => firstString(file, ['path', 'file_path', 'filePath', 'filename']))
    .filter((path): path is string => Boolean(path));
  if (files.length > 0) return files;
  const kind = chatToolKind(call.tool);
  return kind === 'read' || kind === 'write' ? [`${call.toolUseId ?? call.tool}:${call.timestamp}`] : [];
}

function ToolCallLine({ call, count, active }: { call: ToolCallRecord | ActiveToolCall; count: number; active?: boolean }) {
  const isRunning = active && (call as ActiveToolCall).status === 'running';
  const result = 'result' in call ? call.result : undefined;
  const duration = 'durationMs' in call ? call.durationMs : undefined;
  const executionId = result?.execution_id as string | undefined;
  const hasError = Boolean(result?.error);
  const kind = chatToolKind(call.tool);

  return (
    <div className={`chat-tool-latest-line ${isRunning ? 'running' : ''} ${hasError ? 'error' : ''}`}>
      <span className="chat-tool-inline-kind" data-kind={kind} aria-hidden="true">
        {isRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : hasError ? <AlertCircle className="h-3 w-3" /> : <ToolKindIcon kind={kind} />}
      </span>
      <span className="chat-tool-count">{count} tool call{count === 1 ? '' : 's'}</span>
      <span className="chat-tool-text">{toolCallLineText(call)}</span>
      {duration != null && <span className="chat-tool-duration">{formatDuration(duration)}</span>}
      {executionId && (
        <Link to={`/executions/${executionId}`} className="chat-tool-exec-link" title="Open execution in Allen">
          <ChevronRight className="h-3 w-3" />
        </Link>
      )}
    </div>
  );
}

/**
 * Completed message: tool calls reduced to latest activity.
 */
function ToolCallsSection({ calls }: { calls?: ToolCallRecord[] }) {
  if (!calls || calls.length === 0) return null;
  const duration = calls.reduce((total, call) => total + (call.durationMs ?? 0), 0);
  const files = new Set(calls.flatMap(toolFileKeys)).size;
  const queries = calls.filter(call => /query|search|find/i.test(toolBaseName(call.tool))).length;
  const summary = [files ? `${files} file${files === 1 ? '' : 's'}` : null, queries ? `${queries} quer${queries === 1 ? 'y' : 'ies'}` : null, `${calls.length} tool${calls.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ');

  return (
    <details className="chat-activity-group tools" open>
      <summary className="chat-activity-summary">
        <ChevronRight className="chat-activity-chevron" />
        <span>Worked for {formatDuration(duration)}</span>
        <em>{summary}</em>
      </summary>
      <div className="chat-activity-expansion chat-tool-history">
        {calls.map((call, i) => <ToolCallCard key={`${call.toolUseId ?? call.tool}-${i}`} call={call} />)}
      </div>
    </details>
  );
}

/**
 * Streaming: running tool indicator.
 */
function ActiveToolCallsSection({ calls }: { calls: ActiveToolCall[] }) {
  const [showTools, setShowTools] = useState(false);
  if (calls.length === 0) return null;

  const runningTool = [...calls].reverse().find(c => (c as ActiveToolCall).status === 'running');
  const latestCall = runningTool ?? calls[calls.length - 1];

  return (
    <div className="mt-3 space-y-2">
      {latestCall && (
        <button type="button" className="chat-tool-disclosure" data-expanded={showTools} onClick={() => setShowTools(value => !value)}>
          {showTools ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <ToolCallLine call={latestCall} count={calls.length} active />
        </button>
      )}
      {showTools && (
        <div className="chat-tool-history">
          <div className="chat-tool-history-head">
            <span>Tool calls</span>
            <span>{calls.length}</span>
          </div>
          {calls.map((call, i) => (
            <ToolCallCard key={`${call.toolUseId ?? call.tool}-${i}`} call={call} active />
          ))}
        </div>
      )}
    </div>
  );
}

function ChatCodeDiffPreview({
  runs,
  sessionId,
  messageId,
  onReady,
  onOpenAllFiles,
}: {
  runs: SpawnedAgent[];
  sessionId?: string;
  messageId?: string;
  onReady?: () => void;
  onOpenAllFiles?: () => void;
}) {
  const [bundles, setBundles] = useState<ChatDiffBundle[]>([]);
  const [loading, setLoading] = useState(false);

  const workspaceRefs: Array<{ id: string; name?: string | null }> = [];
  const pullRequestRefs: Array<{ id: string; name?: string | null }> = [];
  const allTerminal = runs.length > 0 && runs.every(run => TERMINAL_RUN_STATUSES.has(run.runContext?.status ?? run.status));
  for (const run of runs) {
    const id = run.runContext?.workspace?.id;
    if (typeof id === 'string' && id.length > 0) {
      workspaceRefs.push({
        id,
        name: run.runContext?.workspace?.name ?? run.runContext?.workspace?.repoName,
      });
    }
    const prId = run.runContext?.pullRequest?.id;
    if (typeof prId === 'string' && prId.length > 0) {
      pullRequestRefs.push({
        id: prId,
        name: run.runContext?.pullRequest?.title ?? (run.runContext?.pullRequest?.number ? `PR #${run.runContext.pullRequest.number}` : 'pull request'),
      });
    }
  }
  const workspaceSignature = [...new Set(workspaceRefs.map(ref => ref.id))].join('|');
  const pullRequestSignature = [...new Set(pullRequestRefs.map(ref => ref.id))].join('|');
  const sourceSignature = [workspaceSignature, pullRequestSignature].filter(Boolean).join('::');
  const runSignature = runs
    .map(run => `${run.executionId}:${run.status}:${run.runContext?.status ?? ''}`)
    .join('|');

  useEffect(() => {
    if (!sourceSignature) {
      setBundles([]);
      return;
    }
    let cancelled = false;
    const uniqueRefs = workspaceRefs.filter((ref, index, arr) => arr.findIndex(item => item.id === ref.id) === index);
    const uniquePrRefs = pullRequestRefs.filter((ref, index, arr) => arr.findIndex(item => item.id === ref.id) === index);
    const snapshotBundles = (snapshots: ChatDiffSnapshot[]): ChatDiffBundle[] => snapshots
      .map(snapshot => {
        const sourceId = String(snapshot.workspaceId ?? '');
        const isPrSnapshot = sourceId.startsWith('pr:');
        return {
          workspaceId: snapshot.workspaceId,
          workspaceName: snapshot.workspaceName,
          files: ((snapshot.files ?? []) as ChatDiffFile[])
            .filter(hasChangedDiffMetadata)
            .map(file => ({
              ...file,
              sourceType: isPrSnapshot ? 'pull-request' as const : 'workspace' as const,
              sourceId: isPrSnapshot ? sourceId.slice(3) : sourceId,
            })),
        };
      })
      .filter(bundle => bundle.files.length > 0);
    setLoading(true);
    (async () => {
      if (sessionId && messageId) {
        try {
          const saved = await chatCodeDiffs.list(sessionId, messageId);
          const frozen = snapshotBundles(saved.snapshots as ChatDiffSnapshot[]);
          if (frozen.length > 0) return frozen;
        } catch {}
      }

      const live = await Promise.all(uniqueRefs.map(async (ref) => {
        try {
          const result = await workspacesApi.getDiff(ref.id, { mode: 'workspace', anchor: 'creation' });
          const files = ((result.files ?? []) as ChatDiffFile[])
            .filter(hasChangedDiffMetadata)
            .map(file => ({ ...file, sourceType: 'workspace' as const, sourceId: ref.id }));
          return { workspaceId: ref.id, workspaceName: ref.name, files };
        } catch {
          return { workspaceId: ref.id, workspaceName: ref.name, files: [] };
        }
      }));

      const populatedLive = live.filter(bundle => bundle.files.length > 0);
      if (sessionId && messageId && allTerminal && populatedLive.length > 0) {
        try {
          const captured = await chatCodeDiffs.capture(sessionId, {
            messageId,
            executionIds: runs.map(run => run.executionId).filter(Boolean),
            workspaces: uniqueRefs,
            mode: 'workspace',
          });
          const frozen = snapshotBundles(captured.snapshots as ChatDiffSnapshot[]);
          if (frozen.length > 0) return frozen;
        } catch {}
      }

      if (populatedLive.length > 0) return populatedLive;

      const prBundles = await Promise.all(uniquePrRefs.map(async (ref) => {
        try {
          const result = await pullRequestsApi.getDiff(ref.id);
          const files = ((result.files ?? []) as Array<{ path: string; diff?: string; originalContent?: string; modifiedContent?: string }>)
            .filter(file => hasChangedDiffMetadata(file as ChatDiffFile))
            .map(file => {
              const counts = diffLineCounts(file.diff);
              return {
                ...file,
                status: (file as any).status ?? (file.diff?.includes('new file mode') ? 'added' : file.diff?.includes('deleted file mode') ? 'deleted' : 'modified'),
                additions: (file as any).additions ?? counts.additions,
                deletions: (file as any).deletions ?? counts.deletions,
                sourceType: 'pull-request' as const,
                sourceId: ref.id,
              } as ChatDiffFile;
            });
          return { workspaceId: `pr:${ref.id}`, workspaceName: ref.name, files };
        } catch {
          return { workspaceId: `pr:${ref.id}`, workspaceName: ref.name, files: [] };
        }
      }));

      return prBundles.filter(bundle => bundle.files.length > 0);
    })().then(next => {
      if (cancelled) return;
      setBundles(next);
      if (next.length > 0) window.setTimeout(() => onReady?.(), 0);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [sourceSignature, runSignature, sessionId, messageId, allTerminal, onReady]);

  if (!sourceSignature) return null;
  const totalFiles = bundles.reduce((sum, bundle) => sum + bundle.files.length, 0);
  const visibleFiles = bundles.flatMap(bundle => bundle.files.map((file, index) => ({
    ...file,
    workspaceName: bundle.workspaceName,
    key: `${bundle.workspaceId}:${file.path}:${index}`,
  })));

  if (!loading && totalFiles === 0) return null;

  return (
    <div className="ch-msg allen al-msg-enter">
      <div className="ch-avatar">a</div>
      <div className="ch-msg-body">
        {loading ? (
          <div className="chat-diff-card">
            <div className="chat-diff-head">
              <div className="chat-diff-title">
                <span className="chat-diff-badge">code diff</span>
                <span>Checking workspace diff</span>
              </div>
              <div className="chat-diff-stats">
                <span className="dot pulse accent" />
                <span>loading</span>
              </div>
            </div>
          </div>
        ) : (
          <ChatCodeDiffCard
            files={visibleFiles}
            title={`${totalFiles} file${totalFiles === 1 ? '' : 's'} modified`}
            state={allTerminal ? undefined : <><span className="dot pulse accent" /> live</>}
            onOpenAllFiles={onOpenAllFiles}
          />
        )}
      </div>
    </div>
  );
}

function ChatPullRequestCards({ runs }: { runs: SpawnedAgent[] }) {
  const prs = new Map<string, NonNullable<NonNullable<SpawnedAgent['runContext']>['pullRequest']>>();
  for (const run of runs) {
    const pr = run.runContext?.pullRequest;
    const key = pr?.url ?? (pr?.number != null ? String(pr.number) : '');
    if (pr && key) prs.set(key, pr);
  }
  if (prs.size === 0) return null;
  return (
    <>
      {[...prs.values()].map((pr) => {
        const status = humanLabel(pr.status ?? 'open');
        const age = timeAgo(pr.mergedAt ?? pr.updatedAt ?? pr.createdAt);
        return (
          <div key={pr.url ?? pr.number ?? pr.title ?? 'pr'} className="ch-msg allen al-msg-enter">
            <div className="ch-avatar">a</div>
            <div className="ch-msg-body">
              <div className="ch-card pr-card-inline">
                <div className="ch-card-h">
                  <span className="cc-tag pr">pull request</span>
                  <span className="cc-title">PR {pr.number ? `#${pr.number}` : ''} {status}</span>
                  <span className="cc-pct">{age}</span>
                </div>
                <div className="ch-card-b">
                  <div className="cc-pr-meta">
                    {pr.title ?? 'Pull request ready'}{pr.branch ? <> · branch <code>{pr.branch}</code></> : null}
                  </div>
                  <div className="cc-acts">
                    {pr.url && (
                      <a className="btn primary sm" href={pr.url} target="_blank" rel="noopener noreferrer">review on github</a>
                    )}
                    <a className="btn sm" href="/pull-requests">open pull requests</a>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

/* ── Main component ──────────────────────────────────────────────────────── */

/** Build a tree from a flat thread list using parentConversationId */
function statusTone(status: string): string {
  if (status === 'completed') return 'border-accent-green/35 bg-accent-green/5';
  if (status === 'failed' || isCancelledExecutionStatus(status)) return 'border-accent-red/35 bg-accent-red/5';
  if (status === 'waiting_for_input') return 'border-accent-yellow/45 bg-accent-yellow/5';
  return 'border-accent/40 bg-accent/5';
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'completed') return <CheckCircle className="w-3.5 h-3.5 text-accent-green" />;
  if (status === 'failed' || isCancelledExecutionStatus(status)) return <AlertCircle className="w-3.5 h-3.5 text-accent-red" />;
  if (status === 'waiting_for_input') return <AlertTriangle className="w-3.5 h-3.5 text-accent-yellow" />;
  return <Loader2 className="w-3.5 h-3.5 text-accent animate-spin" />;
}

function timeAgo(dateStr?: string | null): string {
  if (!dateStr) return 'recently';
  const ms = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function prLabel(pr: NonNullable<SpawnedAgent['runContext']>['pullRequest']): string {
  if (!pr) return 'PR';
  const status = pr.status ? humanLabel(pr.status) : 'open';
  const age = timeAgo(pr.mergedAt ?? pr.updatedAt ?? pr.createdAt);
  return `PR ${pr.number ? `#${pr.number}` : status} · ${status} · ${age}`;
}

function artifactsForRun(run: SpawnedAgent) {
  return (run.runContext?.artifacts ?? []).filter((artifact) => {
    if (!artifact.url) return false;
    if (artifact.rootId === run.executionId) return true;
    if (artifact.spawnContext?.agentExecutionId === run.executionId) return true;
    if (artifact.spawnContext?.parentId === run.executionId) return true;
    return false;
  });
}

function nodeStatusTone(status: string): string {
  if (status === 'completed' || status === 'skipped') return 'border-accent-green/35 bg-accent-green/5';
  if (status === 'failed' || isCancelledExecutionStatus(status)) return 'border-accent-red/35 bg-accent-red/5';
  if (status === 'waiting_for_input') return 'border-accent-yellow/45 bg-accent-yellow/5';
  if (status === 'running') return 'border-accent/40 bg-accent/5';
  return 'border-app bg-app-card';
}

function NodeStatusIcon({ status }: { status: string }) {
  if (status === 'completed' || status === 'skipped') return <CheckCircle className="w-3.5 h-3.5 text-accent-green" />;
  if (status === 'failed' || isCancelledExecutionStatus(status)) return <AlertCircle className="w-3.5 h-3.5 text-accent-red" />;
  if (status === 'waiting_for_input') return <AlertTriangle className="w-3.5 h-3.5 text-accent-yellow" />;
  if (status === 'running') return <Loader2 className="w-3.5 h-3.5 text-accent animate-spin" />;
  return <Clock className="w-3.5 h-3.5 text-theme-subtle" />;
}

function WorkflowStepCard({ step, run }: { step: NonNullable<SpawnedAgent['runContext']>['workflowSteps'][number]; run: SpawnedAgent }) {
  const attempts = Math.max(0, step.attempts ?? 0);
  const status = step.status || 'pending';
  return (
    <div className={`border rounded-lg p-3 ${nodeStatusTone(status)}`}>
      <div className="flex items-start gap-2">
        <NodeStatusIcon status={status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[9px] uppercase text-theme-subtle font-mono shrink-0">{step.type ?? 'node'}</span>
            <span className="text-[11px] font-mono font-bold text-theme-secondary truncate">{humanLabel(step.name)}</span>
            {step.agent && <span className="text-[9px] text-theme-subtle font-mono shrink-0">{step.agent}</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-theme-muted">
            <span className="font-mono capitalize">{humanLabel(status)}</span>
            <span className="font-mono">{attempts > 1 ? `${attempts} attempts` : attempts === 1 ? '1 attempt' : 'pending'}</span>
            {step.model && <span className="truncate max-w-[220px]">{getModelDisplay(step.agent ?? '', step.model).modelLabel}</span>}
          </div>
          <div className="mt-2 grid grid-cols-1 gap-1 font-mono text-[10px] text-theme-subtle sm:grid-cols-3">
            <span className="flex min-w-0 items-center gap-1 truncate" title="Started at">
              <PlayCircle className="h-3 w-3 shrink-0 text-accent-green" />
              <span className="truncate">{formatClock(step.startedAt)}</span>
            </span>
            <span className="flex min-w-0 items-center gap-1 truncate" title="Ended at">
              <StopCircle className="h-3 w-3 shrink-0 text-accent-red" />
              <span className="truncate">{formatClock(step.completedAt)}</span>
            </span>
            <span className="flex min-w-0 items-center gap-1 truncate" title="Duration">
              <Timer className="h-3 w-3 shrink-0 text-accent" />
              <span className="truncate">{formatDuration(step.durationMs)}</span>
            </span>
          </div>
        </div>
        <a href={`/executions/${run.executionId}`} target="_blank" rel="noopener noreferrer" className="shrink-0 p-1 rounded-sm text-accent hover:bg-app-muted" title="Open execution">
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </div>
      {(attempts > 1 || Boolean(step.retryReasons?.length)) && (
        <div className="mt-2 inline-flex rounded bg-accent-yellow/10 px-2 py-1 font-mono text-[10px] text-accent-yellow">
          retry {attempts}x{step.retryReasons?.[0] ? ` · ${humanLabel(step.retryReasons[0])}` : ''}
        </div>
      )}
      {step.error && (
        <div className="mt-2 rounded-md border border-accent-red/20 bg-accent-red/10 px-2 py-1 text-[10px] text-accent-red">
          {step.error}
        </div>
      )}
    </div>
  );
}

function RunProgressCard({ run }: { run: SpawnedAgent }) {
  const context = run.runContext;
  const status = context?.status ?? run.status;
  const title = context?.title || run.agent;
  const phase = context?.progress.phase ?? status;
  const percent = context?.progress.percent ?? (status === 'completed' ? 100 : 0);
  const currentStep = context?.progress.currentStep;
  const activity = context?.recentActivity?.slice(-3) ?? [];
  const childAgents = context?.childAgents ?? [];
  const artifacts = artifactsForRun(run);

  return (
    <div className={`border rounded-lg p-3 ${statusTone(status)}`}>
      <div className="flex items-start gap-2">
        <StatusIcon status={status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[9px] uppercase text-theme-subtle font-mono shrink-0">{context?.runType ?? run.kind ?? 'run'}</span>
            <span className="text-[11px] font-mono font-bold text-theme-secondary truncate">{title}</span>
            <span className="text-[9px] text-theme-subtle font-mono shrink-0">{run.executionId.slice(0, 8)}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-theme-muted">
            <span className="font-mono capitalize">{humanLabel(status)}</span>
            <span className="font-mono capitalize">{humanLabel(phase)}</span>
            {currentStep && <span className="truncate max-w-[220px]">Step: {currentStep}</span>}
          </div>
        </div>
        <a href={`/executions/${run.executionId}`} target="_blank" rel="noopener noreferrer" className="shrink-0 p-1 rounded-sm text-accent hover:bg-app-muted" title="Open execution">
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </div>

      <div className="mt-2 h-1.5 rounded-full bg-app-muted overflow-hidden">
        <div className="h-full bg-accent transition-all" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
      </div>
      <div className="mt-1 flex items-center justify-between text-[9px] font-mono text-theme-subtle">
        <span>{context?.progress.label ?? 'starting'}</span>
        <span>{percent}%</span>
      </div>

      {context?.humanInput?.required && (
        <div className="mt-2 flex items-center gap-1.5 rounded-md border border-accent-yellow/35 bg-yellow-500/10 px-2 py-1 text-[10px] text-accent-yellow">
          <AlertTriangle className="w-3 h-3 shrink-0" />
          <span className="truncate">{context.humanInput.title ?? 'Waiting for human input'}</span>
        </div>
      )}

      <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[10px]">
        {context?.workspace?.id && (
          <a href={workspaceChatPath(context.workspace.id)} className="flex items-center gap-1.5 text-theme-muted hover:text-accent min-w-0">
            <FolderGit2 className="w-3 h-3 shrink-0" />
            <span className="truncate">{context.workspace.repoName ?? context.workspace.name ?? 'Workspace'} · {context.workspace.branch ?? 'branch'}</span>
          </a>
        )}
        {context?.pullRequest?.url && (
          <a href={context.pullRequest.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-theme-muted hover:text-accent min-w-0">
            <GitPullRequest className="w-3 h-3 shrink-0" />
            <span className="truncate">{prLabel(context.pullRequest)}</span>
          </a>
        )}
        {context?.linear?.url && (
          <a href={context.linear.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-theme-muted hover:text-accent min-w-0">
            <ExternalLink className="w-3 h-3 shrink-0" />
            <span className="truncate">{context.linear.identifier ?? context.linear.title ?? 'Linear ticket'}</span>
          </a>
        )}
        {artifacts.slice(0, 2).map(artifact => (
          <ArtifactMarkdownLink key={artifact.artifactId} href={artifact.url ?? `/api/artifacts/${artifact.artifactId}/content`} className="flex items-center gap-1.5 text-theme-muted hover:text-accent min-w-0">
            <FileText className="w-3 h-3 shrink-0" />
            <span className="truncate">{artifact.filename ?? 'Artifact'}</span>
          </ArtifactMarkdownLink>
        ))}
      </div>

      {childAgents.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {childAgents.slice(0, 4).map(child => (
            <a key={child.executionId} href={`/executions/${child.executionId}`} className="rounded-sm bg-app-muted px-1.5 py-0.5 text-[9px] font-mono text-theme-muted hover:text-accent">
              {child.agentName}: {humanLabel(child.status)}
            </a>
          ))}
        </div>
      )}

      {activity.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {activity.map((item, idx) => (
            <div key={`${item.at ?? idx}-${idx}`} className="flex items-center gap-1.5 text-[10px] font-mono text-theme-subtle min-w-0">
              <Clock className="w-2.5 h-2.5 shrink-0" />
              <span className="truncate">{item.agent ? `${item.agent}: ` : ''}{item.label}</span>
            </div>
          ))}
        </div>
      )}

      {!context && run.activity.length > 0 && (
        <div className="mt-2 space-y-0.5 max-h-24 overflow-y-auto">
          {run.activity.slice(-4).map((a, i) => (
            <div key={i} className="flex items-center gap-1.5 text-[10px] font-mono text-theme-subtle">
              <Wrench className="w-2.5 h-2.5 shrink-0" />
              <span className="truncate">{humanLabel(a.type)}{a.tool ? ` · ${a.tool}` : ''}{a.command ? ` · ${a.command}` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function workflowAttemptFailureLabel(run: SpawnedAgent): string {
  const context = run.runContext;
  const failedStep = context?.execution.failedNode
    ?? context?.progress.currentStep
    ?? context?.workflowSteps.find(step => step.status === 'failed' || isCancelledExecutionStatus(step.status))?.name
    ?? null;
  if (failedStep) return `Failed at ${humanLabel(String(failedStep))}`;
  return 'Failed';
}

function WorkflowAttemptCard({ run, index }: { run: SpawnedAgent; index: number }) {
  const context = run.runContext;
  const status = context?.status ?? run.status;
  const summary =
    status === 'failed' || isCancelledExecutionStatus(status) ? workflowAttemptFailureLabel(run)
      : status === 'completed' ? 'Passed'
        : context?.progress.currentStep ? `Running ${humanLabel(context.progress.currentStep)}`
          : humanLabel(context?.progress.phase ?? status);

  return (
    <div className={`border rounded-lg p-3 ${statusTone(status)}`}>
      <div className="flex items-start gap-2">
        <StatusIcon status={status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[9px] uppercase text-theme-subtle font-mono shrink-0">Attempt {index + 1}</span>
            <span className="text-[11px] font-mono font-bold text-theme-secondary truncate">{summary}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-theme-muted">
            <span className="font-mono">{run.executionId.slice(0, 8)}</span>
            <span className="font-mono">{context?.progress.label ?? 'workflow'}</span>
            <span className="font-mono capitalize">{humanLabel(status)}</span>
          </div>
        </div>
        <a href={`/executions/${run.executionId}`} target="_blank" rel="noopener noreferrer" className="shrink-0 p-1 rounded-sm text-accent hover:bg-app-muted" title="Open execution">
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </div>
    </div>
  );
}

function RunProgressTimeline({ runs }: { runs: SpawnedAgent[] }) {
  const workflowAttemptRuns = runs.filter(run => run.runContext?.runType === 'workflow' || run.kind === 'workflow');
  if (workflowAttemptRuns.length > 1 && workflowAttemptRuns.length === runs.length) {
    const fullRun =
      [...workflowAttemptRuns].reverse().find(run => run.runContext?.status === 'completed' && (run.runContext.workflowSteps?.length ?? 0) > 0)
      ?? [...workflowAttemptRuns].reverse().find(run => (run.runContext?.workflowSteps?.length ?? 0) > 0)
      ?? workflowAttemptRuns[workflowAttemptRuns.length - 1];
    const steps = fullRun.runContext?.workflowSteps ?? [];
    return (
      <div className="max-w-[820px]">
        <div className="space-y-0">
          {workflowAttemptRuns.map((run, index) => {
            const isLast = index === workflowAttemptRuns.length - 1 && steps.length === 0;
            const status = run.runContext?.status ?? run.status;
            return (
              <div key={run.executionId} className="relative grid grid-cols-[26px_1fr] gap-3 pb-3">
                {!isLast && <span className="absolute bottom-[-14px] left-[11px] top-[24px] w-[2px] rounded-full bg-[rgb(var(--color-border))]" />}
                <div className={`relative z-[1] flex h-6 w-6 items-center justify-center rounded-full border bg-app-card ${statusTone(status)}`}>
                  <StatusIcon status={status} />
                </div>
                <div className="min-w-0">
                  <WorkflowAttemptCard run={run} index={index} />
                </div>
              </div>
            );
          })}
          {steps.length > 0 && (
            <div className="ml-[26px] border-l-[2px] border-app pl-3">
              <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-theme-muted">
                Successful workflow steps
              </div>
              {steps.map((step, index) => {
                const isLast = index === steps.length - 1;
                return (
                  <div key={`${fullRun.executionId}-${step.id}`} className="relative grid grid-cols-[26px_1fr] gap-3 pb-3">
                    {!isLast && <span className="absolute bottom-[-14px] left-[11px] top-[24px] w-[2px] rounded-full bg-[rgb(var(--color-border))]" />}
                    <div className={`relative z-[1] flex h-6 w-6 items-center justify-center rounded-full border bg-app-card ${nodeStatusTone(step.status)}`}>
                      <NodeStatusIcon status={step.status} />
                    </div>
                    <WorkflowStepCard step={step} run={fullRun} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (runs.length === 1 && runs[0].runContext?.runType === 'workflow' && (runs[0].runContext.workflowSteps?.length ?? 0) > 0) {
    const run = runs[0];
    const steps = run.runContext!.workflowSteps;
    return (
      <div className="max-w-[820px]">
        <div className="space-y-0">
          {steps.map((step, index) => {
            const isLast = index === steps.length - 1;
            return (
              <div key={`${run.executionId}-${step.id}`} className="relative grid grid-cols-[26px_1fr] gap-3 pb-3">
                {!isLast && <span className="absolute bottom-[-14px] left-[11px] top-[24px] w-[2px] rounded-full bg-[rgb(var(--color-border))]" />}
                <div className={`relative z-[1] flex h-6 w-6 items-center justify-center rounded-full border bg-app-card ${nodeStatusTone(step.status)}`}>
                  <NodeStatusIcon status={step.status} />
                </div>
                <div className="min-w-0">
                  <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.08em] text-theme-muted">
                    <span>Step {index + 1}</span>
                    <span className="h-px flex-1 bg-app-strong" />
                  </div>
                  <WorkflowStepCard step={step} run={run} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[820px]">
      <div className="space-y-0">
        {runs.map((run, index) => {
          const status = run.runContext?.status ?? run.status;
          const isLast = index === runs.length - 1;
          return (
            <div key={run.executionId} className="relative grid grid-cols-[26px_1fr] gap-3 pb-3">
              {!isLast && <span className="absolute bottom-[-14px] left-[11px] top-[24px] w-[2px] rounded-full bg-[rgb(var(--color-border))]" />}
              <div className={`relative z-[1] flex h-6 w-6 items-center justify-center rounded-full border bg-app-card ${statusTone(status)}`}>
                <StatusIcon status={status} />
              </div>
              <div className="min-w-0">
                <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.08em] text-theme-muted">
                  <span>Step {index + 1}</span>
                  <span className="h-px flex-1 bg-app-strong" />
                </div>
                <RunProgressCard run={run} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const TERMINAL_RUN_STATUSES = {
  has: (status: string) => isTerminalExecutionStatus(status),
};

function activityLine(run: SpawnedAgent, item: any): { key: string; text: string; at: string | number } | null {
  const at = item.at ?? item.timestamp ?? Date.now();
  const agent = item.agent ?? run.agent ?? 'agent';
  const type = String(item.type ?? '');
  const tool = item.tool ? String(item.tool) : '';
  const content = item.label ?? item.content ?? item.command ?? '';
  const cleanContent = typeof content === 'string' ? content.replace(/\s+/g, ' ').trim() : '';
  let text = '';
  if (type === 'tool_call' || type === 'tool_start') {
    text = `${agent} started ${tool || 'a tool'}${cleanContent ? `: ${cleanContent}` : ''}`;
  } else if (type === 'tool_result' || type === 'tool_done') {
    text = `${agent} finished ${tool || 'a tool'}${cleanContent ? `: ${cleanContent}` : ''}`;
  } else if (type === 'thinking') {
    text = cleanContent ? `${agent} is thinking: ${cleanContent}` : `${agent} is thinking`;
  } else {
    text = cleanContent ? `${agent}: ${cleanContent}` : `${agent}: ${humanLabel(type || 'activity')}`;
  }
  return { key: `${run.executionId}-${at}-${type}-${tool}-${text}`, text, at };
}

function activityRowsForRun(run: SpawnedAgent): Array<{ key: string; text: string; at: string | number }> {
  const rows = [
    ...(run.runContext?.recentActivity ?? []).slice(-8).map(item => activityLine(run, item)),
    ...run.activity.slice(-8).map(item => activityLine(run, item)),
  ]
    .filter((row): row is { key: string; text: string; at: string | number } => Boolean(row))
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    .slice(-8);

  const seen = new Set<string>();
  return rows.filter(row => {
    const normalized = row.text.toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function archivedActivityRowsForRun(run: SpawnedAgent, count: number): Array<{ key: string; text: string; at: string | number }> {
  if (count <= 0) return [];
  try {
    const raw = sessionStorage.getItem(`allen-run-activity:${run.executionId}`);
    if (!raw) return [];
    const items = JSON.parse(raw) as Array<{ type?: string; tool?: string; command?: string; content?: string; timestamp?: number }>;
    return items
      .slice(-count)
      .map(item => activityLine(run, item))
      .filter((row): row is { key: string; text: string; at: string | number } => Boolean(row));
  } catch {
    return [];
  }
}

function isWorkflowRun(run: SpawnedAgent): boolean {
  return run.kind === 'workflow' || run.runContext?.runType === 'workflow';
}

function workflowStepsForDisplay(run: SpawnedAgent): NonNullable<SpawnedAgent['runContext']>['workflowSteps'] {
  const steps = run.runContext?.workflowSteps ?? [];
  const status = String(run.runContext?.status ?? run.status ?? '').toLowerCase();
  if (status !== 'completed' && status !== 'merged') return steps;

  return steps.map(step => {
    const stepStatus = String(step.status ?? '').toLowerCase();
    const hasRunData = (step.attempts ?? 0) > 0
      || Boolean(step.startedAt || step.completedAt || step.durationMs || step.io?.input || step.io?.output);
    if (['pending', 'not_started', 'queued'].includes(stepStatus) && !hasRunData) {
      return { ...step, status: 'skipped' };
    }
    return step;
  });
}

function workflowRunProgress(run: SpawnedAgent): { current: number; total: number; label: string } {
  const context = run.runContext;
  const steps = workflowStepsForDisplay(run);
  const status = String(context?.status ?? run.status ?? '').toLowerCase();
  const total = Math.max(context?.progress.total ?? 0, steps.length);
  const completed = steps.filter(step => ['completed', 'skipped'].includes(String(step.status).toLowerCase())).length;
  const activeIndex = steps.reduce((highest, step, index) => {
    const stepStatus = String(step.status).toLowerCase();
    return stepStatus !== 'pending' && stepStatus !== 'queued' ? Math.max(highest, index) : highest;
  }, -1);
  const current = status === 'completed'
    ? total
    : Math.min(total, Math.max(context?.progress.completed ?? 0, completed, activeIndex + 1));

  if (status === 'waiting_for_input' || status === 'waiting' || context?.humanInput.required) {
    return { current, total, label: 'waiting for you' };
  }
  if (status === 'completed') return { current, total, label: 'completed' };
  if (status === 'failed') return { current, total, label: 'failed' };
  if (isCancelledExecutionStatus(status)) return { current, total, label: 'cancelled' };
  if (status === 'queued' || status === 'pending') return { current, total, label: 'queued' };
  return { current, total, label: 'running' };
}

function workflowStepPresentation(step: NonNullable<SpawnedAgent['runContext']>['workflowSteps'][number]): {
  glyph: string;
  tone: string;
  meta: string;
} {
  const status = String(step.status ?? 'pending').toLowerCase();
  const duration = formatDuration(step.durationMs);
  if (status === 'completed') {
    return { glyph: '✓', tone: 'complete', meta: duration === '—' ? '' : duration };
  }
  if (status === 'skipped') {
    return { glyph: '↷', tone: 'skipped', meta: 'skipped' };
  }
  if (status === 'waiting_for_input' || status === 'waiting') {
    return { glyph: '?', tone: 'waiting', meta: 'waiting' };
  }
  if (status === 'running') {
    return { glyph: '•', tone: 'running', meta: duration === '—' ? 'running' : duration };
  }
  if (status === 'failed' || isCancelledExecutionStatus(status)) {
    return { glyph: '×', tone: 'failed', meta: status === 'failed' ? 'failed' : 'cancelled' };
  }
  return { glyph: '○', tone: 'pending', meta: '' };
}

function WorkflowRunCard({
  run,
  headerAction,
  footer,
}: {
  run: SpawnedAgent;
  headerAction?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const context = run.runContext;
  const status = context?.status ?? run.status;
  const isActive = !TERMINAL_RUN_STATUSES.has(status);
  const [open, setOpen] = useState(isActive);
  const workflowName = context?.execution.workflowName || context?.title || run.agent;
  const progress = workflowRunProgress(run);
  const steps = workflowStepsForDisplay(run);
  const executionPath = `/executions/${run.executionId}`;
  const isDesktopRuntime = typeof window !== 'undefined' && Boolean(window.allenDesktop);

  return (
    <details
      className={`chat-workflow-run ${progress.label.replace(/\s+/g, '-')}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="chat-workflow-summary">
        <span className="chat-workflow-icon" aria-hidden="true"><Workflow /></span>
        <span className="chat-workflow-name">{workflowName}</span>
        <span className="chat-workflow-progress">
          {progress.total > 0 ? `${progress.current}/${progress.total} · ` : ''}{progress.label}
        </span>
        <ChevronRight className="chat-workflow-chevron" aria-hidden="true" />
      </summary>
      <div className="chat-workflow-expanded">
        {steps.length > 0 ? (
          <div className="chat-workflow-steps">
            {steps.map(step => {
              const presentation = workflowStepPresentation(step);
              return (
                <div className="chat-workflow-step" key={`${run.executionId}-${step.id}`}>
                  <span className={`chat-workflow-step-glyph ${presentation.tone}`} aria-hidden="true">
                    {presentation.glyph}
                  </span>
                  <span className="chat-workflow-step-name">{step.name}</span>
                  {presentation.meta && <span className="chat-workflow-step-meta">{presentation.meta}</span>}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="chat-workflow-empty">Workflow details are loading…</div>
        )}
        {headerAction && <div className="chat-workflow-action">{headerAction}</div>}
        <div className="chat-workflow-footer">
          {isDesktopRuntime ? (
            <Link to={executionPath}>Open execution →</Link>
          ) : (
            <a href={executionPath} target="_blank" rel="noopener noreferrer">Open execution →</a>
          )}
        </div>
        {footer}
      </div>
    </details>
  );
}

function ChatExecutionRunList({
  runs,
  renderExecutionHeaderAction,
  renderExecutionFooter,
}: {
  runs: SpawnedAgent[];
  renderExecutionHeaderAction?: (run: SpawnedAgent) => React.ReactNode;
  renderExecutionFooter?: (run: SpawnedAgent) => React.ReactNode;
}) {
  const workflowRuns = runs.filter(isWorkflowRun);
  const otherRuns = runs.filter(run => !isWorkflowRun(run));
  return (
    <>
      {workflowRuns.map(run => (
        <WorkflowRunCard
          key={run.executionId}
          run={run}
          headerAction={renderExecutionHeaderAction?.(run)}
          footer={renderExecutionFooter?.(run)}
        />
      ))}
      {otherRuns.length > 0 && (
        <React.Suspense fallback={<div className="run-progress-loading">Loading execution details...</div>}>
          <ChatExecutionsPanel
            runs={otherRuns}
            renderExecutionHeaderAction={renderExecutionHeaderAction}
            renderExecutionFooter={renderExecutionFooter}
          />
        </React.Suspense>
      )}
    </>
  );
}

function RunProgressFeed({
  runs,
  renderExecutionHeaderAction,
}: {
  runs: SpawnedAgent[];
  renderExecutionHeaderAction?: (run: SpawnedAgent) => React.ReactNode;
}) {
  const [olderActivityCounts, setOlderActivityCounts] = useState<Record<string, number>>({});
  const activeRuns = runs.filter(run => !TERMINAL_RUN_STATUSES.has(run.runContext?.status ?? run.status));
  if (activeRuns.length === 0) return null;

  const heading = activeRuns.length === 1 ? 'Execution running' : `${activeRuns.length} executions running`;

  const renderExecutionLogs = (run: SpawnedAgent) => {
    const archivedRows = archivedActivityRowsForRun(run, olderActivityCounts[run.executionId] ?? 0);
    const logRows = [...archivedRows, ...activityRowsForRun(run)].slice(-Math.max(12, 12 + (olderActivityCounts[run.executionId] ?? 0)));
    const loadOlder = () => {
      setOlderActivityCounts(prev => ({
        ...prev,
        [run.executionId]: Math.min((prev[run.executionId] ?? 0) + 50, 5000),
      }));
    };
    return (
      <details className="run-progress-logs">
        <summary>
          <ChevronRight className="cr-disclosure-icon h-3.5 w-3.5" />
          <span>Logs</span>
          <em>{logRows.length} event{logRows.length === 1 ? '' : 's'}</em>
        </summary>
        <div
          className="run-progress-log-list"
          onScroll={(event) => {
            if ((event.currentTarget as HTMLDivElement).scrollTop <= 4) loadOlder();
          }}
        >
          {archivedRows.length > 0 && (
            <button type="button" className="run-progress-row" onClick={loadOlder}>
              <span className="run-progress-time">older</span>
              <span className="run-progress-text">Load earlier activity</span>
            </button>
          )}
          {logRows.length > 0 ? logRows.map(row => (
            <div key={row.key} className="run-progress-row">
              <span className="run-progress-time">{formatTime(typeof row.at === 'string' ? row.at : new Date(row.at).toISOString())}</span>
              <span className="run-progress-text">{row.text}</span>
            </div>
          )) : (
            <div className="run-progress-empty">No logs captured yet.</div>
          )}
        </div>
      </details>
    );
  };

  return (
    <section className="run-progress-feed" aria-label={heading}>
      <ChatExecutionRunList
        runs={activeRuns}
        renderExecutionHeaderAction={renderExecutionHeaderAction}
        renderExecutionFooter={renderExecutionLogs}
      />
    </section>
  );
}

function workflowInterventionFromRuns(runs: SpawnedAgent[]): { run: SpawnedAgent; intervention: WorkflowIntervention } | null {
  for (const run of runs) {
    const context = run.runContext;
    const status = (context?.status ?? run.status ?? '').toLowerCase();
    if (!context?.humanInput?.required && status !== 'waiting_for_input' && status !== 'waiting') continue;
    if (!context) continue;
    const interventions = (context.interventions ?? []) as WorkflowIntervention[];
    const pending =
      interventions.find(item => item.status === 'pending' && item.intervention_id === context.humanInput.interventionId)
      ?? interventions.find(item => item.status === 'pending');
    if (pending?.intervention_id) return { run, intervention: pending };
    if (context.humanInput.interventionId) {
      return {
        run,
        intervention: {
          intervention_id: context.humanInput.interventionId,
          status: 'pending',
          stage: context.humanInput.stage,
          severity: context.humanInput.severity,
          title: context.humanInput.title ?? 'Workflow input needed',
        },
      };
    }
    const stage = context.humanInput.stage
      ?? context.progress.currentStep
      ?? context.execution.currentNodes?.[0]
      ?? undefined;
    if (stage && looksLikeApprovalInput(stage, context.humanInput.severity)) {
      return {
        run,
        intervention: {
          status: 'pending',
          stage,
          severity: context.humanInput.severity ?? (stage.toLowerCase().includes('escalation') ? 'escalation' : 'approval'),
          title: context.humanInput.title ?? 'Approval required',
          question: `Review the pause at ${humanLabel(stage)} and choose how the workflow should continue.`,
        },
      };
    }
  }
  return null;
}

function looksLikeApprovalInput(stage?: string | null, severity?: string | null): boolean {
  const lower = `${stage ?? ''} ${severity ?? ''}`.toLowerCase();
  return lower.includes('approval') || lower.includes('escalation') || lower.includes('_gate') || lower.endsWith(' gate');
}

function WorkflowInterventionPrompt({
  run,
  intervention,
  onAnswer,
}: {
  run: SpawnedAgent;
  intervention: WorkflowIntervention;
  onAnswer: (input: WorkflowInterventionAnswer) => Promise<void> | void;
}) {
  return (
    <div className="cr-approval-footer">
      <WorkflowInterventionAction
        run={run}
        intervention={intervention}
        onAnswer={onAnswer}
        showTitleMeta
      />
    </div>
  );
}

export default function ChatMessageList({ messages, streamText, thinkingText, streaming, activeToolCalls = [], agentReports = [], pendingUserQuestion, onAnswerUserQuestion, activeAgent, spawnedAgents = [], onAnswerWorkflowIntervention, onSaveToLearnings, onOpenExecutionsPanel, onOpenFilesPanel, watchers = [], conversationTitle, conversationTag, conversationWorkflow, documentCount = 0, provider, model, onOpenFileReference, onOpenChatReference, onOpenInternalReference, resourceScopeKey }: ChatMessageListProps) {
  const [agentMap, setAgentMap] = useState<Record<string, { displayName?: string; icon?: string; color?: string }>>({});
  const pendingWorkflowIntervention = onAnswerWorkflowIntervention ? workflowInterventionFromRuns(spawnedAgents) : null;
  const hasActiveSpawnedRuns = spawnedAgents.some(run => !TERMINAL_RUN_STATUSES.has(run.runContext?.status ?? run.status));
  const runsBySourceMessage = useMemo(() => {
    const byMessage = new Map<string, SpawnedAgent[]>();
    for (const run of spawnedAgents) {
      if (!run.sourceMessageId) continue;
      const current = byMessage.get(run.sourceMessageId) ?? [];
      current.push(run);
      byMessage.set(run.sourceMessageId, current);
    }
    return byMessage;
  }, [spawnedAgents]);
  const forwardedDiffRunsByMessage = useMemo(() => {
    const byMessage = new Map<string, SpawnedAgent[]>();
    let pendingRuns: SpawnedAgent[] = [];
    const appendRuns = (runs: SpawnedAgent[]) => {
      for (const run of runs) {
        if (!pendingRuns.some(existing => existing.executionId === run.executionId)) {
          pendingRuns.push(run);
        }
      }
    };

    for (const message of messages) {
      const ownRuns = message._id ? runsBySourceMessage.get(message._id) ?? [] : [];
      if (ownRuns.length > 0) {
        appendRuns(ownRuns);
      }

      const hasVisibleAssistantResponse = message.role === 'assistant' && Boolean(message.content || message.error);
      if (hasVisibleAssistantResponse) {
        if (message._id && ownRuns.length === 0 && pendingRuns.length > 0) {
          byMessage.set(message._id, pendingRuns);
        }
        pendingRuns = [];
      }
    }

    return byMessage;
  }, [messages, runsBySourceMessage]);
  const visibleMessages = useMemo(
    () => messages.filter(m => !(m as any).hidden),
    [messages],
  );
  const chatTimeline = useMemo(
    () => buildChatTimeline(visibleMessages),
    [visibleMessages],
  );

  // Load agent info for labels, avatars, and thread display
  useEffect(() => {
    agentsApi.list().then(all => {
      const map: Record<string, { displayName?: string; icon?: string; color?: string }> = {};
      for (const a of all) map[a.name] = { displayName: a.displayName, icon: a.icon, color: a.color };
      setAgentMap(map);
    }).catch(() => {});
  }, []);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const initialHistoryRef = useRef(true);
  const sessionRef = useRef<string | undefined>(messages[0]?.sessionId);
  const scrollToBottomIfPinned = useCallback(() => {
    if (autoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: streaming ? 'smooth' : 'instant' });
    }
  }, [streaming]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 100;
    };
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    const sessionId = messages[0]?.sessionId;
    if (sessionRef.current !== sessionId) {
      sessionRef.current = sessionId;
      initialHistoryRef.current = true;
    }
    if (initialHistoryRef.current && messages.length > 0 && !streaming) {
      if (containerRef.current) containerRef.current.scrollTop = 0;
      autoScrollRef.current = false;
      initialHistoryRef.current = false;
      return;
    }
    if (streaming) autoScrollRef.current = true;
    if (autoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: streaming ? 'smooth' : 'instant' });
    }
  }, [messages, streamText, pendingWorkflowIntervention?.intervention.intervention_id, streaming]);

  const renderWorkflowInterventionHeaderAction = (run: SpawnedAgent) => {
    if (!pendingWorkflowIntervention || !onAnswerWorkflowIntervention) return null;
    if (run.executionId !== pendingWorkflowIntervention.run.executionId) return null;
    return (
      <WorkflowInterventionPrompt
        run={pendingWorkflowIntervention.run}
        intervention={pendingWorkflowIntervention.intervention}
        onAnswer={onAnswerWorkflowIntervention}
      />
    );
  };

  return (
    <MarkdownResourceContext.Provider value={{ onOpenFileReference, onOpenChatReference, onOpenInternalReference, resourceScopeKey }}>
    <div ref={containerRef} className="chat-stream-v2">
      {conversationTitle && (
        <div className="v8-chat-conversation-head">
          <span className="v8-chat-detail-live" aria-label="Conversation active" />
          <h1>{conversationTitle}</h1>
          {conversationTag && <span className="v8-chat-head-tag">{conversationTag}</span>}
          {conversationWorkflow && <span className="v8-chat-head-meta">{conversationWorkflow}</span>}
          {documentCount > 0 && <span className="v8-chat-head-meta">{documentCount} docs</span>}
        </div>
      )}
      {messages.length === 0 && !streaming && (
        <div className="chat-empty-stream" />
      )}

      {/* Messages */}
      {chatTimeline.map((item) => {
        const msg = item.message;
        const i = item.index;
        // `/skill <name>` loads render as a compact slice, not a text bubble.
        if (msg.role === 'user' && msg.skillLoad) {
          return (
            <div key={item.key} className="ch-msg you al-msg-enter">
              <div className="ch-avatar">{senderInitial(userDisplayName(msg))}</div>
              <div className="ch-msg-body">
                <div className="ch-msg-head">
                  <span className="ch-msg-who">{userDisplayName(msg)}</span>
                  <span className="ch-msg-ts" title={formatTimestampTitle(msg.createdAt)}>
                    {formatTime(msg.createdAt)}
                  </span>
                </div>
                <SkillLoadSlice skillLoad={msg.skillLoad} />
              </div>
            </div>
          );
        }
        const showThinking = msg.role === 'assistant' && Boolean(msg.thinkingText);
        const senderLabel = msg.role === 'user' ? userDisplayName(msg) : '';
        const visibleContent = msg.role === 'assistant' ? sanitizeChatAssistantResponse(msg.content) : msg.content;
        const visibleError = msg.role === 'assistant' ? sanitizeChatAssistantResponse(msg.error) : msg.error;
        const diffSplit = msg.role === 'assistant' ? splitFirstDiffFence(visibleContent) : { text: visibleContent, diff: null };
        const messageRuns = msg.role === 'assistant' && msg._id
          ? runsBySourceMessage.get(msg._id) ?? []
          : [];
        const diffPreviewRuns = msg.role === 'assistant' && msg._id
          ? messageRuns.length > 0
            ? messageRuns
            : forwardedDiffRunsByMessage.get(msg._id) ?? []
          : [];
        const messageHasActiveRuns = messageRuns.some(run => !TERMINAL_RUN_STATUSES.has(run.runContext?.status ?? run.status));
        const hasAssistantMetrics = msg.role !== 'user'
          && ((msg.costUsd != null && msg.costUsd > 0) || Boolean(msg.tokenUsage));
        return (<React.Fragment key={item.key}>
        <div className={`ch-msg ${msg.role === 'user' ? 'you' : 'allen'} group/msg al-msg-enter`}>
          <div className="ch-avatar">{msg.role === 'user' ? senderInitial(senderLabel) : 'a'}</div>
          <div className="ch-msg-body">
            <div className="ch-msg-head">
              <span className="ch-msg-who">
                {msg.role === 'user' ? senderLabel : assistantDisplayName(activeAgent ? agentMap[activeAgent] : undefined)}
              </span>
              {msg.role !== 'user' && provider && <span className={`ch-provider-mark ${provider.includes('claude') ? 'claude' : 'codex'}`} aria-hidden="true">◆</span>}
              {msg.role !== 'user' && model && <span className="ch-msg-model">{getModelDisplay(provider ?? '', model).modelLabel}</span>}
              <span className="ch-msg-ts" title={formatTimestampTitle(msg.createdAt)}>
                {formatTime(msg.createdAt)}
              </span>
              {msg.role !== 'user' && msg.durationMs != null && msg.durationMs > 0 && (
                <span className="ch-msg-ts">{formatDuration(msg.durationMs)}</span>
              )}
            </div>
            {hasAssistantMetrics && (
              <div className="ch-msg-meta-line">
                {msg.costUsd != null && msg.costUsd > 0 && <span className="ch-msg-ts">${msg.costUsd.toFixed(4)}</span>}
                {msg.tokenUsage && <TokenUsageDisplay tokenUsage={msg.tokenUsage} />}
              </div>
            )}

            <div className={`ch-msg-text ${msg.status === 'failed' || msg.status === 'interrupted' || msg.status === 'cancelled' ? 'failed' : ''}`}>
              {showThinking && (
                <ThinkingBlock text={msg.thinkingText ?? ''} durationMs={msg.durationMs} />
              )}
              {diffSplit.text && (msg.role === 'user' ? (() => {
                const slash = splitLeadingSlashCommand(diffSplit.text);
                if (!slash.command) return <div>{renderMarkdown(diffSplit.text)}</div>;
                return (
                  <div>
                    <span style={{ backgroundColor: 'rgb(var(--color-accent) / 0.18)', color: 'rgb(var(--color-accent))', borderRadius: '4px' }}>
                      {slash.command}
                    </span>
                    {slash.rest && <> {renderMarkdown(slash.rest)}</>}
                  </div>
                );
              })() : (
                <div>
                  {renderMarkdown(diffSplit.text)}
                </div>
              ))}
              {msg.role === 'assistant' && !messageHasActiveRuns && (
                <ToolCallsSection calls={msg.toolCalls} />
              )}
              {visibleError && (
                <div className="chat-msg-error">
                  <AlertCircle className="w-3 h-3 shrink-0" />
                  {visibleError}
                </div>
              )}
            </div>
            {(visibleContent || visibleError) && (
              <div className="chat-save-row">
                <MessageCopyButton text={visibleContent || visibleError || ''} />
                {msg.role !== 'user' && visibleContent && onSaveToLearnings && (
                  <button
                    onClick={() => onSaveToLearnings(visibleContent)}
                    title="Save to learnings"
                    aria-label="Save to learnings"
                  >
                    <Bookmark className="w-3 h-3" />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {diffSplit.diff && (
          <div className="ch-msg allen al-msg-enter">
            <div className="ch-avatar">a</div>
            <div className="ch-msg-body">
              <InlineCodeDiffCard code={diffSplit.diff} />
            </div>
          </div>
        )}

        {messageRuns.length > 0 && !messageHasActiveRuns && (
          <section className="run-progress-feed" aria-label={`${messageRuns.length} linked execution${messageRuns.length === 1 ? '' : 's'}`}>
            <ChatExecutionRunList
              runs={messageRuns}
              renderExecutionHeaderAction={renderWorkflowInterventionHeaderAction}
            />
          </section>
        )}

        {diffPreviewRuns.length > 0 && (
          <ChatCodeDiffPreview
            runs={diffPreviewRuns}
            sessionId={msg.sessionId}
            messageId={msg._id}
            onReady={scrollToBottomIfPinned}
            onOpenAllFiles={onOpenFilesPanel}
          />
        )}

        </React.Fragment>);
      })}

      {/* Watcher status lines — above streaming indicator, near the message area bottom */}
      {watchers.length > 0 && (
        <WatcherStatusLines watchers={watchers} assistantStreaming={streaming} />
      )}

      {/* Streaming message */}
      {streaming && (!hasActiveSpawnedRuns || Boolean(streamText) || Boolean(thinkingText) || activeToolCalls.length > 0) && (() => {
        const sAgentInfo = activeAgent ? agentMap[activeAgent] : undefined;
        return (
          <div className="ch-msg allen al-msg-enter">
            <div className="ch-avatar">a</div>
            <div className="ch-msg-body">
              <div className="ch-msg-head">
                <span className="ch-msg-who">{assistantDisplayName(sAgentInfo)}</span>
                <span className="ch-msg-ts">generating</span>
              </div>
              <div className="ch-msg-text">
              {thinkingText && <ThinkingBlock text={thinkingText} active />}
              <ActiveToolCallsSection calls={activeToolCalls} />
              <div className={activeToolCalls.length > 0 || thinkingText ? 'mt-2' : undefined}>
                {streamText ? (
                  <>
                    {renderMarkdown(sanitizeChatAssistantResponse(streamText))}
                    <span className="inline-block w-0.5 h-4 bg-accent-blue/70 ml-0.5 animate-pulse align-middle" />
                  </>
                ) : thinkingText ? (
                  <span className="text-accent-purple/60 text-xs font-mono flex items-center gap-1.5">
                    <Brain className="w-3 h-3 animate-pulse" />
                    Processing...
                  </span>
                ) : (
                  <TypingDots />
                )}
              </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Agent progress reports */}
      {agentReports.length > 0 && !hasActiveSpawnedRuns && (
        <div className="chat-progress-mini">
          {agentReports.map((report, i) => {
            const reportAgent = agentMap[report.agent];
            return (
              <div key={i} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-accent-cyan/5 border border-accent-cyan/10">
                {reportAgent && (
                  <div className="w-4 h-4 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: (reportAgent.color ?? '#06b6d4') + '15' }}>
                    <RoleIcon icon={reportAgent.icon} color={reportAgent.color} size={9} />
                  </div>
                )}
                <span className="text-[11px] font-mono text-accent-cyan shrink-0">{reportAgent?.displayName ?? report.agent}</span>
                <span className="text-[11px] text-theme-secondary font-body">{report.message}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Agent question prompt (ask_user) */}
      {pendingUserQuestion && onAnswerUserQuestion && (
        <AgentQuestionPrompt
          question={pendingUserQuestion.question}
          fromAgent={pendingUserQuestion.fromAgent}
          agentInfo={agentMap[pendingUserQuestion.fromAgent]}
          onAnswer={onAnswerUserQuestion}
        />
      )}

      {/* Routed workflow/agent executions — only live progress belongs in chat; completed steps live in the sidebar. */}
      {spawnedAgents.some(run => !TERMINAL_RUN_STATUSES.has(run.runContext?.status ?? run.status)) && (
        <div className="chat-run-feed-wrap">
          <RunProgressFeed runs={spawnedAgents} renderExecutionHeaderAction={renderWorkflowInterventionHeaderAction} />
        </div>
      )}

      <div ref={bottomRef} />
    </div>
    </MarkdownResourceContext.Provider>
  );
}

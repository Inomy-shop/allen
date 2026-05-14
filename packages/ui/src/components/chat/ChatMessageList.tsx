import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, AlertCircle, AlertTriangle, Copy, Check, Clock, Wrench, CheckCircle, ExternalLink, Loader2, Brain,
  Sparkles, Zap, Cpu, Atom, Terminal, Code, Rocket, Shield, Hexagon, Flame,
  ChevronDown, ChevronRight, GitPullRequest, FolderGit2, FileText, PlayCircle, StopCircle, Timer,
  Send, Bookmark, Download, X,
} from 'lucide-react';
import type { ChatMessage, ToolCallRecord, ActiveToolCall, AgentThread as AgentThreadType, AgentReport, SpawnedAgent, WorkflowInterventionAnswer } from '../../hooks/useChat';
import { AgentThread } from './AgentThread';
import { AgentQuestionPrompt } from './AgentQuestionPrompt';
import RoleIcon from '../common/RoleIcon';
import MermaidChatBlock from './MermaidChatBlock';
import { agents as agentsApi, artifacts as artifactsApi, type ArtifactDoc } from '../../services/api';
import { workspaces as workspacesApi } from '../../services/workspaceService';

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
  agentThreads?: AgentThreadType[];
  agentReports?: AgentReport[];
  /** Persisted threads keyed by parentMessageId — loaded from DB for historical viewing */
  threadsByMessage?: Record<string, AgentThreadType[]>;
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
}

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

type WorkflowInterventionOption = { label?: string; value: string; primary?: boolean; destructive?: boolean };

type ChatDiffFile = {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
  diff?: string;
  modifiedContent?: string;
  workspaceName?: string | null;
  key?: string;
};

type ChatDiffBundle = {
  workspaceId: string;
  workspaceName?: string | null;
  files: ChatDiffFile[];
};

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
  const [expanded, setExpanded] = useState(Boolean(active));
  const label = active ? 'Thinking' : durationMs ? `Worked for ${formatDuration(durationMs)}` : 'Thinking';

  return (
    <div className="mb-5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="group flex w-full items-center gap-2 border-b border-app pb-2 text-left text-sm text-theme-subtle transition-colors hover:text-theme-secondary"
        title={expanded ? 'Collapse thinking' : 'Expand thinking'}
      >
        <span>{label}</span>
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-theme-subtle transition-colors group-hover:text-theme-secondary" />
        ) : (
          <ChevronRight className="h-4 w-4 text-theme-subtle transition-colors group-hover:text-theme-secondary" />
        )}
      </button>
      {expanded && (
        <div className="mt-4">
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
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
  return file.diff?.trim() || file.modifiedContent?.trim() || 'No diff available.';
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
      {rows.map(({ line, kind, lineNumber }, index) => {
        return (
          <div key={`${index}-${line}`} className={`chat-diff-line ${kind}`}>
            <span className="ln">{lineNumber}</span>
            <code>{line || ' '}</code>
          </div>
        );
      })}
    </div>
  );
}

function ChatCodeDiffCard({
  files,
  title,
  state,
}: {
  files: ChatDiffFile[];
  title: string;
  state?: React.ReactNode;
}) {
  const normalized = files.map((file, index) => ({
    ...file,
    key: file.key ?? `${file.workspaceName ?? 'diff'}:${file.path}:${index}`,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    status: file.status ?? ((file as ChatDiffFile & { isNew?: boolean }).isNew ? 'added' : 'modified'),
  }));
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
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

  if (normalized.length === 0) return null;

  return (
    <div className="ch-card code-card">
      <div className="ch-card-h">
        <span className="cc-tag impl">code diff</span>
        <span className="cc-title">{title}</span>
        <span className="cc-pct">
          <span className="cf-p">+{totalAdditions}</span>
          <span className="cf-m">-{totalDeletions}</span>
          {state && <span className="chat-diff-status">{state}</span>}
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
                  <span className="cf-n">{file.path}</span>
                  {(file.status === 'added' || file.status === 'untracked') && <span className="cf-new">new</span>}
                  {file.workspaceName && <span className="cf-ws">{file.workspaceName}</span>}
                  <span className="cf-p">+{file.additions ?? 0}</span>
                  <span className="cf-m">-{file.deletions ?? 0}</span>
                </button>
                {expanded && (
                  <div className="cc-file-diff">
                    <DiffCodeView text={diffText(file)} />
                  </div>
                )}
              </div>
            );
          })}
          <div className="cc-file muted">
            <span className="cf-n">{normalized.length} file{normalized.length === 1 ? '' : 's'} · {totalAdditions} additions / {totalDeletions} deletions</span>
          </div>
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

function ArtifactMarkdownLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  const artifactId = artifactIdFromUrl(href);
  const [artifact, setArtifact] = useState<ArtifactDoc | null>(null);
  const [content, setContent] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!artifactId) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {children}
      </a>
    );
  }
  const resolvedArtifactId = artifactId;

  async function openArtifact() {
    setOpen(true);
    if (artifact && content) return;
    setLoading(true);
    setError(null);
    try {
      const doc = await artifactsApi.get(resolvedArtifactId);
      setArtifact(doc);
      if (doc.contentType === 'binary') {
        setContent('');
      } else {
        const response = await fetch(artifactsApi.contentUrl(resolvedArtifactId));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setContent(await response.text());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load artifact');
    } finally {
      setLoading(false);
    }
  }

  async function copyContent() {
    if (!content) return;
    await navigator.clipboard.writeText(content).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  const downloadUrl = artifactsApi.contentUrl(resolvedArtifactId);
  const filename = artifact?.filename ?? 'artifact.md';
  const title = artifact?.relativePath ?? filename;

  return (
    <>
      <button
        type="button"
        onClick={openArtifact}
        className={`inline border-0 bg-transparent p-0 text-left align-baseline font-inherit ${className ?? ''}`}
      >
        {children}
      </button>
      {open && createPortal(
        <div className="artifact-modal-backdrop" role="dialog" aria-modal="true" aria-label="Artifact viewer">
          <div className="artifact-modal">
            <div className="flex h-full flex-col">
              <div className="shrink-0 border-b border-app bg-app-muted/40 px-4 py-2.5">
                <div className="flex items-center gap-2.5">
                  <FileText className="h-4 w-4 shrink-0 text-accent-blue" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[13px] text-theme-primary">{title}</div>
                    <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-theme-subtle">
                      <span>{artifact?.contentType ?? 'artifact'}</span>
                      {artifact?.sizeBytes != null && <span>{artifact.sizeBytes.toLocaleString()} bytes</span>}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={copyContent}
                    disabled={!content}
                    className="rounded-md p-1.5 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-secondary disabled:opacity-30"
                    title="Copy content"
                  >
                    {copied ? <Check className="h-3.5 w-3.5 text-accent-green" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                  <a
                    href={downloadUrl}
                    download={filename}
                    className="rounded-md p-1.5 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-secondary"
                    title="Download"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </a>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="rounded-md p-1.5 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-secondary"
                    title="Close viewer"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-4">
                {loading && <div className="font-mono text-xs text-theme-muted">Loading artifact...</div>}
                {error && <div className="font-mono text-xs text-accent-red">Failed to load artifact: {error}</div>}
                {!loading && !error && artifact?.contentType === 'markdown' && (
                  <div className="prose prose-sm prose-invert max-w-none">{renderMarkdown(content)}</div>
                )}
                {!loading && !error && artifact?.contentType !== 'markdown' && artifact?.contentType !== 'binary' && (
                  <pre className="whitespace-pre-wrap break-words rounded-md border border-app bg-app-muted/50 p-3 font-mono text-[12px] leading-relaxed text-theme-primary">{content}</pre>
                )}
                {!loading && !error && artifact?.contentType === 'binary' && (
                  <div className="rounded-md border border-app bg-app-muted/40 p-4 text-sm text-theme-muted">
                    Binary artifact. Use the download button to save it.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
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
      parts.push(
        <code key={k++} className="px-1.5 py-0.5 bg-surface-200/80 border border-app rounded text-[12px] font-mono text-accent-blue/90">
          {m[1].slice(1, -1)}
        </code>,
      );
    } else if (m[2]) {
      // bold **text**
      parts.push(
        <strong key={k++} className="text-theme-primary font-semibold">
          {m[2].slice(2, -2)}
        </strong>,
      );
    } else if (m[3]) {
      // italic *text*
      parts.push(
        <em key={k++} className="text-theme-secondary italic">
          {m[3].slice(1, -1)}
        </em>,
      );
    } else if (m[4]) {
      // italic _text_
      parts.push(
        <em key={k++} className="text-theme-secondary italic">
          {m[4].slice(1, -1)}
        </em>,
      );
    } else if (m[5]) {
      // strikethrough ~~text~~
      parts.push(
        <del key={k++} className="text-theme-muted line-through">
          {m[5].slice(2, -2)}
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
  // Phase 3-4: Core
  run_workflow: { label: 'Run Workflow', color: 'text-accent-green' },
  list_workflows: { label: 'List Workflows', color: 'text-accent-blue' },
  wait_for_execution: { label: 'Wait for Execution', color: 'text-accent-blue' },
  list_executions: { label: 'List Executions', color: 'text-accent-blue' },
  cancel_execution: { label: 'Cancel Execution', color: 'text-accent-red' },
  list_repos: { label: 'List Repos', color: 'text-accent-blue' },
  list_agents: { label: 'List Agents', color: 'text-accent-purple' },
  get_agent: { label: 'Get Agent', color: 'text-accent-purple' },
  spawn_agent: { label: 'Spawn Agent', color: 'text-accent-purple' },
  move_agent_to_team: { label: 'Move Agent', color: 'text-accent-purple' },
  delegate_to_agent: { label: 'Delegate', color: 'text-accent-cyan' },
  wait_for_delegation: { label: 'Wait for Delegation', color: 'text-accent-cyan' },
  answer_delegator: { label: 'Answer Delegator', color: 'text-accent-cyan' },
  ask_delegator: { label: 'Ask Delegator', color: 'text-accent-cyan' },
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
  return TOOL_LABELS[base]?.label
    ?? TOOL_LABELS[tool]?.label
    ?? base
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, ch => ch.toUpperCase());
}

function toolColor(tool: string): string {
  const base = toolBaseName(tool);
  return TOOL_LABELS[base]?.color ?? TOOL_LABELS[tool]?.color ?? 'text-theme-secondary';
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
  const preferred = ['message', 'summary', 'status', 'title', 'name', 'execution_id', 'conversation_id'];
  for (const key of preferred) {
    if (result[key] !== undefined) return `${key.replace(/_/g, ' ')}: ${compactValue(result[key])}`;
  }
  const entries = Object.entries(result);
  if (entries.length === 0) return 'No output';
  return entries.slice(0, 2).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${compactValue(v)}`).join(' · ');
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function ToolCallCard({ call, active }: { call: ToolCallRecord | ActiveToolCall; active?: boolean }) {
  const isRunning = active && (call as ActiveToolCall).status === 'running';
  const [expanded, setExpanded] = useState(false);
  const label = humanizeToolName(call.tool);
  const color = toolColor(call.tool);
  const result = 'result' in call ? call.result : undefined;
  const duration = 'durationMs' in call ? call.durationMs : undefined;
  const hasArgs = call.args && Object.keys(call.args).length > 0;
  const inputSummary = argsSummary(call.args);
  const outputSummary = resultSummary(result);
  const providerPrefix = call.tool.includes('__') ? call.tool.split('__').slice(0, -1).join(' / ').replace(/^mcp \/ /, '') : '';

  // Check if result has an execution_id (for link to execution page)
  const executionId = result?.execution_id as string | undefined;

  return (
    <div className="relative">
      <button
        onClick={() => setExpanded(!expanded)}
        className="group/tool grid w-full grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2 rounded-sm px-1 py-1.5 text-left transition-colors hover:bg-app-muted/35"
        title={expanded ? 'Collapse tool result' : 'Expand tool result'}
      >
        {isRunning ? (
          <Loader2 className={`h-3.5 w-3.5 ${color} animate-spin`} />
        ) : result?.error ? (
          <AlertCircle className="h-3.5 w-3.5 text-accent-red" />
        ) : (
          <CheckCircle className="h-3.5 w-3.5 text-accent-green/70" />
        )}
        <Wrench className={`h-3 w-3 ${color}`} />
        <span className="min-w-0">
          <span className={`block text-[12px] font-medium leading-4 ${color}`}>{label}</span>
          <span className="block truncate text-[11px] leading-4 text-theme-subtle">
            {inputSummary || outputSummary || (isRunning ? 'Running...' : providerPrefix || call.tool)}
          </span>
        </span>

        <span className="flex items-center gap-2 justify-end">
          {providerPrefix && <span className="hidden sm:inline text-[10px] text-theme-subtle">{providerPrefix}</span>}
          {duration != null && (
            <span className="text-[10px] text-theme-subtle font-mono">{formatDuration(duration)}</span>
          )}
          {executionId && (
            <a
              href={`/executions/${executionId}`}
              onClick={e => e.stopPropagation()}
              className="text-accent-blue hover:text-accent-blue/80 transition-colors"
              title="View execution"
            >
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
          {expanded ? <ChevronDown className="h-3 w-3 text-theme-subtle" /> : <ChevronRight className="h-3 w-3 text-theme-subtle" />}
        </span>
      </button>

      {expanded && (
        <div className="ml-6 mt-1 max-h-72 overflow-auto border-l border-border/10 pl-3 text-[11px] text-theme-secondary">
          {hasArgs && (
            <div className="mb-2">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-theme-subtle">Input</div>
              <pre className="whitespace-pre-wrap font-mono leading-relaxed text-theme-secondary">{prettyJson(call.args)}</pre>
            </div>
          )}
          {result && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-theme-subtle">Output</div>
              <pre className="whitespace-pre-wrap font-mono leading-relaxed text-theme-secondary">{prettyJson(result)}</pre>
            </div>
          )}
          {!hasArgs && !result && (
            <div className="text-[11px] text-theme-subtle">Waiting for tool input/output details...</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Completed message: threads shown inline, tool calls in a clean toggle.
 */
function ToolCallsSection({ calls, threads, agentMap }: { calls?: ToolCallRecord[]; threads?: AgentThreadType[]; agentMap?: Record<string, { displayName?: string; icon?: string; color?: string }> }) {
  const [showTools, setShowTools] = useState(false);
  if (!calls || calls.length === 0) return null;

  // Build thread tree from flat list, then show only root-level threads
  const rootThreads = threads ? buildThreadTree(threads) : [];

  const hasErrors = calls.some(c => (c.result as Record<string, unknown>)?.error);

  return (
    <div className="mt-3 space-y-1">
      {/* Threads — nested tree, primary content */}
      {rootThreads.map(thread => (
        <AgentThread key={thread.conversationId} thread={thread} agents={agentMap} />
      ))}

      <button onClick={() => setShowTools(!showTools)} className="flex items-center gap-1.5 py-0.5 text-[11px] text-theme-subtle transition-colors hover:text-theme-secondary">
        {showTools ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Wrench className="h-3 w-3" />
        <span>{calls.length} tool call{calls.length !== 1 ? 's' : ''}</span>
        {hasErrors && <span className="text-accent-red">· errors</span>}
      </button>
      {showTools && (
        <div className="ml-4 max-h-[400px] space-y-0.5 overflow-y-auto border-l border-border/10 py-1 pl-3">
          {calls.map((call, i) => <ToolCallCard key={`${call.toolUseId ?? call.tool}-${i}`} call={call} />)}
        </div>
      )}
    </div>
  );
}

/**
 * Streaming: threads + running indicator.
 */
function ActiveToolCallsSection({ calls, liveThreads, agentMap }: { calls: ActiveToolCall[]; liveThreads?: AgentThreadType[]; agentMap?: Record<string, { displayName?: string; icon?: string; color?: string }> }) {
  if (calls.length === 0 && (!liveThreads || liveThreads.length === 0)) return null;

  const rootThreads = buildThreadTree(liveThreads ?? []);
  const runningTool = [...calls].reverse().find(c => (c as ActiveToolCall).status === 'running');
  const completedCount = calls.filter(c => (c as ActiveToolCall).status !== 'running').length;

  return (
    <div className="mt-3 space-y-1">
      {/* Live threads */}
      {rootThreads.map(thread => (
        <AgentThread key={thread.conversationId} thread={thread} agents={agentMap} />
      ))}

      {runningTool && (
        <div className="flex items-center gap-1.5 text-[10px] font-mono text-theme-subtle py-0.5">
          <Loader2 className="w-2.5 h-2.5 text-accent-yellow animate-spin shrink-0" />
          <Wrench className="w-2.5 h-2.5 text-accent-yellow shrink-0" />
          <span className="text-accent-yellow/70">{TOOL_LABELS[runningTool.tool]?.label ?? runningTool.tool.replace('mcp__allen__', 'al:')}</span>
          {completedCount > 0 && <span className="text-theme-subtle">· {completedCount} done</span>}
        </div>
      )}
      {calls.length > 0 && (
        <div className="ml-4 max-h-[420px] space-y-0.5 overflow-y-auto border-l border-border/10 py-1 pl-3">
          {calls.map((call, i) => (
            <ToolCallCard key={`${call.toolUseId ?? call.tool}-${i}`} call={call} active />
          ))}
        </div>
      )}
    </div>
  );
}

function ChatCodeDiffPreview({ runs, onReady }: { runs: SpawnedAgent[]; onReady?: () => void }) {
  const [bundles, setBundles] = useState<ChatDiffBundle[]>([]);
  const [loading, setLoading] = useState(false);

  const workspaceRefs: Array<{ id: string; name?: string | null }> = [];
  const allTerminal = runs.length > 0 && runs.every(run => TERMINAL_RUN_STATUSES.has(run.runContext?.status ?? run.status));
  for (const run of runs) {
    const id = run.runContext?.workspace?.id;
    if (typeof id === 'string' && id.length > 0) {
      workspaceRefs.push({
        id,
        name: run.runContext?.workspace?.name ?? run.runContext?.workspace?.repoName,
      });
    }
  }
  const workspaceSignature = [...new Set(workspaceRefs.map(ref => ref.id))].join('|');

  useEffect(() => {
    if (!workspaceSignature) {
      setBundles([]);
      return;
    }
    let cancelled = false;
    const uniqueRefs = workspaceRefs.filter((ref, index, arr) => arr.findIndex(item => item.id === ref.id) === index);
    setLoading(true);
    Promise.all(uniqueRefs.map(async (ref) => {
      try {
        const result = await workspacesApi.getDiff(ref.id);
        const files = ((result.files ?? []) as ChatDiffFile[]).filter(file => file.diff?.trim() || file.modifiedContent?.trim());
        return { workspaceId: ref.id, workspaceName: ref.name, files };
      } catch {
        return { workspaceId: ref.id, workspaceName: ref.name, files: [] };
      }
    })).then(next => {
      if (cancelled) return;
      const populated = next.filter(bundle => bundle.files.length > 0);
      setBundles(populated);
      if (populated.length > 0) window.setTimeout(() => onReady?.(), 0);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [workspaceSignature, onReady]);

  if (!workspaceSignature) return null;
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
            state={allTerminal ? 'completed' : <><span className="dot pulse accent" /> live</>}
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
function buildThreadTree(threads: AgentThreadType[]): AgentThreadType[] {
  const map = new Map<string, AgentThreadType>();
  for (const t of threads) map.set(t.conversationId, { ...t, children: [] });

  const roots: AgentThreadType[] = [];
  for (const t of map.values()) {
    if (t.parentConversationId && map.has(t.parentConversationId)) {
      const parent = map.get(t.parentConversationId)!;
      if (!parent.children) parent.children = [];
      parent.children.push(t);
    } else {
      roots.push(t);
    }
  }
  return roots;
}

function statusTone(status: string): string {
  if (status === 'completed') return 'border-accent-green/35 bg-accent-green/5';
  if (status === 'failed' || status === 'cancelled') return 'border-accent-red/35 bg-accent-red/5';
  if (status === 'waiting_for_input') return 'border-accent-yellow/45 bg-accent-yellow/5';
  return 'border-accent/40 bg-accent/5';
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'completed') return <CheckCircle className="w-3.5 h-3.5 text-accent-green" />;
  if (status === 'failed' || status === 'cancelled') return <AlertCircle className="w-3.5 h-3.5 text-accent-red" />;
  if (status === 'waiting_for_input') return <AlertTriangle className="w-3.5 h-3.5 text-accent-yellow" />;
  return <Loader2 className="w-3.5 h-3.5 text-accent animate-spin" />;
}

function humanLabel(value: string): string {
  return value.replace(/_/g, ' ');
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
  if (status === 'failed' || status === 'cancelled') return 'border-accent-red/35 bg-accent-red/5';
  if (status === 'waiting_for_input') return 'border-accent-yellow/45 bg-accent-yellow/5';
  if (status === 'running') return 'border-accent/40 bg-accent/5';
  return 'border-app bg-app-card';
}

function NodeStatusIcon({ status }: { status: string }) {
  if (status === 'completed' || status === 'skipped') return <CheckCircle className="w-3.5 h-3.5 text-accent-green" />;
  if (status === 'failed' || status === 'cancelled') return <AlertCircle className="w-3.5 h-3.5 text-accent-red" />;
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
            {step.model && <span className="truncate max-w-[220px]">{String(step.model).replace(/^claude-/, '')}</span>}
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
          <a href={`/workspaces/${context.workspace.id}`} className="flex items-center gap-1.5 text-theme-muted hover:text-accent min-w-0">
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
    ?? context?.workflowSteps.find(step => step.status === 'failed' || step.status === 'cancelled')?.name
    ?? null;
  if (failedStep) return `Failed at ${humanLabel(String(failedStep))}`;
  return 'Failed';
}

function WorkflowAttemptCard({ run, index }: { run: SpawnedAgent; index: number }) {
  const context = run.runContext;
  const status = context?.status ?? run.status;
  const summary =
    status === 'failed' || status === 'cancelled' ? workflowAttemptFailureLabel(run)
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
        <RunProgressFeed runs={runs} />
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
        <RunProgressFeed runs={runs} />
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
      <RunProgressFeed runs={runs} />
    </div>
  );
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

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

function RunProgressFeed({ runs }: { runs: SpawnedAgent[] }) {
  const rows = runs
    .filter(run => !TERMINAL_RUN_STATUSES.has(run.runContext?.status ?? run.status))
    .flatMap(run => {
      const contextRows = (run.runContext?.recentActivity ?? []).slice(-6).map(item => activityLine(run, item));
      const liveRows = run.activity.slice(-6).map(item => activityLine(run, item));
      return [...contextRows, ...liveRows].filter((row): row is { key: string; text: string; at: string | number } => Boolean(row));
    })
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    .slice(-8);

  if (rows.length === 0) return null;

  const seen = new Set<string>();
  const uniqueRows = rows.filter(row => {
    const normalized = row.text.toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });

  return (
    <div className="ml-6 max-w-[760px] space-y-1.5 border-l-[3px] border-accent/35 pl-3">
      <div className="flex items-center gap-2 font-mono text-[10px] text-theme-subtle">
        <Loader2 className="h-3 w-3 animate-spin text-accent" />
        live progress
      </div>
      {uniqueRows.map(row => (
        <div key={row.key} className="rounded-md border border-app bg-app-card px-3 py-2 text-[12px] text-theme-secondary shadow-sm">
          <span className="font-mono text-theme-muted">{formatTime(typeof row.at === 'string' ? row.at : new Date(row.at).toISOString())}</span>
          <span className="ml-2">{row.text}</span>
        </div>
      ))}
    </div>
  );
}

function workflowInterventionFromRuns(runs: SpawnedAgent[]): { run: SpawnedAgent; intervention: WorkflowIntervention } | null {
  for (const run of runs) {
    const context = run.runContext;
    if (!context?.humanInput?.required) continue;
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
  }
  return null;
}

function optionValue(option: string | { label?: string; value?: string }): string {
  return typeof option === 'string' ? option : option.value ?? option.label ?? '';
}

function optionLabel(option: string | { label?: string; value?: string }): string {
  return typeof option === 'string' ? humanLabel(option) : option.label ?? humanLabel(option.value ?? '');
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
  const fields = intervention.fields ?? [];
  const selectField = fields.find(field => field.type === 'select' || (field.options?.length ?? 0) > 0);
  const optionRows: WorkflowInterventionOption[] = intervention.options?.length
    ? intervention.options.map(option => ({ value: option.value ?? option.label ?? '', label: option.label, primary: option.primary, destructive: option.destructive }))
    : (selectField?.options ?? []).map(option => ({ value: optionValue(option), label: optionLabel(option) }));
  const initialOption = optionRows.find(option => option.primary)?.value ?? optionRows[0]?.value ?? '';
  const isApproval = intervention.severity === 'approval' || optionRows.some(option => ['approve', 'request_changes', 'reject'].includes(option.value ?? ''));
  const [selected, setSelected] = useState(initialOption || (isApproval ? 'approve' : 'answer'));
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const textFields = fields.filter(field => field !== selectField);
  const primaryTextField = textFields[0];
  const answerText = primaryTextField ? fieldValues[primaryTextField.name] : fieldValues.answer;
  const feedbackValue =
    textFields.map(field => fieldValues[field.name]).find(Boolean)
    ?? fieldValues.feedback
    ?? '';
  const decision = (isApproval ? selected : 'answer') as WorkflowInterventionAnswer['decision'];
  const needsFeedback = decision === 'request_changes';
  const submitDisabled = submitting
    || (!isApproval && !answerText?.trim())
    || (decision === 'approve' && textFields.some(field => field.required !== false && !fieldValues[field.name]?.trim()))
    || (needsFeedback && !feedbackValue.trim());

  async function submit() {
    if (submitDisabled || !intervention.intervention_id) return;
    setSubmitting(true);
    setError(null);
    try {
      const values: Record<string, unknown> = { ...fieldValues };
      if (selectField?.name && selected) values[selectField.name] = selected;
      await onAnswer({
        executionId: run.executionId,
        interventionId: intervention.intervention_id,
        decision,
        fieldValues: values,
        feedback: needsFeedback ? feedbackValue : undefined,
        answer: !isApproval ? answerText : undefined,
        humanNodeName: intervention.stage,
      });
      setModalOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit response');
      setSubmitting(false);
    }
  }

  const title = intervention.title ?? run.runContext?.humanInput?.title ?? 'Workflow input needed';
  const question = intervention.question ?? intervention.context_summary ?? '';
  const previewOptions = optionRows.slice(0, 3);
  const actorLabel = humanLabel(intervention.stage ?? run.runContext?.progress.currentStep ?? 'plan-gate');
  const interventionAge = timeAgo(intervention.created_at ?? intervention.createdAt ?? null);
  const postedLabel = interventionAge === 'recently' || interventionAge === 'just now' ? 'posted now' : `posted ${interventionAge}`;

  return (
    <>
      <div className="chat-intervention-block">
        <div className="ch-msg allen">
          <div className="ch-avatar">a</div>
          <div className="ch-msg-body">
            <div className="ch-msg-head">
              <span className="ch-msg-who">{actorLabel}</span>
              {(intervention.created_at ?? intervention.createdAt) && (
                <span className="ch-msg-ts">{formatTime(intervention.created_at ?? intervention.createdAt)}</span>
              )}
            </div>
            <div className="ch-msg-text">
              {question ? renderMarkdown(question) : title}
            </div>
            <div className="ch-card gate-card" onClick={() => setModalOpen(true)} role="button" tabIndex={0} onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setModalOpen(true);
            }
          }}>
              <div className="ch-card-h">
                <span className="cc-tag waiting">waiting on you</span>
                <span className="cc-title">{title}</span>
                <span className="cc-pct">{postedLabel}</span>
              </div>
              <div className="ch-card-b">
                <p className="cc-summary">{question ? 'Allen needs your input to proceed.' : title}</p>
                <div className="cc-acts">
                  <button type="button" className="btn primary sm" onClick={(event) => { event.stopPropagation(); setModalOpen(true); }}>
                    answer →
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {modalOpen && (
        <div className="chat-intervention-modal" role="dialog" aria-modal="true" aria-label={title}>
          <button className="chat-intervention-backdrop" type="button" onClick={() => !submitting && setModalOpen(false)} aria-label="Close intervention dialog" />
          <div className="chat-intervention-dialog">
            <div className="chat-intervention-dialog-head">
              <div className="chat-intervention-dialog-icon">
                <AlertCircle className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-accent-yellow/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-accent-yellow">Needs You</span>
                  <span className="truncate font-mono text-[10px] text-theme-subtle">{run.executionId.slice(0, 8)}</span>
                </div>
                <div className="mt-0.5 truncate text-[13px] font-heading font-semibold text-theme-primary">
                  {title}
                </div>
              </div>
              <a href={`/executions/${run.executionId}`} target="_blank" rel="noopener noreferrer" className="rounded p-1 text-accent hover:bg-app-muted" title="Open execution">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
              <button type="button" onClick={() => !submitting && setModalOpen(false)} className="rounded px-2 py-1 font-mono text-[12px] text-theme-muted hover:bg-app-muted hover:text-theme-primary" disabled={submitting}>
                Esc
              </button>
            </div>

            <div className="space-y-3 px-4 py-3">
              {question && (
                <div className="rounded-md border border-app bg-app-card px-3 py-2 text-[13px] leading-relaxed text-theme-secondary">
                  {renderMarkdown(question)}
                </div>
              )}

              {optionRows.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {optionRows.map(option => {
                    const value = option.value ?? '';
                    const active = selected === value;
                    const destructive = option.destructive || value === 'reject';
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setSelected(value)}
                        disabled={submitting}
                        className={`rounded-md border px-3 py-1.5 font-mono text-[11px] capitalize transition-colors disabled:opacity-50 ${
                          active
                            ? destructive
                              ? 'border-accent-red/40 bg-accent-red/10 text-accent-red'
                              : 'border-accent-blue/45 bg-accent-blue/10 text-accent-blue'
                            : 'border-app bg-app-card text-theme-muted hover:border-accent-blue/25 hover:text-theme-secondary'
                        }`}
                      >
                        {option.label ?? humanLabel(value)}
                      </button>
                    );
                  })}
                </div>
              )}

              {textFields.length > 0 ? textFields.map(field => (
                <div key={field.name} className="space-y-1.5">
                  <label className="text-[10px] font-mono uppercase tracking-[0.08em] text-theme-muted">
                    {field.label ?? humanLabel(field.name)}
                    {field.required !== false && <span className="ml-1 text-accent-yellow">*</span>}
                  </label>
                  <textarea
                    value={fieldValues[field.name] ?? ''}
                    onChange={event => setFieldValues(prev => ({ ...prev, [field.name]: event.target.value }))}
                    placeholder={field.placeholder ?? (needsFeedback ? 'Tell the workflow what should change...' : 'Type your response...')}
                    rows={3}
                    disabled={submitting}
                    className="max-h-[110px] min-h-[84px] w-full resize-none overflow-y-auto rounded-md border border-app bg-app-muted px-3 py-2 text-sm text-theme-primary placeholder:text-theme-subtle focus:border-accent-yellow/50 focus:outline-none disabled:opacity-50"
                  />
                </div>
              )) : (
                !isApproval && (
                  <textarea
                    value={fieldValues.answer ?? ''}
                    onChange={event => setFieldValues(prev => ({ ...prev, answer: event.target.value }))}
                    placeholder="Type your response..."
                    rows={3}
                    disabled={submitting}
                    className="max-h-[110px] min-h-[84px] w-full resize-none overflow-y-auto rounded-md border border-app bg-app-muted px-3 py-2 text-sm text-theme-primary placeholder:text-theme-subtle focus:border-accent-yellow/50 focus:outline-none disabled:opacity-50"
                  />
                )
              )}

              {error && (
                <div className="rounded-md border border-accent-red/25 bg-accent-red/10 px-3 py-2 text-[12px] text-accent-red">{error}</div>
              )}

              <div className="flex items-center justify-between gap-3">
                <span className="truncate font-mono text-[10px] text-theme-subtle">
                  {humanLabel(intervention.stage ?? run.runContext?.progress.currentStep ?? 'workflow pause')}
                </span>
                <button
                  type="button"
                  onClick={submit}
                  disabled={submitDisabled}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent-blue/15 px-4 py-1.5 font-mono text-[12px] text-accent-blue transition-colors hover:bg-accent-blue/25 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Send className="h-3.5 w-3.5" />
                  Submit
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function ChatMessageList({ messages, streamText, thinkingText, streaming, activeToolCalls = [], agentThreads = [], agentReports = [], threadsByMessage = {}, pendingUserQuestion, onAnswerUserQuestion, activeAgent, spawnedAgents = [], onAnswerWorkflowIntervention, onSaveToLearnings }: ChatMessageListProps) {
  const [agentMap, setAgentMap] = useState<Record<string, { displayName?: string; icon?: string; color?: string }>>({});
  const pendingWorkflowIntervention = onAnswerWorkflowIntervention ? workflowInterventionFromRuns(spawnedAgents) : null;

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
  const scrollToBottomIfPinned = useCallback(() => {
    if (autoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

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
    if (autoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamText, pendingWorkflowIntervention?.intervention.intervention_id]);

  return (
    <div ref={containerRef} className="chat-stream-v2">
      {messages.length === 0 && !streaming && (
        <div className="chat-empty-stream" />
      )}

      {/* Messages */}
      {messages.map((msg, i) => {
        const msgThreads = msg._id ? threadsByMessage[msg._id] : undefined;
        const senderLabel = msg.role === 'user' ? userDisplayName(msg) : '';
        const diffSplit = msg.role === 'assistant' ? splitFirstDiffFence(msg.content) : { text: msg.content, diff: null };
        return (<React.Fragment key={msg._id || i}>
        <div className={`ch-msg ${msg.role === 'user' ? 'you' : 'allen'} group/msg al-msg-enter`}>
          <div className="ch-avatar">{msg.role === 'user' ? senderInitial(senderLabel) : 'a'}</div>
          <div className="ch-msg-body">
            <div className="ch-msg-head">
              <span className="ch-msg-who">
                {msg.role === 'user' ? senderLabel : assistantDisplayName(activeAgent ? agentMap[activeAgent] : undefined)}
              </span>
              {msg.createdAt && <span className="ch-msg-ts">{formatTime(msg.createdAt)}</span>}
              {msg.role !== 'user' && msg.costUsd != null && msg.costUsd > 0 && <span className="ch-msg-ts">${msg.costUsd.toFixed(4)}</span>}
              {msg.role !== 'user' && msg.durationMs != null && msg.durationMs > 0 && <span className="ch-msg-ts">{(msg.durationMs / 1000).toFixed(1)}s</span>}
            </div>

            <div className={`ch-msg-text ${msg.status === 'failed' ? 'failed' : ''}`}>
              {msg.role === 'assistant' && msg.thinkingText && (
                <ThinkingBlock text={msg.thinkingText} durationMs={msg.durationMs} />
              )}
              {diffSplit.text && (
                <div>
                  {renderMarkdown(diffSplit.text)}
                </div>
              )}
              {msg.role === 'assistant' && (
                <ToolCallsSection calls={msg.toolCalls} threads={msgThreads} agentMap={agentMap} />
              )}
              {msg.error && (
                <div className="chat-msg-error">
                  <AlertCircle className="w-3 h-3 shrink-0" />
                  {msg.error}
                </div>
              )}
            </div>
            {(msg.content || msg.error) && (
              <div className="chat-save-row">
                <MessageCopyButton text={msg.content || msg.error || ''} />
                {msg.role !== 'user' && msg.content && onSaveToLearnings && (
                  <button
                    onClick={() => onSaveToLearnings(msg.content)}
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

        {/* Threads not linked to a tool call (fallback — render below message) */}
        {msgThreads && msgThreads.length > 0 && (() => {
          // Only render threads that weren't already rendered inline with tool calls
          const toolConvIds = new Set(
            (msg.toolCalls ?? [])
              .map(tc => (tc.result as Record<string, unknown>)?.conversation_id as string)
              .filter(Boolean)
          );
          const unlinked = msgThreads.filter(t => !toolConvIds.has(t.conversationId));
          if (unlinked.length === 0) return null;
          return (
            <div className="chat-linked-threads">
              {buildThreadTree(unlinked).map(thread => (
                <AgentThread key={thread.conversationId} thread={thread} agents={agentMap} />
              ))}
            </div>
          );
        })()}
        </React.Fragment>);
      })}

      {/* Streaming message */}
      {streaming && (() => {
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
              <ActiveToolCallsSection calls={activeToolCalls} liveThreads={agentThreads} agentMap={agentMap} />
              <div className={activeToolCalls.length > 0 || thinkingText ? 'mt-2' : undefined}>
                {streamText ? (
                  <>
                    {renderMarkdown(streamText)}
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
      {agentReports.length > 0 && (
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

      <ChatCodeDiffPreview runs={spawnedAgents} onReady={scrollToBottomIfPinned} />
      <ChatPullRequestCards runs={spawnedAgents} />

      {/* Agent threads — only render orphans not already shown inline with tool calls */}
      {agentThreads.length > 0 && !streaming && (() => {
        // During streaming, threads are rendered inline with ActiveToolCallsSection
        // After completion, they're rendered inline with ToolCallsSection via threadsByMessage
        // This section only catches threads that somehow aren't linked to either
        const orphans = agentThreads.filter(t => !t.parentConversationId);
        if (orphans.length === 0) return null;
        return (
          <div className="chat-linked-threads">
            {buildThreadTree(orphans).map(thread => (
              <AgentThread key={thread.conversationId} thread={thread} agents={agentMap} />
            ))}
          </div>
        );
      })()}

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
          <RunProgressFeed runs={spawnedAgents} />
        </div>
      )}

      {/* Workflow human intervention prompt — final required action */}
      {pendingWorkflowIntervention && onAnswerWorkflowIntervention && (
        <WorkflowInterventionPrompt
          run={pendingWorkflowIntervention.run}
          intervention={pendingWorkflowIntervention.intervention}
          onAnswer={onAnswerWorkflowIntervention}
        />
      )}

      <div ref={bottomRef} />
    </div>
  );
}

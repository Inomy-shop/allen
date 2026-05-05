import React, { useEffect, useRef, useState } from 'react';
import { Bot, AlertCircle, AlertTriangle, Copy, Check, Clock, Wrench, CheckCircle, ExternalLink, Loader2, Brain,
  Sparkles, Zap, Cpu, Atom, Terminal, Code, Rocket, Shield, Hexagon, Flame,
  ChevronDown, ChevronRight, GitPullRequest, FolderGit2, FileText, PlayCircle, StopCircle, Timer,
  Send, BarChart3, FolderOpen,
} from 'lucide-react';
import type { ChatMessage, ToolCallRecord, ActiveToolCall, AgentThread as AgentThreadType, AgentReport, SpawnedAgent, WorkflowInterventionAnswer } from '../../hooks/useChat';
import { AgentThread } from './AgentThread';
import { AgentQuestionPrompt } from './AgentQuestionPrompt';
import RoleIcon from '../common/RoleIcon';
import { useSettingsStore } from '../../stores/settingsStore';
import { CHAT_EMPTY_PROMPT } from '../../lib/brand';
import MermaidChatBlock from './MermaidChatBlock';

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
  fields?: WorkflowInterventionField[];
  options?: Array<{ label?: string; value?: string; primary?: boolean; destructive?: boolean }>;
};

type WorkflowInterventionOption = { label?: string; value: string; primary?: boolean; destructive?: boolean };

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

/* ── Thinking block ──────────────────────────────────────────────────────── */
function ThinkingBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = text.length > 120 ? text.slice(0, 120) + '...' : text;

  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[11px] text-accent-purple/70 hover:text-accent-purple transition-colors font-mono"
        title={expanded ? 'Collapse thinking' : 'Expand thinking'}
      >
        <Brain className="w-3 h-3 animate-pulse" />
        <span>Thinking</span>
        <span className="text-theme-subtle">{expanded ? '(collapse)' : '(expand)'}</span>
      </button>
      {expanded ? (
        <div className="mt-1.5 px-3 py-2 rounded-md bg-purple-500/5 border border-purple-500/10 text-xs text-theme-muted font-body leading-relaxed whitespace-pre-wrap max-h-48 overflow-auto">
          {text}
        </div>
      ) : (
        <div className="mt-1 text-[11px] text-theme-subtle font-body italic truncate max-w-[400px]">
          {preview}
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
  return msg.senderName?.trim()
    || msg.senderEmail?.split('@')[0]
    || (msg.senderSource === 'slack' ? 'Slack user' : 'User');
}

function initialsForName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'U';
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
      parts.push(
        <a
          key={k++}
          href={m[8]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-blue hover:text-accent-blue/80 underline underline-offset-2 decoration-accent-blue/30 hover:decoration-accent-blue/60 transition-colors"
        >
          {m[7]}
        </a>,
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

/** Render @mentions as colored chips (for user messages) */
function renderUserContent(content: string): React.ReactNode {
  const parts = content.split(/(@[\w-]+)/g);
  return parts.map((part, i) => {
    if (part.startsWith('@')) {
      return (
        <span
          key={i}
          className="inline-flex items-center px-1.5 py-0.5 rounded bg-white/10 text-accent-blue text-xs font-mono"
        >
          {part}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
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

function ToolCallCard({ call, active }: { call: ToolCallRecord | ActiveToolCall; active?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const meta = TOOL_LABELS[call.tool] ?? { label: call.tool, color: 'text-theme-secondary' };
  const isRunning = active && (call as ActiveToolCall).status === 'running';
  const result = 'result' in call ? call.result : undefined;
  const duration = 'durationMs' in call ? call.durationMs : undefined;

  // Check if result has an execution_id (for link to execution page)
  const executionId = result?.execution_id as string | undefined;

  return (
    <div className="border border-app rounded-lg bg-app-muted/50 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-app-muted transition-colors text-left"
        title={expanded ? 'Collapse tool result' : 'Expand tool result'}
      >
        {isRunning ? (
          <Loader2 className={`w-3.5 h-3.5 ${meta.color} animate-spin`} />
        ) : result?.error ? (
          <AlertCircle className="w-3.5 h-3.5 text-accent-red" />
        ) : (
          <CheckCircle className="w-3.5 h-3.5 text-accent-green/70" />
        )}
        <Wrench className={`w-3 h-3 ${meta.color}`} />
        <span className={`text-xs font-mono ${meta.color}`}>{meta.label}</span>

        {/* Key args summary */}
        {call.args && Object.keys(call.args).length > 0 && (
          <span className="text-[10px] text-theme-subtle font-mono truncate max-w-[200px]">
            {Object.entries(call.args).slice(0, 2).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')}
          </span>
        )}

        <span className="flex-1" />

        {duration != null && (
          <span className="text-[10px] text-theme-subtle font-mono">{duration}ms</span>
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
      </button>

      {expanded && result && (
        <div className="border-t border-app px-3 py-2 bg-[rgb(var(--color-editor-background))] max-h-48 overflow-auto">
          <pre className="text-[11px] font-mono text-theme-secondary whitespace-pre-wrap">
            {JSON.stringify(result, null, 2)}
          </pre>
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
    <div className="mt-2 space-y-1">
      {/* Threads — nested tree, primary content */}
      {rootThreads.map(thread => (
        <AgentThread key={thread.conversationId} thread={thread} agents={agentMap} />
      ))}

      {/* Tool calls — only show if no threads (threads already show the conversation) */}
      {rootThreads.length === 0 && (
        <>
          <button onClick={() => setShowTools(!showTools)} className="flex items-center gap-1.5 text-[10px] font-mono text-theme-subtle hover:text-theme-secondary transition-colors py-0.5">
            {showTools ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <Wrench className="w-2.5 h-2.5" />
            <span>{calls.length} tool call{calls.length !== 1 ? 's' : ''}</span>
            {hasErrors && <span className="text-accent-red">· errors</span>}
          </button>
          {showTools && (
            <div className="ml-4 pl-3 border-l border-border/10 space-y-1.5 max-h-[400px] overflow-y-auto py-1">
              {calls.map((call, i) => <ToolCallCard key={`${call.tool}-${i}`} call={call} />)}
            </div>
          )}
        </>
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
    <div className="mt-2 space-y-1">
      {/* Live threads */}
      {rootThreads.map(thread => (
        <AgentThread key={thread.conversationId} thread={thread} agents={agentMap} />
      ))}

      {/* Running tool indicator */}
      {runningTool && (
        <div className="flex items-center gap-1.5 text-[10px] font-mono text-theme-subtle py-0.5">
          <Loader2 className="w-2.5 h-2.5 text-accent-yellow animate-spin shrink-0" />
          <Wrench className="w-2.5 h-2.5 text-accent-yellow shrink-0" />
          <span className="text-accent-yellow/70">{TOOL_LABELS[runningTool.tool]?.label ?? runningTool.tool.replace('mcp__allen__', 'al:')}</span>
          {completedCount > 0 && <span className="text-theme-subtle">· {completedCount} done</span>}
        </div>
      )}
    </div>
  );
}

/* ── Main component ──────────────────────────────────────────────────────── */

const QUICK_ACTIONS = [
  { label: 'List workflows', icon: 'zap', prompt: 'What workflows do I have?' },
  { label: 'Dashboard stats', icon: 'chart', prompt: 'Show me dashboard stats' },
  { label: 'Recent executions', icon: 'terminal', prompt: 'Show my recent executions' },
  { label: 'List repos', icon: 'folder', prompt: 'List my registered repos' },
  { label: 'Failed today', icon: 'alert', prompt: 'Find all failed executions in the last 24 hours' },
  { label: 'Available agents', icon: 'bot', prompt: 'What agents are available?' },
] as const;

const QUICK_ICONS: Record<string, React.ReactNode> = {
  zap: <Zap className="w-3.5 h-3.5 text-accent-blue" />,
  chart: <BarChart3 className="w-3.5 h-3.5 text-accent-green" />,
  terminal: <Terminal className="w-3.5 h-3.5 text-theme-secondary" />,
  folder: <FolderOpen className="w-3.5 h-3.5 text-accent-yellow" />,
  alert: <AlertTriangle className="w-3.5 h-3.5 text-accent-red" />,
  bot: <Bot className="w-3.5 h-3.5 text-accent-purple" />,
};

import { Bookmark } from 'lucide-react';
import { agents as agentsApi } from '../../services/api';

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
          <a key={artifact.artifactId} href={artifact.url ?? '#'} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-theme-muted hover:text-accent min-w-0">
            <FileText className="w-3 h-3 shrink-0" />
            <span className="truncate">{artifact.filename ?? 'Artifact'}</span>
          </a>
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

function RunProgressTimeline({ runs }: { runs: SpawnedAgent[] }) {
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit response');
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-4 mb-4 max-w-[820px] overflow-hidden rounded-lg border border-accent-yellow/40 bg-accent-yellow/5 shadow-sm">
      <div className="flex items-center gap-2.5 border-b border-accent-yellow/15 px-4 py-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-md border border-accent-yellow/30 bg-accent-yellow/10 text-accent-yellow">
          <AlertTriangle className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="rounded bg-accent-yellow/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-accent-yellow">Needs You</span>
            <span className="truncate font-mono text-[10px] text-theme-subtle">{run.executionId.slice(0, 8)}</span>
          </div>
          <div className="mt-0.5 truncate text-[13px] font-heading font-semibold text-theme-primary">
            {intervention.title ?? run.runContext?.humanInput?.title ?? 'Workflow input needed'}
          </div>
        </div>
        <a href={`/executions/${run.executionId}`} target="_blank" rel="noopener noreferrer" className="rounded p-1 text-accent hover:bg-app-muted" title="Open execution">
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      <div className="space-y-3 px-4 py-3">
        {(intervention.question || intervention.context_summary) && (
          <div className="rounded-md border border-app bg-app-card px-3 py-2 text-[13px] leading-relaxed text-theme-secondary">
            {renderMarkdown(intervention.question ?? intervention.context_summary ?? '')}
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
  );
}

export default function ChatMessageList({ messages, streamText, thinkingText, streaming, activeToolCalls = [], agentThreads = [], agentReports = [], threadsByMessage = {}, pendingUserQuestion, onAnswerUserQuestion, activeAgent, spawnedAgents = [], onAnswerWorkflowIntervention, onSuggestionClick, onSaveToLearnings }: ChatMessageListProps) {
  const agentIconName = useSettingsStore((s) => s.agentIcon);
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
  const AgentIcon = AGENT_ICONS[agentIconName] ?? Bot;
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

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
    <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-6 space-y-5">
      {/* Empty state with quick actions */}
      {messages.length === 0 && !streaming && (
        <div className="flex flex-col items-center justify-center h-full text-center">
          <div className="w-14 h-14 rounded-lg bg-accent-blue/10 border border-accent-blue/20 flex items-center justify-center mb-4">
            <AgentIcon className="w-7 h-7 text-accent-blue/50" />
          </div>
          <p className="text-sm text-theme-secondary font-body">
            {CHAT_EMPTY_PROMPT}
          </p>
          <p className="text-xs text-theme-subtle mt-2 font-body max-w-xs">
            Use <span className="text-accent-blue font-mono">@mentions</span> to reference workflows, repos, and agents.
          </p>
          {onSuggestionClick && (
            <div className="mt-6 grid grid-cols-2 gap-2 max-w-sm">
              {QUICK_ACTIONS.map(action => (
                <button
                  key={action.label}
                  onClick={() => onSuggestionClick(action.prompt)}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-app-muted border border-app hover:bg-surface-200/70 hover:border-accent-blue/30 transition-all text-left group"
                  title={action.prompt}
                >
                  {QUICK_ICONS[action.icon]}
                  <span className="text-xs text-theme-secondary group-hover:text-theme-secondary font-body">{action.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Messages */}
      {messages.map((msg, i) => {
        const msgThreads = msg._id ? threadsByMessage[msg._id] : undefined;
        const senderLabel = msg.role === 'user' ? userDisplayName(msg) : '';
        const senderInitials = msg.role === 'user' ? initialsForName(senderLabel) : '';
        return (<React.Fragment key={msg._id || i}>
        <div
          className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} al-msg-enter`}
        >
          <div className={`group/msg flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse max-w-[75%]' : 'max-w-[90%]'}`}>
            {/* Avatar — only for user messages */}
            {msg.role === 'user' && (
              <div className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center mt-0.5 bg-accent-blue/10 border border-accent-blue/20 text-accent-blue">
                <span className="text-[11px] font-heading font-semibold">{senderInitials}</span>
              </div>
            )}

            {/* Content */}
            <div className={`min-w-0 flex-1 ${msg.role === 'user' ? 'text-right' : ''}`}>
              {/* Message bubble */}
              {msg.role === 'user' ? (
                <>
                  <div className="flex items-center gap-2 mb-1.5 justify-end">
                    <span className="overline">{senderLabel}</span>
                    {msg.createdAt && <span className="text-[10px] font-mono text-theme-subtle flex items-center gap-1"><Clock className="w-2.5 h-2.5" />{formatTime(msg.createdAt)}</span>}
                  </div>
                  <div className="inline-block px-4 py-2.5 rounded-2xl rounded-br-sm bg-accent-blue/15 border border-accent-blue/10 text-sm font-body text-theme-secondary leading-relaxed whitespace-pre-wrap break-words text-left">
                    {renderUserContent(msg.content)}
                  </div>
                </>
              ) : (() => {
                const agentColor = activeAgent && agentMap[activeAgent]?.color ? agentMap[activeAgent].color : '#6b7280';
                const agentInfo = activeAgent ? agentMap[activeAgent] : undefined;
                return (
                  <div>
                    {/* Agent header */}
                    <div className="flex items-center gap-2 mb-1.5">
                      {agentInfo ? (
                        <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ backgroundColor: agentColor + '15', border: `1px solid ${agentColor}25` }}>
                          <RoleIcon icon={agentInfo.icon} color={agentColor} size={13} />
                        </div>
                      ) : null}
                      <span className="text-[12px] font-heading font-semibold tracking-wide" style={{ color: agentColor }}>
                        {agentInfo?.displayName ?? 'Assistant'}
                      </span>
                      {msg.createdAt && <span className="text-[10px] font-mono text-theme-subtle flex items-center gap-1"><Clock className="w-2.5 h-2.5" />{formatTime(msg.createdAt)}</span>}
                      {msg.costUsd != null && msg.costUsd > 0 && <span className="text-[10px] font-mono text-theme-subtle">${msg.costUsd.toFixed(4)}</span>}
                      {msg.durationMs != null && msg.durationMs > 0 && <span className="text-[10px] font-mono text-theme-subtle">{(msg.durationMs / 1000).toFixed(1)}s</span>}
                    </div>

                    {/* Thread-line container — brighter line for main response */}
                    <div className="ml-2 pl-3 pr-3 border-l-[3px] rounded-bl-md" style={{
                      borderColor: msg.status === 'failed' ? '#ef4444a0' : (agentColor + '80'),
                      backgroundColor: msg.status === 'failed' ? '#ef444408' : (agentColor + '08'),
                    }}>
                      {/* Tool calls + threads */}
                      <ToolCallsSection calls={msg.toolCalls} threads={msgThreads} agentMap={agentMap} />

                      {/* Text response */}
                      {msg.content && (
                        <div className={`${msg.toolCalls?.length ? 'mt-2 ' : ''}py-2 text-sm font-body leading-relaxed break-words ${
                          msg.status === 'failed' ? 'text-red-300' : 'text-theme-secondary'
                        }`}>
                          {renderMarkdown(msg.content)}
                        </div>
                      )}

                      {/* Save to learnings */}
                      <div className="flex items-center gap-2 mt-1 pb-1">
                        {msg.content && onSaveToLearnings && (
                          <button
                            onClick={() => onSaveToLearnings(msg.content)}
                            className="flex items-center gap-1 text-[10px] text-theme-subtle hover:text-accent-blue transition-colors opacity-0 group-hover/msg:opacity-100"
                            title="Save to learnings"
                          >
                            <Bookmark className="w-3 h-3" /> Save
                          </button>
                        )}
                      </div>

                      {/* Error */}
                      {msg.error && (
                        <div className="mt-1 flex items-center gap-1.5 text-xs text-accent-red font-mono bg-red-500/5 border border-red-500/10 px-2.5 py-1.5 rounded-md">
                          <AlertCircle className="w-3 h-3 shrink-0" />
                          {msg.error}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>

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
            <div className="ml-11 space-y-2">
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
        const sAgentColor = activeAgent && agentMap[activeAgent]?.color ? agentMap[activeAgent].color : '#6b7280';
        const sAgentInfo = activeAgent ? agentMap[activeAgent] : undefined;
        return (
          <div className="al-msg-enter max-w-[90%]">
            {/* Agent header */}
            <div className="flex items-center gap-2 mb-1.5">
              {sAgentInfo ? (
                <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ backgroundColor: sAgentColor + '15', border: `1px solid ${sAgentColor}25` }}>
                  <RoleIcon icon={sAgentInfo.icon} color={sAgentColor} size={13} />
                </div>
              ) : null}
              <span className="text-[12px] font-heading font-semibold tracking-wide" style={{ color: sAgentColor }}>
                {sAgentInfo?.displayName ?? 'Assistant'}
              </span>
              <span className="text-[10px] text-accent-blue font-mono flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-accent-blue animate-pulse" />
                generating
              </span>
            </div>

            {/* Thread-line container */}
            <div className="ml-2 pl-3 pr-3 border-l-[3px] rounded-bl-md" style={{ borderColor: sAgentColor + '80', backgroundColor: sAgentColor + '08' }}>
              {thinkingText && !streamText && <ThinkingBlock text={thinkingText} />}
              <ActiveToolCallsSection calls={activeToolCalls} liveThreads={agentThreads} agentMap={agentMap} />
              <div className={`${activeToolCalls.length > 0 || (thinkingText && !streamText) ? 'mt-2 ' : ''}py-2 text-sm text-theme-secondary font-body leading-relaxed break-words`}>
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
        );
      })()}

      {/* Agent progress reports */}
      {agentReports.length > 0 && (
        <div className="mx-4 space-y-1.5">
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

      {/* Agent threads — only render orphans not already shown inline with tool calls */}
      {agentThreads.length > 0 && !streaming && (() => {
        // During streaming, threads are rendered inline with ActiveToolCallsSection
        // After completion, they're rendered inline with ToolCallsSection via threadsByMessage
        // This section only catches threads that somehow aren't linked to either
        const orphans = agentThreads.filter(t => !t.parentConversationId);
        if (orphans.length === 0) return null;
        return (
          <div className="mx-4 space-y-2">
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

      {/* Routed workflow/agent executions — chat shows only live logs; sidebar owns step details */}
      {spawnedAgents.some(run => !TERMINAL_RUN_STATUSES.has(run.runContext?.status ?? run.status)) && (
        <div className="px-4 my-3">
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

import React, { useEffect, useRef, useState } from 'react';
import { Bot, User, AlertCircle, Copy, Check, Clock, Wrench, CheckCircle, ExternalLink, Loader2, Brain,
  Sparkles, Zap, Cpu, Atom, Terminal, Code, Rocket, Shield, Hexagon, Flame,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import type { ChatMessage, ToolCallRecord, ActiveToolCall, AgentThread as AgentThreadType, AgentReport } from '../../hooks/useChat';
import { AgentThread } from './AgentThread';
import { AgentQuestionPrompt } from './AgentQuestionPrompt';
import RoleIcon from '../common/RoleIcon';
import { useSettingsStore } from '../../stores/settingsStore';

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
  /** Spawned agent executions — live tracking */
  spawnedAgents?: { executionId: string; agent: string; prompt: string; status: string; activity: { type: string; tool?: string; command?: string; timestamp: number }[]; durationMs?: number; toolCount?: number; response?: string }[];
  onSuggestionClick?: (text: string) => void;
  onSaveToLearnings?: (content: string) => void;
}

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
          <Copy className="w-3 h-3 text-gray-500" />
          <span className="text-gray-500">Copy</span>
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
        className="flex items-center gap-1.5 text-[11px] text-purple-400/70 hover:text-purple-400 transition-colors font-mono"
        title={expanded ? 'Collapse thinking' : 'Expand thinking'}
      >
        <Brain className="w-3 h-3 animate-pulse" />
        <span>Thinking</span>
        <span className="text-gray-600">{expanded ? '(collapse)' : '(expand)'}</span>
      </button>
      {expanded ? (
        <div className="mt-1.5 px-3 py-2 rounded-md bg-purple-500/5 border border-purple-500/10 text-xs text-gray-500 font-body leading-relaxed whitespace-pre-wrap max-h-48 overflow-auto">
          {text}
        </div>
      ) : (
        <div className="mt-1 text-[11px] text-gray-600 font-body italic truncate max-w-[400px]">
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
    parts.push(
      <div key={key++} className="group/code relative my-3 rounded-md overflow-hidden border border-border/40 bg-[rgb(13,17,28)]">
        <div className="flex items-center justify-between px-3 py-1.5 bg-surface-200/60 border-b border-border/30">
          <span className="text-[10px] font-mono text-gray-500 uppercase tracking-wider">
            {lang || 'code'}
          </span>
          <CopyButton text={code} />
        </div>
        <pre className="px-4 py-3 overflow-x-auto text-[13px] leading-relaxed font-mono">
          <code className="text-gray-300">{highlightCode(code, lang)}</code>
        </pre>
      </div>,
    );
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
        tokens.push(<span key={tk++} className="text-gray-600 italic">{m[0]}</span>);
      } else if (m[0].match(/^["'`]/)) {
        // String
        tokens.push(<span key={tk++} className="text-green-400/80">{m[0]}</span>);
      } else if (m[3]) {
        // Number
        tokens.push(<span key={tk++} className="text-accent-orange">{m[0]}</span>);
      } else if (m[4] && kwSet.has(m[4].toLowerCase())) {
        // Keyword (case-insensitive)
        tokens.push(<span key={tk++} className="text-purple-400">{m[0]}</span>);
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

  while (i < lines.length) {
    const line = lines[i];

    // Table detection (line with | and next line with |---|)
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1]?.match(/^\|?[\s-:|]+\|/)) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].includes('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      elements.push(<span key={i}>{renderTable(tableLines)}</span>);
      continue;
    }

    // Horizontal rule
    if (line.match(/^(-{3,}|\*{3,}|_{3,})$/)) {
      elements.push(
        <hr key={i} className="border-0 h-px bg-gradient-to-r from-transparent via-border to-transparent my-4" />,
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
        <div key={i} className="border-l-2 border-accent-blue/40 pl-3 my-2 py-1">
          <div className="text-gray-400 italic text-sm">
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
        <h4 key={i} className="text-sm font-bold text-white mt-4 mb-1.5 font-heading tracking-wide">
          {renderInline(line.slice(4))}
        </h4>,
      );
      i++;
      continue;
    }
    if (line.startsWith('## ')) {
      elements.push(
        <h3 key={i} className="text-[15px] font-bold text-white mt-5 mb-2 font-heading tracking-wide">
          {renderInline(line.slice(3))}
        </h3>,
      );
      i++;
      continue;
    }
    if (line.startsWith('# ')) {
      elements.push(
        <h2 key={i} className="text-base font-bold text-white mt-5 mb-2 font-heading tracking-wide">
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
        <ul key={i} className="my-2 space-y-1">
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
        <ol key={i} className="my-2 space-y-1">
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
      elements.push(<div key={i} className="h-2" />);
      i++;
      continue;
    }

    // Regular paragraph
    elements.push(
      <p key={i} className="my-0.5 leading-relaxed">{renderInline(line)}</p>,
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
    <div className="my-3 overflow-x-auto rounded-md border border-border/40">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-surface-200/60">
            {headers.map((h, i) => (
              <th key={i} className="px-3 py-2 text-left text-xs font-label uppercase tracking-wider text-gray-400 border-b border-border/40">
                {renderInline(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-b border-border/20 last:border-0 hover:bg-surface-200/30 transition-colors">
              {row.map((cell, ci) => (
                <td key={ci} className="px-3 py-1.5 text-gray-300">
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
        <code key={k++} className="px-1.5 py-0.5 bg-surface-200/80 border border-border/30 rounded text-[12px] font-mono text-accent-blue/90">
          {m[1].slice(1, -1)}
        </code>,
      );
    } else if (m[2]) {
      // bold **text**
      parts.push(
        <strong key={k++} className="text-white font-semibold">
          {m[2].slice(2, -2)}
        </strong>,
      );
    } else if (m[3]) {
      // italic *text*
      parts.push(
        <em key={k++} className="text-gray-300 italic">
          {m[3].slice(1, -1)}
        </em>,
      );
    } else if (m[4]) {
      // italic _text_
      parts.push(
        <em key={k++} className="text-gray-300 italic">
          {m[4].slice(1, -1)}
        </em>,
      );
    } else if (m[5]) {
      // strikethrough ~~text~~
      parts.push(
        <del key={k++} className="text-gray-500 line-through">
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
  get_execution: { label: 'Get Execution', color: 'text-accent-blue' },
  list_executions: { label: 'List Executions', color: 'text-accent-blue' },
  cancel_execution: { label: 'Cancel Execution', color: 'text-accent-red' },
  list_repos: { label: 'List Repos', color: 'text-accent-blue' },
  list_agents: { label: 'List Agents', color: 'text-accent-purple' },
  spawn_agent: { label: 'Spawn Agent', color: 'text-accent-purple' },
  delegate_to_agent: { label: 'Delegate', color: 'text-accent-cyan' },
  report_to_user: { label: 'Progress Update', color: 'text-accent-green' },
  get_learnings: { label: 'Get Learnings', color: 'text-accent-yellow' },
  // Phase 5: Advanced queries
  query_database: { label: 'Query Database', color: 'text-accent-orange' },
  search_executions_advanced: { label: 'Search Executions', color: 'text-accent-blue' },
  get_dashboard_stats: { label: 'Dashboard Stats', color: 'text-accent-green' },
  // Debugging
  get_node_trace: { label: 'Node Trace', color: 'text-accent-yellow' },
  get_execution_logs: { label: 'Execution Logs', color: 'text-accent-yellow' },
  // Human-in-the-loop
  submit_execution_input: { label: 'Submit Input', color: 'text-accent-green' },
};

function ToolCallCard({ call, active }: { call: ToolCallRecord | ActiveToolCall; active?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const meta = TOOL_LABELS[call.tool] ?? { label: call.tool, color: 'text-gray-400' };
  const isRunning = active && (call as ActiveToolCall).status === 'running';
  const result = 'result' in call ? call.result : undefined;
  const duration = 'durationMs' in call ? call.durationMs : undefined;

  // Check if result has an execution_id (for link to execution page)
  const executionId = result?.execution_id as string | undefined;

  return (
    <div className="border border-border/30 rounded-lg bg-surface-200/30 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-surface-200/50 transition-colors text-left"
        title={expanded ? 'Collapse tool result' : 'Expand tool result'}
      >
        {isRunning ? (
          <Loader2 className={`w-3.5 h-3.5 ${meta.color} animate-spin`} />
        ) : result?.error ? (
          <AlertCircle className="w-3.5 h-3.5 text-red-400" />
        ) : (
          <CheckCircle className="w-3.5 h-3.5 text-accent-green/70" />
        )}
        <Wrench className={`w-3 h-3 ${meta.color}`} />
        <span className={`text-xs font-mono ${meta.color}`}>{meta.label}</span>

        {/* Key args summary */}
        {call.args && Object.keys(call.args).length > 0 && (
          <span className="text-[10px] text-gray-600 font-mono truncate max-w-[200px]">
            {Object.entries(call.args).slice(0, 2).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')}
          </span>
        )}

        <span className="flex-1" />

        {duration != null && (
          <span className="text-[10px] text-gray-600 font-mono">{duration}ms</span>
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
        <div className="border-t border-border/20 px-3 py-2 bg-[rgb(13,17,28)] max-h-48 overflow-auto">
          <pre className="text-[11px] font-mono text-gray-400 whitespace-pre-wrap">
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
          <button onClick={() => setShowTools(!showTools)} className="flex items-center gap-1.5 text-[10px] font-mono text-gray-600 hover:text-gray-400 transition-colors py-0.5">
            {showTools ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <Wrench className="w-2.5 h-2.5" />
            <span>{calls.length} tool call{calls.length !== 1 ? 's' : ''}</span>
            {hasErrors && <span className="text-red-400">· errors</span>}
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
        <div className="flex items-center gap-1.5 text-[10px] font-mono text-gray-600 py-0.5">
          <Loader2 className="w-2.5 h-2.5 text-accent-yellow animate-spin shrink-0" />
          <Wrench className="w-2.5 h-2.5 text-accent-yellow shrink-0" />
          <span className="text-accent-yellow/70">{TOOL_LABELS[runningTool.tool]?.label ?? runningTool.tool.replace('mcp__flowforge__', 'ff:')}</span>
          {completedCount > 0 && <span className="text-gray-700">· {completedCount} done</span>}
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

import { BarChart3, FolderOpen, AlertTriangle } from 'lucide-react';
const QUICK_ICONS: Record<string, React.ReactNode> = {
  zap: <Zap className="w-3.5 h-3.5 text-accent-blue" />,
  chart: <BarChart3 className="w-3.5 h-3.5 text-accent-green" />,
  terminal: <Terminal className="w-3.5 h-3.5 text-gray-400" />,
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

export default function ChatMessageList({ messages, streamText, thinkingText, streaming, activeToolCalls = [], agentThreads = [], agentReports = [], threadsByMessage = {}, pendingUserQuestion, onAnswerUserQuestion, activeAgent, spawnedAgents = [], onSuggestionClick, onSaveToLearnings }: ChatMessageListProps) {
  const agentIconName = useSettingsStore((s) => s.agentIcon);
  const [agentMap, setAgentMap] = useState<Record<string, { displayName?: string; icon?: string; color?: string }>>({});

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
  }, [messages, streamText]);

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-6 space-y-5">
      {/* Empty state with quick actions */}
      {messages.length === 0 && !streaming && (
        <div className="flex flex-col items-center justify-center h-full text-center">
          <div className="w-14 h-14 rounded-lg bg-accent-blue/10 border border-accent-blue/20 flex items-center justify-center mb-4">
            <AgentIcon className="w-7 h-7 text-accent-blue/50" />
          </div>
          <p className="text-sm text-gray-400 font-body">
            Start a conversation with FlowForge Assistant.
          </p>
          <p className="text-xs text-gray-600 mt-2 font-body max-w-xs">
            Use <span className="text-accent-blue font-mono">@mentions</span> to reference workflows, repos, and agents.
          </p>
          {onSuggestionClick && (
            <div className="mt-6 grid grid-cols-2 gap-2 max-w-sm">
              {QUICK_ACTIONS.map(action => (
                <button
                  key={action.label}
                  onClick={() => onSuggestionClick(action.prompt)}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-surface-200/40 border border-border/30 hover:bg-surface-200/70 hover:border-accent-blue/30 transition-all text-left group"
                  title={action.prompt}
                >
                  {QUICK_ICONS[action.icon]}
                  <span className="text-xs text-gray-400 group-hover:text-gray-300 font-body">{action.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Messages */}
      {messages.map((msg, i) => {
        const msgThreads = msg._id ? threadsByMessage[msg._id] : undefined;
        return (<React.Fragment key={msg._id || i}>
        <div
          className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} ff-msg-enter`}
        >
          <div className={`group/msg flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse max-w-[75%]' : 'max-w-[90%]'}`}>
            {/* Avatar — only for user messages */}
            {msg.role === 'user' && (
              <div className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center mt-0.5 bg-accent-blue/10 border border-accent-blue/20 text-accent-blue">
                <User className="w-4 h-4" />
              </div>
            )}

            {/* Content */}
            <div className={`min-w-0 flex-1 ${msg.role === 'user' ? 'text-right' : ''}`}>
              {/* Message bubble */}
              {msg.role === 'user' ? (
                <>
                  <div className="flex items-center gap-2 mb-1.5 justify-end">
                    <span className="text-[10px] font-label uppercase tracking-widest text-gray-500">You</span>
                    {msg.createdAt && <span className="text-[10px] font-mono text-gray-700 flex items-center gap-1"><Clock className="w-2.5 h-2.5" />{formatTime(msg.createdAt)}</span>}
                  </div>
                  <div className="inline-block px-4 py-2.5 rounded-2xl rounded-br-sm bg-accent-blue/15 border border-accent-blue/10 text-sm font-body text-gray-200 leading-relaxed whitespace-pre-wrap break-words">
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
                      {msg.createdAt && <span className="text-[10px] font-mono text-gray-700 flex items-center gap-1"><Clock className="w-2.5 h-2.5" />{formatTime(msg.createdAt)}</span>}
                      {msg.costUsd != null && msg.costUsd > 0 && <span className="text-[10px] font-mono text-gray-600">${msg.costUsd.toFixed(4)}</span>}
                      {msg.durationMs != null && msg.durationMs > 0 && <span className="text-[10px] font-mono text-gray-600">{(msg.durationMs / 1000).toFixed(1)}s</span>}
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
                          msg.status === 'failed' ? 'text-red-300' : 'text-gray-300'
                        }`}>
                          {renderMarkdown(msg.content)}
                        </div>
                      )}

                      {/* Save to learnings */}
                      <div className="flex items-center gap-2 mt-1 pb-1">
                        {msg.content && onSaveToLearnings && (
                          <button
                            onClick={() => onSaveToLearnings(msg.content)}
                            className="flex items-center gap-1 text-[10px] text-gray-600 hover:text-accent-blue transition-colors opacity-0 group-hover/msg:opacity-100"
                            title="Save to learnings"
                          >
                            <Bookmark className="w-3 h-3" /> Save
                          </button>
                        )}
                      </div>

                      {/* Error */}
                      {msg.error && (
                        <div className="mt-1 flex items-center gap-1.5 text-xs text-red-400 font-mono bg-red-500/5 border border-red-500/10 px-2.5 py-1.5 rounded-md">
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
          <div className="ff-msg-enter max-w-[90%]">
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
              <div className={`${activeToolCalls.length > 0 || (thinkingText && !streamText) ? 'mt-2 ' : ''}py-2 text-sm text-gray-300 font-body leading-relaxed break-words`}>
                {streamText ? (
                  <>
                    {renderMarkdown(streamText)}
                    <span className="inline-block w-0.5 h-4 bg-accent-blue/70 ml-0.5 animate-pulse align-middle" />
                  </>
                ) : thinkingText ? (
                  <span className="text-purple-400/60 text-xs font-mono flex items-center gap-1.5">
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
                <span className="text-[11px] text-gray-400 font-body">{report.message}</span>
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

      {/* Spawned agent executions — live cards */}
      {spawnedAgents.length > 0 && (
        <div className="px-4 space-y-2 my-3">
          {spawnedAgents.map(s => (
            <div key={s.executionId} className={`border rounded-lg p-3 ${s.status === 'running' ? 'border-blue-500/30 bg-blue-500/5' : s.status === 'completed' ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-red-500/20 bg-red-500/5'}`}>
              <div className="flex items-center gap-2 mb-1.5">
                {s.status === 'running' && <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />}
                {s.status === 'completed' && <span className="w-2 h-2 rounded-full bg-emerald-400" />}
                {s.status === 'failed' && <span className="w-2 h-2 rounded-full bg-red-400" />}
                <span className="text-[11px] font-mono font-bold text-gray-300">{s.agent}</span>
                <span className="text-[9px] text-gray-600 font-mono">{s.executionId.slice(0, 8)}</span>
                <a href={`/executions/${s.executionId}`} target="_blank" rel="noopener noreferrer" className="text-[9px] text-blue-400 hover:underline ml-auto">View Execution →</a>
              </div>
              <p className="text-[10px] text-gray-500 mb-1.5 truncate">{s.prompt}</p>
              {/* Live activity feed */}
              {s.activity.length > 0 && (
                <div className="space-y-0.5 max-h-32 overflow-y-auto">
                  {s.activity.map((a, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-[10px] font-mono">
                      {a.type === 'thinking' && <span className="text-purple-400">💭 thinking...</span>}
                      {a.type === 'tool_start' && <span className="text-amber-400">⚡ {a.tool}</span>}
                      {a.type === 'tool_done' && <span className="text-gray-500">✓ {a.tool}{a.command ? ` (${a.command})` : ''}</span>}
                    </div>
                  ))}
                </div>
              )}
              {s.status === 'running' && s.activity.length === 0 && (
                <span className="text-[10px] text-blue-400 animate-pulse">Starting agent...</span>
              )}
              {s.status === 'completed' && s.durationMs && (
                <div className="text-[9px] text-gray-600 mt-1">{s.toolCount} tools · {(s.durationMs / 1000).toFixed(1)}s</div>
              )}
            </div>
          ))}
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}

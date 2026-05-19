import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import Editor from '@monaco-editor/react';
import type { NodeState, ActivityEntry } from '../../hooks/useExecution';
import StatusBadge from '../common/StatusBadge';
import CostDisplay from '../common/CostDisplay';
import { ContentViewer, ExpandButton, type ViewerMode } from '../common/ContentViewer';
import { renderMarkdown } from '../chat/ChatMessageList';
import StreamOutput from './StreamOutput';
import { useSettingsStore } from '../../stores/settingsStore';
import { resolveColorMode } from '../../lib/theme';
import { Wrench, CheckCircle, Send, MessageSquare, ChevronDown, ChevronRight } from 'lucide-react';
import { ToolCallLog } from '../common/ToolCallLog';
import NodeInspector from './NodeInspector';
import { CopyButton, DownloadButton } from '../common/CopyDownload';
import TemplateBindingsTable from './TemplateBindingsTable';
import StateDiffModal from './StateDiffModal';

// ── Inline Monaco (read-only, compact) ──

/**
 * Monaco-based read-only editor used inside the node detail tabs.
 *
 * Two sizing modes:
 *   - `fill` (default for the tab view) — stretches to fill the parent's
 *     available height via `height="100%"`. Parent MUST establish a
 *     concrete height (flex-1 + min-h-0, or a fixed px value) or Monaco
 *     renders 0px.
 *   - height-capped mode — when `fill` is false, we compute a height from
 *     the line count capped at `maxHeight`. Used by any legacy embedded
 *     uses of InlineEditor outside a tab.
 *
 * Word wrap is enabled for EVERY language now (including JSON), because
 * the tab pane is narrower than the typical deeply-nested JSON line and
 * horizontal scrolling for long string values was actively bad UX. Users
 * can still click the fullscreen expand button to see unwrapped content
 * in the ContentViewer modal.
 */
function InlineEditor({
  value, language, maxHeight = 200, fill = false,
}: {
  value: string;
  language: string;
  maxHeight?: number;
  fill?: boolean;
}) {
  const colorMode = useSettingsStore(s => s.colorMode);
  const theme = resolveColorMode(colorMode) === 'light' ? 'vs' : 'vs-dark';
  const lineCount = value.split('\n').length;
  const height = fill ? '100%' : Math.min(Math.max(lineCount * 19 + 16, 60), maxHeight);

  return (
    <div className={`rounded-md overflow-hidden border border-app ${fill ? 'h-full flex flex-col min-h-0' : ''}`}>
      <Editor
        height={height}
        language={language}
        value={value}
        theme={theme}
        options={{
          readOnly: true,
          fontSize: 11,
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          lineNumbers: 'on',
          glyphMargin: false,
          folding: true,
          foldingStrategy: 'indentation',
          bracketPairColorization: { enabled: true },
          // Wrap ALL languages. For JSON specifically, long string values
          // that would otherwise cause horizontal scrolling now flow onto
          // the next line. Fullscreen modal still shows unwrapped source.
          wordWrap: 'on',
          wrappingIndent: 'indent',
          padding: { top: 6, bottom: 6 },
          lineDecorationsWidth: 4,
          scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
          overviewRulerBorder: false,
          overviewRulerLanes: 0,
          renderLineHighlight: 'none',
          guides: { indentation: true, bracketPairs: true },
        }}
      />
    </div>
  );
}

// ── Inline Markdown ──

/**
 * Hide the trailing structured-output from an agent's raw response before
 * rendering as markdown. Mirrors the three extraction layers the engine
 * uses in `packages/engine/src/output-extractor.ts`:
 *
 *   Layer 0  — whole trimmed response is raw JSON
 *   Layer 1  — fenced ```json ... ``` block (permissive whitespace)
 *   Layer 1b — bare `{ ... }` or `[ ... ]` JSON object, unfenced
 *
 * For each layer, if the engine WOULD extract from that shape, we hide
 * the corresponding span from the display. The extracted data is already
 * visible in the "Outputs" section below, so leaving it in the markdown
 * is duplication that pushes the narrative off-screen.
 */
function stripTrailingJsonBlock(text: string): string {
  if (!text) return text;

  // ─── Layer 0: whole response is JSON ───
  // If the trimmed response parses as JSON, render a stub placeholder
  // instead — the Outputs section below will show the structured data.
  const trimmedAll = text.trim();
  if (trimmedAll.startsWith('{') || trimmedAll.startsWith('[')) {
    try {
      JSON.parse(trimmedAll);
      return '_(Response is a JSON object — see the Outputs section below for the structured data.)_';
    } catch { /* not pure JSON — fall through to layer 1 */ }
  }

  // ─── Layer 1: fenced code block ───
  // Permissive fence regex matching the engine's Layer 1:
  //   /```json\s*\n?([\s\S]*?)\n?\s*```/
  // We allow any lang tag (so we can filter to json/json5/yaml/untagged),
  // tolerate whitespace around the newlines, and scan for the LAST match
  // in the text.
  const fenceRegex = /```([a-zA-Z0-9_-]*)[ \t]*\n?([\s\S]*?)[ \t]*\n?```/g;
  let lastFence: { start: number; end: number; body: string; lang: string } | null = null;
  let m: RegExpExecArray | null;
  while ((m = fenceRegex.exec(text)) !== null) {
    lastFence = {
      start: m.index,
      end: m.index + m[0].length,
      body: m[2] ?? '',
      lang: (m[1] || '').toLowerCase(),
    };
  }
  if (lastFence) {
    const allowedLangs = new Set(['', 'json', 'json5', 'yaml']);
    const langOk = allowedLangs.has(lastFence.lang);
    // Validate body: either the lang tag explicitly says json-like, OR
    // the untagged body is shaped like JSON and parses. Avoids stripping
    // a trailing `bash` / `python` block.
    const bodyTrim = lastFence.body.trim();
    let bodyIsJsonLike = false;
    if (['json', 'json5'].includes(lastFence.lang)) {
      bodyIsJsonLike = true; // trust the tag
    } else if (lastFence.lang === '' || lastFence.lang === 'yaml') {
      if (bodyTrim.startsWith('{') || bodyTrim.startsWith('[')) {
        try { JSON.parse(bodyTrim); bodyIsJsonLike = true; }
        catch { /* not JSON */ }
      }
    }
    // "Is this trailing?" — the correct test is whether there's anything
    // substantive AFTER the block, not where the block started. A response
    // that's a small narrative intro followed by a huge JSON block has
    // the fence opening early in the text but the block IS the trailing
    // content, so we still want to strip it. Accept any fence whose end
    // is ≤200 non-whitespace chars from the text end.
    const tailAfterFence = text.slice(lastFence.end).trim();
    const isTrailing = tailAfterFence.length <= 200;
    if (langOk && bodyIsJsonLike && isTrailing) {
      const before = text.slice(0, lastFence.start).trimEnd();
      const after = tailAfterFence;
      const cleaned = after ? `${before}\n\n${after}` : before;
      if (cleaned.trim().length >= 40) return cleaned;
      // Narrative would be too thin → fall through. Layer 1b won't match
      // (fenced content isn't a valid JSON span via findJsonEnd because the
      // scanner starts at raw `{`, not inside a fence), so we end up
      // returning the original text. That's fine — a response with almost
      // no narrative around a JSON block is effectively layer-0 territory
      // and the user can read it as-is.
    }
  }

  // ─── Layer 1b: bare JSON object/array, unfenced ───
  // Scan forward balancing braces (string-aware) and keep the LAST span
  // that parses as JSON. Strip it if it's trailing (nothing but a short
  // footer after it) and in the back half of the response.
  const bare = stripTrailingBareJson(text);
  if (bare !== text) return bare;

  return text;
}

/**
 * Find a trailing balanced JSON span and remove it. Returns the original
 * text unchanged if no valid trailing JSON is found. Uses a forward scan
 * with string awareness — more reliable than greedy regex for matching
 * what JSON.parse would accept.
 */
function stripTrailingBareJson(text: string): string {
  let lastValidStart = -1;
  let lastValidEnd = -1;
  const len = text.length;
  let i = 0;
  while (i < len) {
    const c = text[i];
    if (c === '{' || c === '[') {
      const end = findJsonEnd(text, i);
      if (end !== -1) {
        const candidate = text.slice(i, end + 1);
        try {
          JSON.parse(candidate);
          lastValidStart = i;
          lastValidEnd = end;
          i = end + 1;
          continue;
        } catch { /* not JSON, keep scanning */ }
      }
    }
    i++;
  }
  if (lastValidStart === -1) return text;

  // "Is this trailing?" — correct test is that nothing substantive comes
  // AFTER the block. We don't care where in the text the block started.
  // A response that's a thin narrative intro followed by a huge JSON dump
  // starts the JSON early but the JSON is still the trailing content.
  const tail = text.slice(lastValidEnd + 1).trim();
  if (tail.length > 200) return text;

  const cleaned = text.slice(0, lastValidStart).trimEnd() + (tail ? `\n\n${tail}` : '');
  if (cleaned.trim().length < 40) return text;
  return cleaned;
}

/**
 * Walk forward from an opening brace/bracket, balancing depth, ignoring
 * braces inside strings. Returns the index of the matching closing char,
 * or -1 if unbalanced or malformed.
 */
function findJsonEnd(text: string, start: number): number {
  const open = text[start];
  if (open !== '{' && open !== '[') return -1;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') { i++; continue; }          // skip escaped char
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function formatOutputValue(value: unknown): string {
  if (value == null || value === '') return 'none';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

function humanizeKey(key: string): string {
  return key
    .replace(/^__/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function structuredResponseMarkdown(nodeName: string, output: Record<string, unknown> | null | undefined): string {
  if (!output || Object.keys(output).length === 0) return '';
  const title = nodeName.includes('escalation')
    ? 'Escalation Review'
    : nodeName.includes('approval')
      ? 'Review Decision'
      : 'Structured Response';
  const primaryKeys = ['decision', 'escalation_decision', 'approval_decision', '__action', 'verdict', 'status'];
  const feedbackKeys = ['feedback', 'escalation_feedback', 'approval_feedback', '__reason', 'reason', 'rationale'];
  const hiddenKeys = new Set(['__clarify_content', '__clarify_content_type']);
  const lines: string[] = [`### ${title}`];

  for (const key of primaryKeys) {
    if (output[key] == null || output[key] === '') continue;
    lines.push('', `**${humanizeKey(key)}:** \`${formatOutputValue(output[key])}\``);
    break;
  }

  for (const key of feedbackKeys) {
    if (output[key] == null || output[key] === '') continue;
    lines.push('', `**${humanizeKey(key)}**`, '', formatOutputValue(output[key]));
  }

  const remaining = Object.entries(output)
    .filter(([key, value]) =>
      !primaryKeys.includes(key) &&
      !feedbackKeys.includes(key) &&
      !hiddenKeys.has(key) &&
      value != null &&
      value !== '',
    );
  if (remaining.length > 0) {
    lines.push('', '**Other outputs**');
    for (const [key, value] of remaining) {
      const formatted = formatOutputValue(value);
      if (formatted.includes('\n')) lines.push('', `**${humanizeKey(key)}**`, '', '```', formatted, '```');
      else lines.push(`- **${humanizeKey(key)}:** ${formatted}`);
    }
  }

  return lines.join('\n');
}

function InlineMarkdown({
  content, maxHeight = 200, fill = false,
}: {
  content: string;
  maxHeight?: number;
  fill?: boolean;
}) {
  return (
    <div
      className={`rounded-md border border-app bg-surface-100/50 p-3 overflow-auto prose-allen ${fill ? 'h-full min-h-0' : ''}`}
      style={fill ? undefined : { maxHeight }}
    >
      <div className="text-xs text-theme-secondary leading-relaxed break-words">
        {renderMarkdown(content)}
      </div>
    </div>
  );
}

// ── Tab button ──
//
// Single tab in the node-detail data-view tab bar. Disabled when there's
// no content for that tab (e.g. Prompt tab on a node that hasn't started),
// active when it's the currently selected view. `live` adds a pulsing
// blue dot for the Response tab while the node is streaming.
function TabButton({
  label,
  active,
  disabled,
  onClick,
  live = false,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  live?: boolean;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={`
        relative px-3 py-2 text-[10px] font-heading uppercase tracking-wider
        border-b-2 transition-colors shrink-0
        ${active
          ? 'border-accent-blue text-accent-blue'
          : disabled
            ? 'border-transparent text-theme-subtle cursor-not-allowed opacity-50'
            : 'border-transparent text-theme-muted hover:text-theme-primary hover:border-app'
        }
      `}
    >
      <span className="inline-flex items-center gap-1.5">
        {label}
        {live && <span className="w-1.5 h-1.5 rounded-full bg-accent-blue animate-pulse" />}
      </span>
    </button>
  );
}

// ── Collapsible Section ──

function Section({ title, defaultOpen = true, expandContent, onExpand, children }: {
  title: string;
  defaultOpen?: boolean;
  expandContent?: string;
  onExpand?: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-app">
      <div className="flex items-center gap-2 px-4 py-2 hover:bg-surface-200/10 cursor-pointer" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="w-3 h-3 text-theme-subtle shrink-0" /> : <ChevronRight className="w-3 h-3 text-theme-subtle shrink-0" />}
        <h4 className="font-heading text-[10px] font-semibold text-theme-secondary uppercase tracking-widest flex-1">{title}</h4>
        {expandContent && onExpand && <ExpandButton onClick={onExpand} />}
      </div>
      {open && <div className="px-4 pb-3">{children}</div>}
    </section>
  );
}

// ── Types ──

interface HumanInputField {
  name: string;
  type: string;
  label?: string;
  required?: boolean;
  options?: string[];
  placeholder?: string;
}

interface Props {
  nodeName: string;
  nodeState: NodeState | undefined;
  trace: any | undefined;
  allTraces?: any[];
  waitingInput?: {
    node: string;
    prompt: string;
    fields: HumanInputField[];
  } | null;
  onSubmitInput?: (data: Record<string, unknown>) => void;
  /** Spawned children whose parent caller is this node. */
  spawnedChildren?: SpawnedChildRow[];
  /** Every child in the spawn tree (used for nested grouping). */
  allChildren?: SpawnedChildRow[];
  descendantsMode?: boolean;
  onToggleDescendants?: (next: boolean) => void;
  contextEngineEnabled?: boolean;
}

/**
 * Row shape for the Spawned Agents panel. Mirrors the SpawnedChild
 * interface in services/api.ts but kept local to avoid a circular import.
 */
interface SpawnedChildRow {
  id: string;
  workflowName: string;
  agentName: string;
  parentCaller: string | null;
  parentExecutionId: string | null;
  rootExecutionId: string | null;
  spawnDepth: number;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  cost: { actual: number | null; estimated: number } | null;
  failedNode: string | null;
  errorMessage: string | null;
  promptPreview: string;
  linkType: 'direct' | 'timing';
}

// ── Spawned Agents panel ──
//
// Renders the spawn-tree children of the currently selected node. Each row
// shows the child agent's name, status, duration, cost, and a link out to
// the child's own execution detail page. When descendantsMode is on, also
// shows any grandchildren/deeper grouped under their direct parent so the
// operator sees the whole spawn subtree for this branch.

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '—';
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const totalMin = Math.floor(totalSec / 60);
  const remainSec = Math.floor(totalSec % 60);
  if (totalMin < 60) return `${totalMin}m ${remainSec}s`;
  const hours = Math.floor(totalMin / 60);
  const remainMin = totalMin % 60;
  return `${hours}h ${remainMin}m`;
}

function formatCost(cost: SpawnedChildRow['cost']): string {
  if (!cost) return '—';
  const actual = cost.actual;
  if (actual != null && actual > 0) return `$${actual.toFixed(4)}`;
  if (cost.estimated > 0) return `~$${cost.estimated.toFixed(4)}`;
  return '—';
}

function statusColor(status: string): string {
  switch (status) {
    case 'completed': return 'text-accent-green';
    case 'failed':    return 'text-accent-red';
    case 'running':   return 'text-accent-blue';
    case 'queued':    return 'text-accent-yellow';
    case 'waiting_for_input': return 'text-accent-orange';
    default:          return 'text-theme-muted';
  }
}

function SpawnedAgentRow({
  row,
  indent = 0,
  onCancel,
  cancelling,
}: {
  row: SpawnedChildRow;
  indent?: number;
  onCancel?: (id: string) => void;
  cancelling?: boolean;
}) {
  const isLive = row.status === 'running' || row.status === 'waiting_for_input';
  return (
    <div
      className="flex items-stretch group/spawn-row rounded-md hover:bg-app-muted transition-colors border border-transparent hover:border-app"
      style={{ marginLeft: indent * 16 }}
    >
      <a
        href={`/executions/${row.id}`}
        className="flex items-start gap-3 px-3 py-2 flex-1 min-w-0"
      >
        <div className={`text-[10px] font-mono uppercase tracking-wider shrink-0 w-20 ${statusColor(row.status)}`}>
          {isLive ? '● ' : ''}{row.status}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-theme-primary">{row.agentName}</span>
            {row.parentCaller && (
              <span className="font-mono text-[9px] text-theme-subtle">
                ← {row.parentCaller}
              </span>
            )}
          </div>
          {row.promptPreview && (
            <div className="text-[10px] text-theme-muted mt-0.5 line-clamp-1 font-mono">
              {row.promptPreview}
            </div>
          )}
          {row.errorMessage && (
            <div className="text-[10px] text-accent-red mt-0.5 font-mono break-words line-clamp-2">
              {row.errorMessage}
            </div>
          )}
        </div>
        <div className="text-right shrink-0 flex flex-col items-end gap-0.5">
          <span className="text-[10px] font-mono text-theme-secondary">{formatDuration(row.durationMs)}</span>
          <span className="text-[10px] font-mono text-theme-muted">{formatCost(row.cost)}</span>
        </div>
      </a>
      {/* Per-row cancel — only shown for live rows. Kills just this one
          execution, not its descendants. Use the panel's "Cancel subtree"
          button for that. */}
      {isLive && onCancel && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (confirm(`Cancel execution of "${row.agentName}"? This won't affect its own spawned agents (if any).`)) {
              onCancel(row.id);
            }
          }}
          disabled={cancelling}
          className="px-2 text-[10px] font-mono text-theme-muted hover:text-accent-red opacity-0 group-hover/spawn-row:opacity-100 transition-opacity disabled:opacity-40"
          title="Cancel this execution"
        >
          ✕
        </button>
      )}
    </div>
  );
}

function SpawnedAgentsPanel({
  directChildren,
  allChildren,
  descendantsMode,
  onToggleDescendants,
}: {
  directChildren: SpawnedChildRow[];
  allChildren: SpawnedChildRow[];
  descendantsMode: boolean;
  onToggleDescendants?: (next: boolean) => void;
}) {
  // Cancellation state — tracks which row ids have an in-flight cancel
  // request so we can disable their buttons and show a spinner-ish state.
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(new Set());

  const cancelOne = async (id: string) => {
    setCancellingIds(prev => new Set(prev).add(id));
    try {
      const { executions } = await import('../../services/api');
      await executions.cancel(id);
    } catch (err) {
      alert(`Failed to cancel: ${(err as Error).message}`);
    } finally {
      // Leave the id in the set — the next children refresh will drop
      // the row from the "live" filter anyway. Prevents double-click.
    }
  };

  const cancelSubtree = async () => {
    // Cancel every running row in the current view. Picks from the whole
    // subtree when descendants mode is on, otherwise just direct children.
    const targets = (descendantsMode ? allChildren : directChildren)
      .filter(r => r.status === 'running' || r.status === 'waiting_for_input');
    if (targets.length === 0) return;
    if (!confirm(`Cancel ${targets.length} running agent${targets.length === 1 ? '' : 's'}? This kills the subprocesses immediately.`)) return;
    const { executions } = await import('../../services/api');
    setCancellingIds(prev => {
      const next = new Set(prev);
      for (const t of targets) next.add(t.id);
      return next;
    });
    // Fire cancels in parallel — each one is a best-effort call.
    await Promise.allSettled(targets.map(t => executions.cancel(t.id)));
  };

  // When descendants mode is OFF, render direct children as a flat list.
  // When ON, group any nested descendants under their direct parent: walk
  // the allChildren set and for each direct child, find the grandchildren
  // whose parentExecutionId matches. Recurse to any depth.
  const renderBranch = (parents: SpawnedChildRow[], indent: number): JSX.Element[] => {
    const out: JSX.Element[] = [];
    for (const parent of parents) {
      out.push(
        <SpawnedAgentRow
          key={parent.id}
          row={parent}
          indent={indent}
          onCancel={cancelOne}
          cancelling={cancellingIds.has(parent.id)}
        />,
      );
      if (descendantsMode) {
        const kids = allChildren.filter(c => c.parentExecutionId === parent.id);
        if (kids.length > 0) {
          out.push(...renderBranch(kids, indent + 1));
        }
      }
    }
    return out;
  };

  const rows = directChildren.length > 0
    ? renderBranch(directChildren, 0)
    : [];

  // Total cost across all visible children (direct + descendants when expanded).
  const visible = descendantsMode ? allChildren : directChildren;
  const totalCost = visible.reduce((sum, r) => sum + ((r.cost?.actual ?? r.cost?.estimated) ?? 0), 0);
  const runningCount = visible.filter(r => r.status === 'running' || r.status === 'waiting_for_input').length;

  return (
    <div className="rounded-md border border-app bg-surface-100/50 p-2">
      {/* Header row with count + descendants toggle + total cost + cancel */}
      <div className="flex items-center justify-between px-1 pb-2 mb-1 border-b border-app">
        <span className="text-[10px] font-mono uppercase tracking-wider text-theme-subtle">
          {visible.length} {visible.length === 1 ? 'spawn' : 'spawns'}
          {runningCount > 0 && (
            <span className="ml-2 text-accent-blue">· {runningCount} running</span>
          )}
          {totalCost > 0 && <span className="ml-2 text-theme-muted">· ${totalCost.toFixed(4)}</span>}
        </span>
        <div className="flex items-center gap-3">
          {runningCount > 0 && (
            <button
              onClick={cancelSubtree}
              className="text-[10px] font-mono text-accent-red hover:text-accent-red/80 transition-colors"
              title={`Cancel ${runningCount} running execution${runningCount === 1 ? '' : 's'} in this view`}
            >
              Cancel {runningCount}
            </button>
          )}
          {onToggleDescendants && (
            <label className="flex items-center gap-1.5 cursor-pointer text-[10px] font-mono text-theme-muted hover:text-theme-primary">
              <input
                type="checkbox"
                checked={descendantsMode}
                onChange={e => onToggleDescendants(e.target.checked)}
                className="w-3 h-3 accent-accent-blue"
              />
              Show all descendants
            </label>
          )}
        </div>
      </div>
      {rows.length > 0 ? (
        <div className="space-y-1">
          {rows}
        </div>
      ) : (
        <div className="text-[11px] text-theme-muted px-2 py-3 text-center">
          No agents spawned from this node.
        </div>
      )}
    </div>
  );
}

// ── Main Component ──

type DataTab = 'input' | 'prompt' | 'response' | 'outputs' | 'inspector';

export default function NodeDetail({
  nodeName, nodeState, trace, allTraces = [], waitingInput, onSubmitInput,
  spawnedChildren = [], allChildren = [], descendantsMode = false, onToggleDescendants,
  contextEngineEnabled = true,
}: Props) {
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [expandViewer, setExpandViewer] = useState<{ title: string; content: string; mode?: ViewerMode } | null>(null);
  /** When set, opens StateDiffModal comparing two attempts' inputState+output. */
  const [compareAttempts, setCompareAttempts] = useState<[number, number] | null>(null);

  // Deep-link attempt + tab via URL params. `?attempt=N` and `?tab=Y`
  // survive reload + let users share a link to a specific view.
  const [searchParams, setSearchParams] = useSearchParams();
  const attemptParam = searchParams.get('attempt');
  // Guard against malformed ?attempt=foo — Number('foo') is NaN which would
  // silently break the active-attempt match downstream. Coerce to null when
  // not a finite number.
  const parsedAttempt = attemptParam != null ? Number(attemptParam) : NaN;
  const viewAttempt: number | null = Number.isFinite(parsedAttempt) ? parsedAttempt : null;
  const setViewAttempt = (a: number | null) => {
    const next = new URLSearchParams(searchParams);
    if (a != null) next.set('attempt', String(a));
    else next.delete('attempt');
    setSearchParams(next, { replace: true });
  };
  const tabParam = searchParams.get('tab') as DataTab | null;
  const [activeTabInternal, setActiveTabInternal] = useState<DataTab>('response');
  const activeTab: DataTab = (tabParam && ['input', 'prompt', 'response', 'outputs', 'inspector'].includes(tabParam))
    ? tabParam : activeTabInternal;
  const setActiveTab = (t: DataTab) => {
    setActiveTabInternal(t);
    const next = new URLSearchParams(searchParams);
    next.set('tab', t);
    setSearchParams(next, { replace: true });
  };

  // Reset the active tab whenever the selected node changes. MUST be
  // declared before any early `return` below or React throws a
  // "rendered more hooks than during the previous render" error when
  // the component transitions from the empty state to a populated node.
  // Tab-content-based auto-selection happens later in the render once
  // we know which tabs have data.
  useEffect(() => {
    setActiveTab('response');
  }, [nodeName]);

  const isWaitingNode = waitingInput && waitingInput.node === nodeName;

  if (!nodeState && !trace && !isWaitingNode) {
    return (
      <div className="flex items-center justify-center h-full text-theme-muted text-sm font-body">
        Select a node to view details
      </div>
    );
  }

  // Deduplicate traces by attempt number. Persisted traces only appear
  // after an attempt finishes; when a retry is currently running/waiting,
  // include the live nodeState as a synthetic attempt so the right panel
  // still exposes the attempt switcher immediately.
  const dedupedTraces = (() => {
    const map = new Map<number, any>();
    for (const t of allTraces) map.set(t.attempt, t);
    if (nodeState?.attempt && !map.has(nodeState.attempt)) {
      map.set(nodeState.attempt, {
        node: nodeName,
        attempt: nodeState.attempt,
        status: nodeState.status,
        output: nodeState.output,
        durationMs: nodeState.durationMs,
        cost: nodeState.cost,
        rawResponse: nodeState.streamText,
        activity: nodeState.activity,
        renderedPrompt: nodeState.renderedPrompt,
        inputState: nodeState.inputState,
        toolCalls: [],
        __live: true,
      });
    }
    return Array.from(map.values()).sort((a, b) => a.attempt - b.attempt);
  })();

  const hasMultipleAttempts = dedupedTraces.length > 1;
  const activeTrace = viewAttempt != null
    ? dedupedTraces.find(t => t.attempt === viewAttempt) ?? trace
    : (dedupedTraces.find(t => t.attempt === nodeState?.attempt) ?? trace);

  const status = isWaitingNode ? 'waiting_for_input' : (nodeState?.status ?? activeTrace?.status ?? 'pending');
  const output = viewAttempt != null ? activeTrace?.output : (nodeState?.output ?? activeTrace?.output);

  const cost = viewAttempt != null ? activeTrace?.cost : (() => {
    if (dedupedTraces.length <= 1) return nodeState?.cost ?? activeTrace?.cost;
    let estimated = 0; let actual: number | null = null;
    for (const t of dedupedTraces) {
      if (t.cost) { estimated += t.cost.estimated ?? 0; if (t.cost.actual != null) actual = (actual ?? 0) + t.cost.actual; }
    }
    return estimated > 0 || actual != null ? { estimated, actual } : (nodeState?.cost ?? activeTrace?.cost);
  })();

  const durationMs = viewAttempt != null ? activeTrace?.durationMs : (() => {
    if (dedupedTraces.length <= 1) return nodeState?.durationMs ?? activeTrace?.durationMs;
    let total = 0;
    for (const t of dedupedTraces) total += t.durationMs ?? 0;
    if ((nodeState?.status === 'running' || nodeState?.status === 'waiting_for_input') && nodeState.durationMs != null) {
      total += nodeState.durationMs;
    }
    return total > 0 ? total : (nodeState?.durationMs ?? activeTrace?.durationMs);
  })();

  // Prompt + inputState come from either:
  //   1. The saved trace (available after node completes OR on a prior attempt)
  //   2. The live NodeState populated by the `node_started` SSE event
  //      (available while the node is still running, before the trace is saved)
  // When the user is viewing a prior attempt, always prefer the trace for that attempt.
  const prompt = viewAttempt != null
    ? activeTrace?.renderedPrompt
    : (activeTrace?.renderedPrompt ?? nodeState?.renderedPrompt);
  const streamText = viewAttempt != null ? (activeTrace?.rawResponse ?? '') : (nodeState?.streamText ?? activeTrace?.rawResponse ?? '');
  const activity: ActivityEntry[] = viewAttempt != null ? (activeTrace?.activity ?? []) : (nodeState?.activity ?? activeTrace?.activity ?? []);
  // Persisted tool-call records for this attempt. Rendered as an expandable
  // log so the user can see full input + output per tool invocation, same
  // as the AgentExecutionView's tool log.
  const toolCalls: any[] = activeTrace?.toolCalls ?? [];
  const inputState = viewAttempt != null
    ? activeTrace?.inputState
    : (activeTrace?.inputState ?? nodeState?.inputState);

  const handleSubmit = () => { if (onSubmitInput) onSubmitInput(formData); setFormData({}); };

  const outputJson = output && Object.keys(output).length > 0 ? JSON.stringify(output, null, 2) : null;
  const inputJson = inputState ? JSON.stringify(inputState, null, 2) : null;
  const structuredResponse = !streamText && output ? structuredResponseMarkdown(nodeName, output) : '';

  // Tab availability flags — used for auto-selection and to disable empty tabs.
  const tabHasInput = !!inputJson;
  const tabHasPrompt = !!prompt;
  const tabHasResponse = !!streamText || !!structuredResponse;
  const tabHasOutputs = !!outputJson;

  // Resolve which tab to actually render. If the user's pinned tab
  // (`activeTab`) has content, use it. Otherwise fall through to whatever
  // content IS available in priority order: Response → Outputs → Prompt
  // → Input State. This doubles as the initial "pick the best tab" logic
  // since activeTab resets to 'response' on every node change (via the
  // useEffect above), so the fallback chain runs on the first render of
  // a new node. No state update here — the resolution is recomputed on
  // every render, which is fine.
  const resolvedTab: DataTab = (() => {
    const has = { input: tabHasInput, prompt: tabHasPrompt, response: tabHasResponse, outputs: tabHasOutputs };
    if (activeTab === 'inspector') return activeTrace ? 'inspector' : 'response';
    if (has[activeTab as 'input' | 'prompt' | 'response' | 'outputs']) return activeTab;
    if (has.response) return 'response';
    if (has.outputs) return 'outputs';
    if (has.prompt) return 'prompt';
    if (has.input) return 'input';
    return activeTab;
  })();

  // Strip the trailing JSON block from the response before rendering so
  // it doesn't duplicate the Outputs tab. Live streaming text is passed
  // through unchanged (partial blocks are unsafe to strip mid-stream).
  const responseDisplay = tabHasResponse
    ? (streamText
      ? (status === 'running' ? streamText : stripTrailingJsonBlock(streamText))
      : structuredResponse)
    : '';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-app shrink-0">
        <div>
          <h3 className="font-heading text-sm font-semibold text-theme-primary tracking-wider">{nodeName}</h3>
          <div className="flex items-center gap-3 mt-1">
            <StatusBadge status={status} />
            {(nodeState?.attempt || activeTrace?.attempt) && (nodeState?.attempt ?? activeTrace?.attempt) > 1 && (
              <span className="text-xs text-accent-yellow font-mono">attempt #{viewAttempt ?? nodeState?.attempt ?? activeTrace?.attempt}</span>
            )}
            {durationMs != null && (
              <span className="text-xs text-theme-secondary font-mono">{formatDuration(durationMs)}</span>
            )}
            <CostDisplay cost={cost} />
          </div>
        </div>
      </div>

      {/* Auto-gate banner */}
      {output?.__action && output.__action !== 'continue' && (
        <div className={`px-4 py-2 border-b text-xs font-mono flex items-center gap-2 ${
          output.__action === 'stop' ? 'border-accent-red/50 bg-accent-red/5 text-accent-red' :
          output.__action === 'skip' ? 'border-accent-yellow/50 bg-accent-yellow/5 text-accent-yellow' :
          'border-accent-orange/50 bg-accent-orange/5 text-accent-orange'
        }`}>
          <span className="font-label uppercase tracking-wider font-semibold">
            {output.__action === 'stop' ? 'STOPPED' : output.__action === 'skip' ? 'SKIPPED' : 'CLARIFY'}
          </span>
          {output.__reason && <span className="text-theme-secondary">— {String(output.__reason)}</span>}
        </div>
      )}

      {/* Attempt tabs + "Compare attempts" button when there are >1 */}
      {hasMultipleAttempts && (
        <div className="flex items-center gap-1 px-4 py-2 border-b border-app shrink-0 bg-app-card/50">
          <span className="overline mr-2">Attempt:</span>
          {dedupedTraces.map(t => (
            <button
              key={t.attempt}
              onClick={() => setViewAttempt(t.attempt === nodeState?.attempt ? null : t.attempt)}
              className={`text-[11px] font-mono px-2 py-0.5 rounded-sm border transition-colors cursor-pointer ${
                (viewAttempt === t.attempt || (viewAttempt == null && t.attempt === nodeState?.attempt))
                  ? 'border-accent-blue bg-accent-blue/10 text-accent-blue'
                  : t.status === 'failed' ? 'border-accent-red/30 text-accent-red/70 hover:bg-accent-red/5' : 'border-border text-theme-secondary hover:bg-surface-200'
              }`}
            >
              #{t.attempt}
              {t.__live && <span className="ml-1 text-accent-blue">live</span>}
              {t.status === 'completed' && <span className="ml-1 text-accent-green">✓</span>}
              {t.status === 'failed' && <span className="ml-1 text-accent-red">✗</span>}
            </button>
          ))}
          {dedupedTraces.length >= 2 && (
            <button
              onClick={() => setCompareAttempts([dedupedTraces[0].attempt, dedupedTraces[dedupedTraces.length - 1].attempt])}
              className="ml-auto text-[11px] font-mono px-2 py-0.5 rounded-sm border border-app text-theme-secondary hover:bg-surface-200 transition-colors"
              title="Compare first vs latest attempt's state"
            >
              Compare first ↔ latest
            </button>
          )}
        </div>
      )}

      {/* Content — vertical column with the tabs section flex-filling the
          available space. Activity and Spawned Agents live in a separate
          bounded region at the bottom that scrolls internally if tall so
          they don't compete with the tabs for height. */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* Human input form */}
        {isWaitingNode && (
          <section className="shrink-0 p-4 border-b-2 border-accent-yellow/50 bg-accent-yellow/5">
            <div className="flex items-center gap-2 mb-3">
              <MessageSquare className="w-4 h-4 text-accent-yellow" />
              <h4 className="font-heading text-xs font-semibold text-accent-yellow uppercase tracking-widest">Input Required</h4>
            </div>
            <p className="text-xs text-theme-secondary font-body mb-4 whitespace-pre-wrap">{waitingInput.prompt}</p>
            <div className="space-y-3">
              {waitingInput.fields.map(field => (
                <div key={field.name}>
                  <label className="block overline mb-1">
                    {field.label ?? field.name}{field.required !== false && <span className="text-accent-red ml-0.5">*</span>}
                  </label>
                  {field.type === 'select' && field.options ? (
                    <select className="input w-full text-xs" value={(formData[field.name] as string) ?? ''} onChange={e => setFormData(p => ({ ...p, [field.name]: e.target.value }))}>
                      <option value="">Select...</option>
                      {field.options.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : field.type === 'boolean' ? (
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={!!formData[field.name]} onChange={e => setFormData(p => ({ ...p, [field.name]: e.target.checked }))} className="w-4 h-4 accent-accent-blue" />
                      <span className="text-xs text-theme-secondary">{field.label ?? field.name}</span>
                    </label>
                  ) : field.type === 'text' ? (
                    <textarea className="w-full text-xs resize-none bg-surface-200 border border-accent-blue/30 rounded-sm px-3 py-2 text-theme-primary focus:outline-none focus:border-accent-blue" rows={3} value={(formData[field.name] as string) ?? ''} onChange={e => setFormData(p => ({ ...p, [field.name]: e.target.value }))} />
                  ) : (
                    <input type={field.type === 'number' ? 'number' : 'text'} className="input w-full text-xs" value={(formData[field.name] as string) ?? ''} onChange={e => setFormData(p => ({ ...p, [field.name]: field.type === 'number' ? Number(e.target.value) : e.target.value }))} />
                  )}
                </div>
              ))}
            </div>
            <button onClick={handleSubmit} className="btn-primary w-full mt-4 inline-flex items-center justify-center gap-2 text-xs">
              <Send className="w-3.5 h-3.5" /> Submit
            </button>
          </section>
        )}

        {/* ── Data tabs ──
            Input State / Prompt / Response / Outputs rendered as a tab
            group so only one view is on screen at a time instead of the
            previous vertical stack. Activity and Spawned Agents stay as
            their own collapsible sections below — those are diagnostic
            surfaces rather than primary data views.

            `flex-1 min-h-0` lets the content area fill the remaining
            vertical space of the parent column. The `min-h-0` is what
            lets a flex child actually shrink below its intrinsic size,
            which is what Monaco needs to size its internal scroll
            container correctly via height="100%". */}
        {(tabHasInput || tabHasPrompt || tabHasResponse || tabHasOutputs) && (
          <section className="flex-1 min-h-0 flex flex-col border-b border-app">
            {/* Tab bar */}
            <div className="shrink-0 flex items-center border-b border-app bg-app-card/50">
              <TabButton
                label="Input State"
                active={resolvedTab === 'input'}
                disabled={!tabHasInput}
                onClick={() => setActiveTab('input')}
              />
              <TabButton
                label="Prompt"
                active={resolvedTab === 'prompt'}
                disabled={!tabHasPrompt}
                onClick={() => setActiveTab('prompt')}
              />
              <TabButton
                label={status === 'running' && tabHasResponse ? 'Live Output' : 'Response'}
                active={resolvedTab === 'response'}
                disabled={!tabHasResponse}
                onClick={() => setActiveTab('response')}
                live={status === 'running' && tabHasResponse}
              />
              <TabButton
                label="Outputs"
                active={resolvedTab === 'outputs'}
                disabled={!tabHasOutputs}
                onClick={() => setActiveTab('outputs')}
              />
              <TabButton
                label="Inspector"
                active={resolvedTab === 'inspector'}
                disabled={!activeTrace}
                onClick={() => setActiveTab('inspector')}
              />
              {/* Expand-to-fullscreen button for the active tab — lives
                  on the right edge of the tab bar. */}
              <div className="flex-1" />
              <div className="pr-2 flex items-center gap-0.5">
                {resolvedTab === 'input' && tabHasInput && inputJson && (
                  <>
                    <CopyButton text={inputJson} />
                    <DownloadButton content={inputJson} filename={`${nodeName}-input.json`} />
                    <ExpandButton onClick={() => setExpandViewer({ title: `${nodeName} — Input State`, content: inputJson, mode: 'json' })} />
                  </>
                )}
                {resolvedTab === 'prompt' && tabHasPrompt && prompt && (
                  <>
                    <CopyButton text={prompt} />
                    <DownloadButton content={prompt} filename={`${nodeName}-prompt.txt`} mime="text/plain" />
                    <ExpandButton onClick={() => setExpandViewer({ title: `${nodeName} — Prompt`, content: prompt, mode: 'raw' })} />
                  </>
                )}
                {resolvedTab === 'response' && tabHasResponse && (
                  <>
                    <CopyButton text={responseDisplay} />
                    <DownloadButton content={responseDisplay} filename={`${nodeName}-response.md`} mime="text/markdown" />
                    <ExpandButton onClick={() => setExpandViewer({ title: `${nodeName} — Response`, content: responseDisplay, mode: 'markdown' })} />
                  </>
                )}
                {resolvedTab === 'outputs' && tabHasOutputs && outputJson && (
                  <>
                    <CopyButton text={outputJson} />
                    <DownloadButton content={outputJson} filename={`${nodeName}-outputs.json`} />
                    <ExpandButton onClick={() => setExpandViewer({ title: `${nodeName} — Outputs`, content: outputJson, mode: 'json' })} />
                  </>
                )}
              </div>
            </div>

            {/* Tab content — flex-1 min-h-0 so its children can use
                height="100%" and fill the pane. The padding is inside
                a full-height wrapper, not the flex child itself, so the
                border doesn't wrap the padding. */}
            <div className="flex-1 min-h-0 p-3">
              {resolvedTab === 'input' && inputJson && (
                <InlineEditor value={inputJson} language="json" fill />
              )}
              {resolvedTab === 'prompt' && prompt && (
                <div className="h-full min-h-0 flex flex-col gap-2">
                  {/* Template bindings collapsible above the prompt — lets
                      the user see which {{state.foo}} resolved to what
                      without jumping to the Inspector tab. */}
                  {activeTrace?.templateBindings && activeTrace.templateBindings.length > 0 && (
                    <div className="shrink-0">
                      <TemplateBindingsTable bindings={activeTrace.templateBindings as any} />
                    </div>
                  )}
                  <div className="flex-1 min-h-0">
                    <InlineEditor value={prompt} language="plaintext" fill />
                  </div>
                </div>
              )}
              {resolvedTab === 'response' && tabHasResponse && (
                status === 'running'
                  ? <div className="h-full min-h-0 overflow-auto"><StreamOutput text={responseDisplay} isLive={true} /></div>
                  : <InlineMarkdown content={responseDisplay} fill />
              )}
              {resolvedTab === 'outputs' && outputJson && (
                <InlineEditor value={outputJson} language="json" fill />
              )}
              {resolvedTab === 'inspector' && activeTrace && (
                <div className="p-3 overflow-auto h-full">
                  <NodeInspector trace={activeTrace as any} contextEngineEnabled={contextEngineEnabled} />
                </div>
              )}
              {/* Empty-state fallback: when every tab is empty (pending
                  node that hasn't started yet), show a placeholder. */}
              {!tabHasInput && !tabHasPrompt && !tabHasResponse && !tabHasOutputs && (
                <div className="text-[11px] text-theme-muted font-mono py-6 text-center">
                  No data yet — node has not started.
                </div>
              )}
            </div>
          </section>
        )}

        {/* Bottom secondary region — tool calls + activity + spawned agents. Bounded
            max-height with its own scroll so it doesn't compete with the
            tabs for vertical space. Hidden entirely when all are empty. */}
        {(toolCalls.length > 0 || activity.length > 0 || spawnedChildren.length > 0 || descendantsMode) && (
          <div className="shrink-0 overflow-auto" style={{ maxHeight: '40%' }}>
            {/* Tool calls — expandable per-row I/O, same component as the
                AgentExecutionView panel. */}
            {toolCalls.length > 0 && (
              <Section title={`Tool Calls (${toolCalls.length})`} defaultOpen={false}>
                <ToolCallLog calls={toolCalls} title="Tool Calls" />
              </Section>
            )}

            {/* Thinking — extract any activity entries tagged `thinking` so
                users can see the agent's internal reasoning between tool
                calls without hunting through the full activity stream. */}
            {(() => {
              const thinkingEntries = (activity as any[]).filter((e) =>
                e.type === 'thinking' || (typeof e.content === 'string' && e.content.includes('[thinking]')),
              );
              if (thinkingEntries.length === 0) return null;
              return (
                <Section title={`Thinking (${thinkingEntries.length})`} defaultOpen={false}>
                  <div className="space-y-2 max-h-64 overflow-auto">
                    {thinkingEntries.map((e: any, i: number) => (
                      <div key={i} className="border-l-2 border-accent-blue/30 pl-2 py-1 bg-accent-blue/5 rounded-sm">
                        <div className="text-[10px] font-mono text-theme-subtle mb-0.5">
                          {e.tool ?? 'assistant'}
                        </div>
                        <div className="text-[11px] font-body text-theme-secondary whitespace-pre-wrap">
                          {e.content}
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>
              );
            })()}

            {/* Activity log */}
            {activity.length > 0 && (
              <Section title={`Activity (${activity.length})`} defaultOpen={false}>
                <div className="space-y-1 max-h-48 overflow-auto">
                  {activity.map((entry, i) => (
                    <div key={i} className="flex items-start gap-2 text-[11px]">
                      {entry.type === 'tool_start'
                        ? <Wrench className="w-3 h-3 text-accent-blue mt-0.5 shrink-0" />
                        : <CheckCircle className="w-3 h-3 text-accent-green mt-0.5 shrink-0" />
                      }
                      <div className="min-w-0">
                        {entry.tool && <span className="font-mono text-accent-cyan mr-1">{entry.tool}</span>}
                        <span className="text-theme-secondary">{entry.content}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Spawned Agents — children whose parent caller is this node.
                When descendants mode is on, also show any grandchild/deeper
                rows under their respective branches grouped by direct parent. */}
            {(spawnedChildren.length > 0 || descendantsMode) && (
              <Section
                title={`Spawned Agents${spawnedChildren.length > 0 ? ` (${spawnedChildren.length})` : ''}`}
                defaultOpen={true}
              >
                <SpawnedAgentsPanel
                  directChildren={spawnedChildren}
                  allChildren={allChildren}
                  descendantsMode={descendantsMode}
                  onToggleDescendants={onToggleDescendants}
                />
              </Section>
            )}
          </div>
        )}
      </div>

      {/* Fullscreen viewer */}
      {expandViewer && (
        <ContentViewer
          title={expandViewer.title}
          content={expandViewer.content}
          defaultMode={expandViewer.mode}
          onClose={() => setExpandViewer(null)}
        />
      )}

      {/* Attempt-to-attempt state diff modal */}
      {compareAttempts && (() => {
        const [a1, a2] = compareAttempts;
        const t1 = dedupedTraces.find((t) => t.attempt === a1);
        const t2 = dedupedTraces.find((t) => t.attempt === a2);
        if (!t1 || !t2) { setCompareAttempts(null); return null; }
        // Combine inputState + output into a single snapshot per attempt so
        // the diff reflects the full post-node state the downstream saw.
        const snap = (t: typeof t1) => ({ ...(t.inputState ?? {}), ...(t.output ?? {}) });
        return (
          <StateDiffModal
            titleLeft={`attempt #${a1}`}
            titleRight={`attempt #${a2}`}
            left={snap(t1)}
            right={snap(t2)}
            onClose={() => setCompareAttempts(null)}
          />
        );
      })()}
    </div>
  );
}

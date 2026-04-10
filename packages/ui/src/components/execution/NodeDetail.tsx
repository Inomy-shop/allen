import { useState } from 'react';
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

// ── Inline Monaco (read-only, compact) ──

function InlineEditor({ value, language, maxHeight = 200 }: { value: string; language: string; maxHeight?: number }) {
  const colorMode = useSettingsStore(s => s.colorMode);
  const theme = resolveColorMode(colorMode) === 'light' ? 'vs' : 'vs-dark';
  const lineCount = value.split('\n').length;
  const height = Math.min(Math.max(lineCount * 19 + 16, 60), maxHeight);

  return (
    <div className="rounded-md overflow-hidden border border-border/30">
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
          wordWrap: language === 'plaintext' || language === 'markdown' ? 'on' : 'off',
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

function InlineMarkdown({ content, maxHeight = 200 }: { content: string; maxHeight?: number }) {
  return (
    <div className="rounded-md border border-border/30 bg-surface-100/50 p-3 overflow-auto prose-flowforge" style={{ maxHeight }}>
      <div className="text-xs text-theme-secondary leading-relaxed">
        {renderMarkdown(content)}
      </div>
    </div>
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
    <section className="border-b border-border/30">
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
}

// ── Main Component ──

export default function NodeDetail({ nodeName, nodeState, trace, allTraces = [], waitingInput, onSubmitInput }: Props) {
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [viewAttempt, setViewAttempt] = useState<number | null>(null);
  const [expandViewer, setExpandViewer] = useState<{ title: string; content: string; mode?: ViewerMode } | null>(null);

  const isWaitingNode = waitingInput && waitingInput.node === nodeName;

  if (!nodeState && !trace && !isWaitingNode) {
    return (
      <div className="flex items-center justify-center h-full text-theme-muted text-sm font-body">
        Select a node to view details
      </div>
    );
  }

  // Deduplicate traces by attempt number
  const dedupedTraces = (() => {
    const map = new Map<number, any>();
    for (const t of allTraces) map.set(t.attempt, t);
    return Array.from(map.values()).sort((a, b) => a.attempt - b.attempt);
  })();

  const hasMultipleAttempts = dedupedTraces.length > 1;
  const activeTrace = viewAttempt != null
    ? dedupedTraces.find(t => t.attempt === viewAttempt) ?? trace
    : trace;

  const status = nodeState?.status ?? activeTrace?.status ?? (isWaitingNode ? 'waiting_for_input' : 'pending');
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
    return total > 0 ? total : (nodeState?.durationMs ?? activeTrace?.durationMs);
  })();

  const prompt = activeTrace?.renderedPrompt;
  const streamText = viewAttempt != null ? (activeTrace?.rawResponse ?? '') : (nodeState?.streamText ?? activeTrace?.rawResponse ?? '');
  const activity: ActivityEntry[] = viewAttempt != null ? (activeTrace?.activity ?? []) : (nodeState?.activity ?? activeTrace?.activity ?? []);
  const inputState = activeTrace?.inputState;

  const handleSubmit = () => { if (onSubmitInput) onSubmitInput(formData); setFormData({}); };

  const outputJson = output && Object.keys(output).length > 0 ? JSON.stringify(output, null, 2) : null;
  const inputJson = inputState ? JSON.stringify(inputState, null, 2) : null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 shrink-0">
        <div>
          <h3 className="font-heading text-sm font-semibold text-theme-primary tracking-wider">{nodeName}</h3>
          <div className="flex items-center gap-3 mt-1">
            <StatusBadge status={status} />
            {nodeState?.attempt && nodeState.attempt > 1 && (
              <span className="text-xs text-accent-yellow font-mono">attempt #{viewAttempt ?? nodeState.attempt}</span>
            )}
            {durationMs != null && (
              <span className="text-xs text-theme-secondary font-mono">{(durationMs / 1000).toFixed(1)}s</span>
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

      {/* Attempt tabs */}
      {hasMultipleAttempts && (
        <div className="flex items-center gap-1 px-4 py-2 border-b border-border/50 shrink-0 bg-surface-50/50">
          <span className="text-[10px] font-label uppercase tracking-wider text-theme-muted mr-2">Attempt:</span>
          {dedupedTraces.map(t => (
            <button
              key={t.attempt}
              onClick={() => setViewAttempt(t.attempt === (trace?.attempt) && viewAttempt == null ? null : t.attempt)}
              className={`text-[11px] font-mono px-2 py-0.5 rounded-sm border transition-colors cursor-pointer ${
                (viewAttempt === t.attempt || (viewAttempt == null && t.attempt === trace?.attempt))
                  ? 'border-accent-blue bg-accent-blue/10 text-accent-blue'
                  : t.status === 'failed' ? 'border-accent-red/30 text-accent-red/70 hover:bg-accent-red/5' : 'border-border text-theme-secondary hover:bg-surface-200'
              }`}
            >
              #{t.attempt}
              {t.status === 'completed' && <span className="ml-1 text-accent-green">✓</span>}
              {t.status === 'failed' && <span className="ml-1 text-accent-red">✗</span>}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {/* Human input form */}
        {isWaitingNode && (
          <section className="p-4 border-b-2 border-accent-yellow/50 bg-accent-yellow/5">
            <div className="flex items-center gap-2 mb-3">
              <MessageSquare className="w-4 h-4 text-accent-yellow" />
              <h4 className="font-heading text-xs font-semibold text-accent-yellow uppercase tracking-widest">Input Required</h4>
            </div>
            <p className="text-xs text-theme-secondary font-body mb-4 whitespace-pre-wrap">{waitingInput.prompt}</p>
            <div className="space-y-3">
              {waitingInput.fields.map(field => (
                <div key={field.name}>
                  <label className="block text-[11px] font-label uppercase tracking-wider text-theme-secondary mb-1">
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

        {/* Input State — Monaco JSON editor */}
        {inputJson && (
          <Section
            title="Input State"
            defaultOpen={false}
            expandContent={inputJson}
            onExpand={() => setExpandViewer({ title: `${nodeName} — Input State`, content: inputJson, mode: 'json' })}
          >
            <InlineEditor value={inputJson} language="json" maxHeight={180} />
          </Section>
        )}

        {/* Prompt — Monaco with markdown-like display */}
        {prompt && (
          <Section
            title="Prompt"
            defaultOpen={true}
            expandContent={prompt}
            onExpand={() => setExpandViewer({ title: `${nodeName} — Prompt`, content: prompt, mode: 'raw' })}
          >
            <InlineEditor value={prompt} language="plaintext" maxHeight={250} />
          </Section>
        )}

        {/* Response — rendered markdown */}
        {streamText && (
          <Section
            title={status === 'running' ? 'Live Output' : 'Response'}
            defaultOpen={true}
            expandContent={streamText}
            onExpand={() => setExpandViewer({ title: `${nodeName} — Response`, content: streamText, mode: 'markdown' })}
          >
            {status === 'running' ? (
              <StreamOutput text={streamText} isLive={true} />
            ) : (
              <InlineMarkdown content={streamText} maxHeight={300} />
            )}
          </Section>
        )}

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

        {/* Outputs — Monaco JSON editor */}
        {outputJson && (
          <Section
            title="Outputs"
            defaultOpen={true}
            expandContent={outputJson}
            onExpand={() => setExpandViewer({ title: `${nodeName} — Outputs`, content: outputJson, mode: 'json' })}
          >
            <InlineEditor value={outputJson} language="json" maxHeight={300} />
          </Section>
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
    </div>
  );
}

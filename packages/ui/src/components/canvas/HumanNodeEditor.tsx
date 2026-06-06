import { useState } from 'react';
import { Plus, X, ChevronDown, MessageSquareMore } from 'lucide-react';
import Select from '../common/Select';

/**
 * Editor for human (HITL) nodes. Covers both the legacy `prompt` + `fields`
 * shape and the richer `human:` presentation contract (kind/widget/title/
 * summary/question/highlights/evidence/actions) defined by HumanPresentation
 * in packages/engine/src/types.ts. The presentation block is what drives
 * approval/escalation gates in the example workflows.
 */

interface HumanField {
  name: string;
  type: string;
  label?: string;
  required?: boolean;
  options?: string[];
}

interface HumanEvidence {
  label: string;
  type?: string;
  value?: string;
  url?: string;
}

interface HumanActionRoute {
  type: 'continue' | 'retry' | 'end';
  targetNode?: string;
}

interface HumanAction {
  id: string;
  label?: string;
  intent?: string;
  feedbackRequired?: boolean;
  feedbackOptional?: boolean;
  warning?: string;
  route?: HumanActionRoute;
}

interface HumanPresentation {
  kind?: 'clarify' | 'review' | 'recover';
  widget?: 'dynamic_form' | 'approval_gate' | 'retry_exhausted_gate' | 'escalation_gate';
  title?: string;
  summary?: string;
  question?: string;
  highlights?: string[];
  evidence?: HumanEvidence[];
  actions?: HumanAction[];
}

interface Props {
  data: Record<string, any>;
  update: (key: string, value: any) => void;
  /** All node ids in the graph — used to populate action-route targets. */
  nodeIds: string[];
}

const FIELD_TYPES = ['string', 'text', 'textarea', 'boolean', 'number', 'select'];
const EVIDENCE_TYPES = ['text', 'artifact', 'url', 'diff', 'log'];
const INTENTS = ['submit', 'approve', 'request_changes', 'reject', 'retry', 'override', 'abandon'];
const ROUTE_TYPES = ['continue', 'retry', 'end'];

export default function HumanNodeEditor({ data, update, nodeIds }: Props) {
  const [showPresentation, setShowPresentation] = useState(false);

  // ── Legacy fields ──
  const fields: HumanField[] = (data.fields as HumanField[]) ?? [];
  const setFields = (next: HumanField[]) => update('fields', next);
  const addField = () => setFields([...fields, { name: '', type: 'string', label: '', required: false }]);
  const updateField = (idx: number, key: keyof HumanField, value: any) =>
    setFields(fields.map((f, i) => (i === idx ? { ...f, [key]: value } : f)));
  const removeField = (idx: number) => setFields(fields.filter((_, i) => i !== idx));

  // ── Presentation block ──
  const human: HumanPresentation = (data.human as HumanPresentation) ?? {};
  const hasPresentation = !!data.human;
  const setHuman = (patch: Partial<HumanPresentation>) => {
    const next = { ...human, ...patch };
    // Drop empty optional fields so the YAML stays clean.
    for (const k of Object.keys(next) as (keyof HumanPresentation)[]) {
      const v = next[k];
      if (v === '' || v === undefined || (Array.isArray(v) && v.length === 0)) delete next[k];
    }
    update('human', Object.keys(next).length > 0 ? next : undefined);
  };

  const highlights = human.highlights ?? [];
  const evidence = human.evidence ?? [];
  const actions = human.actions ?? [];

  return (
    <>
      <div>
        <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Prompt</label>
        <textarea className="input w-full text-xs h-20 resize-none" value={(data.prompt as string) ?? ''} onChange={e => update('prompt', e.target.value)} placeholder="What should the user see?" />
      </div>

      {/* Fields */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-xs font-label font-medium text-theme-secondary uppercase tracking-wider">Fields</label>
          <button onClick={addField} className="btn-ghost text-xs p-1 text-accent-blue" title="Add field">
            <Plus className="w-3 h-3" />
          </button>
        </div>
        <div className="space-y-2">
          {fields.map((field, idx) => (
            <div key={idx} className="bg-surface-200/80 rounded-sm p-2 space-y-1.5 border border-app">
              <div className="flex items-center gap-1">
                <input className="input flex-1 text-xs" placeholder="name" value={field.name} onChange={e => updateField(idx, 'name', e.target.value)} />
                <Select
                  className="w-24"
                  value={field.type}
                  onChange={(value) => updateField(idx, 'type', value)}
                  searchable={false}
                  options={FIELD_TYPES.map(t => ({ value: t, label: t }))}
                />
                <button onClick={() => removeField(idx)} className="text-theme-muted hover:text-accent-red p-0.5 transition-colors" title="Remove field">
                  <X className="w-3 h-3" />
                </button>
              </div>
              <input className="input w-full text-xs" placeholder="Label" value={field.label ?? ''} onChange={e => updateField(idx, 'label', e.target.value)} />
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={!!field.required} onChange={e => updateField(idx, 'required', e.target.checked)} className="w-3 h-3 rounded-sm bg-surface border-border accent-accent-blue" />
                <span className="overline">Required</span>
              </div>
              {field.type === 'select' && (
                <input className="input w-full text-xs" placeholder="Options (comma-separated)" value={(field.options ?? []).join(', ')} onChange={e => updateField(idx, 'options', e.target.value.split(',').map(s => s.trim()).filter(Boolean))} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Timeout action */}
      <div>
        <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">On timeout</label>
        <Select
          value={(data.timeout_action as string) ?? ''}
          onChange={(value) => update('timeout_action', value || undefined)}
          searchable={false}
          options={[
            { value: '', label: 'Default (wait)' },
            { value: 'cancel', label: 'cancel', sublabel: 'fail the node when the timeout elapses' },
            { value: 'default', label: 'default', sublabel: 'apply field defaults and continue' },
          ]}
        />
      </div>

      {/* ── Presentation (HITL) ── */}
      <div className={`rounded border bg-app-muted/40 overflow-hidden transition-colors ${showPresentation ? 'border-app-strong' : 'border-app'}`}>
        <button type="button" onClick={() => setShowPresentation(v => !v)} className="flex items-center justify-between w-full gap-2 px-3 py-2.5 text-left transition-colors hover:bg-app-muted">
          <span className="flex items-center gap-2 min-w-0">
            <MessageSquareMore className="w-3.5 h-3.5 text-theme-muted shrink-0" />
            <span className="text-xs font-medium text-theme-secondary truncate">Presentation (approval / escalation gate)</span>
            {hasPresentation && (
              <span className="text-[8.5px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-accent-blue/10 text-accent-blue shrink-0">on</span>
            )}
          </span>
          <ChevronDown className={`w-3.5 h-3.5 text-theme-muted shrink-0 transition-transform ${showPresentation ? 'rotate-180' : ''}`} />
        </button>

        {showPresentation && (
          <div className="px-3 pb-3 pt-3 space-y-3 border-t border-app">
            <p className="text-[10px] text-theme-subtle font-body leading-relaxed">
              Rich human-in-the-loop contract. <span className="font-mono">kind</span> + <span className="font-mono">widget</span> pick
              how the pause is rendered; <span className="font-mono">actions</span> define the buttons and where each routes.
            </p>

            <div>
              <label className="block overline mb-1">Kind</label>
              <Select
                value={human.kind ?? ''}
                onChange={(value) => setHuman({ kind: (value || undefined) as HumanPresentation['kind'] })}
                searchable={false}
                options={[
                  { value: '', label: 'None' },
                  { value: 'clarify', label: 'clarify', sublabel: 'ask the user for missing info' },
                  { value: 'review', label: 'review', sublabel: 'approve / request changes' },
                  { value: 'recover', label: 'recover', sublabel: 'recover from a failure / exhausted retries' },
                ]}
              />
            </div>

            <div>
              <label className="block overline mb-1">Widget</label>
              <Select
                value={human.widget ?? ''}
                onChange={(value) => setHuman({ widget: (value || undefined) as HumanPresentation['widget'] })}
                searchable={false}
                options={[
                  { value: '', label: 'Auto' },
                  { value: 'dynamic_form', label: 'dynamic_form' },
                  { value: 'approval_gate', label: 'approval_gate' },
                  { value: 'retry_exhausted_gate', label: 'retry_exhausted_gate' },
                  { value: 'escalation_gate', label: 'escalation_gate' },
                ]}
              />
            </div>

            <div>
              <label className="block overline mb-1">Title</label>
              <input className="input w-full text-xs" value={human.title ?? ''} onChange={e => setHuman({ title: e.target.value })} placeholder="Short heading" />
            </div>
            <div>
              <label className="block overline mb-1">Summary</label>
              <textarea className="input w-full text-xs h-16 resize-none" value={human.summary ?? ''} onChange={e => setHuman({ summary: e.target.value })} placeholder="Context shown above the question" />
            </div>
            <div>
              <label className="block overline mb-1">Question</label>
              <textarea className="input w-full text-xs h-14 resize-none" value={human.question ?? ''} onChange={e => setHuman({ question: e.target.value })} placeholder="The decision the user must make" />
            </div>

            {/* Highlights */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block overline">Highlights</label>
                <button onClick={() => setHuman({ highlights: [...highlights, ''] })} className="btn-ghost text-xs p-1 text-accent-blue" title="Add highlight">
                  <Plus className="w-3 h-3" />
                </button>
              </div>
              <div className="space-y-1">
                {highlights.map((h, idx) => (
                  <div key={idx} className="flex items-center gap-1">
                    <input className="input flex-1 text-xs" value={h} onChange={e => setHuman({ highlights: highlights.map((x, i) => i === idx ? e.target.value : x) })} placeholder="key point" />
                    <button onClick={() => setHuman({ highlights: highlights.filter((_, i) => i !== idx) })} className="text-theme-muted hover:text-accent-red p-0.5" title="Remove">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Evidence */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block overline">Evidence</label>
                <button onClick={() => setHuman({ evidence: [...evidence, { label: '', type: 'text' }] })} className="btn-ghost text-xs p-1 text-accent-blue" title="Add evidence">
                  <Plus className="w-3 h-3" />
                </button>
              </div>
              <div className="space-y-2">
                {evidence.map((ev, idx) => {
                  const setEv = (patch: Partial<HumanEvidence>) =>
                    setHuman({ evidence: evidence.map((x, i) => i === idx ? { ...x, ...patch } : x) });
                  return (
                    <div key={idx} className="bg-surface-200/80 rounded-sm p-2 space-y-1.5 border border-app">
                      <div className="flex items-center gap-1">
                        <input className="input flex-1 text-xs" placeholder="label" value={ev.label} onChange={e => setEv({ label: e.target.value })} />
                        <Select
                          className="w-24"
                          value={ev.type ?? 'text'}
                          onChange={(value) => setEv({ type: value })}
                          searchable={false}
                          options={EVIDENCE_TYPES.map(t => ({ value: t, label: t }))}
                        />
                        <button onClick={() => setHuman({ evidence: evidence.filter((_, i) => i !== idx) })} className="text-theme-muted hover:text-accent-red p-0.5" title="Remove">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                      {ev.type === 'url' ? (
                        <input className="input w-full text-xs font-mono" placeholder="url" value={ev.url ?? ''} onChange={e => setEv({ url: e.target.value })} />
                      ) : (
                        <textarea className="input w-full text-xs h-12 resize-none font-mono" placeholder="value (supports {{state}})" value={ev.value ?? ''} onChange={e => setEv({ value: e.target.value })} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Actions */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block overline">Actions</label>
                <button onClick={() => setHuman({ actions: [...actions, { id: '' }] })} className="btn-ghost text-xs p-1 text-accent-blue" title="Add action">
                  <Plus className="w-3 h-3" />
                </button>
              </div>
              <div className="space-y-2">
                {actions.map((action, idx) => {
                  const setAction = (patch: Partial<HumanAction>) =>
                    setHuman({ actions: actions.map((x, i) => i === idx ? { ...x, ...patch } : x) });
                  const route = action.route ?? { type: 'continue' as const };
                  const setRoute = (patch: Partial<HumanActionRoute>) =>
                    setAction({ route: { ...route, ...patch } });
                  return (
                    <div key={idx} className="bg-surface-200/80 rounded-sm p-2 space-y-1.5 border border-app">
                      <div className="flex items-center gap-1">
                        <input className="input flex-1 text-xs font-mono" placeholder="id (e.g. approve)" value={action.id} onChange={e => setAction({ id: e.target.value })} />
                        <button onClick={() => setHuman({ actions: actions.filter((_, i) => i !== idx) })} className="text-theme-muted hover:text-accent-red p-0.5" title="Remove">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                      <input className="input w-full text-xs" placeholder="button label" value={action.label ?? ''} onChange={e => setAction({ label: e.target.value })} />
                      <Select
                        value={action.intent ?? ''}
                        onChange={(value) => setAction({ intent: value || undefined })}
                        searchable={false}
                        options={[{ value: '', label: 'intent…' }, ...INTENTS.map(i => ({ value: i, label: i }))]}
                      />
                      <div className="flex items-center gap-3">
                        <label className="flex items-center gap-1.5">
                          <input type="checkbox" checked={!!action.feedbackRequired} onChange={e => setAction({ feedbackRequired: e.target.checked || undefined })} className="w-3 h-3 rounded-sm bg-surface border-border accent-accent-blue" />
                          <span className="overline">Feedback req.</span>
                        </label>
                        <label className="flex items-center gap-1.5">
                          <input type="checkbox" checked={!!action.feedbackOptional} onChange={e => setAction({ feedbackOptional: e.target.checked || undefined })} className="w-3 h-3 rounded-sm bg-surface border-border accent-accent-blue" />
                          <span className="overline">Feedback opt.</span>
                        </label>
                      </div>
                      <input className="input w-full text-xs" placeholder="warning (optional)" value={action.warning ?? ''} onChange={e => setAction({ warning: e.target.value || undefined })} />
                      {/* Route */}
                      <div className="flex items-center gap-1">
                        <Select
                          className="w-28"
                          value={route.type}
                          onChange={(value) => setRoute({ type: value as HumanActionRoute['type'] })}
                          searchable={false}
                          options={ROUTE_TYPES.map(t => ({ value: t, label: t }))}
                        />
                        {(route.type === 'retry' || route.type === 'continue') && (
                          <Select
                            className="flex-1"
                            value={route.targetNode ?? ''}
                            onChange={(value) => setRoute({ targetNode: value || undefined })}
                            placeholder="target node…"
                            options={[{ value: '', label: '(default next)' }, ...nodeIds.map(id => ({ value: id, label: id }))]}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

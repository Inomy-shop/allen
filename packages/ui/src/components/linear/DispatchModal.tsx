import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, ChevronDown, Crown, FolderGit2, GitBranch, Loader2, Play,
  Search, Sparkles, Users, X,
} from 'lucide-react';
import type { AgentOption, TeamOption } from '../agents/AgentAssignDropdown';
import { workflows as wfApi } from '../../services/api';

interface Repo {
  _id: string;
  name: string;
  path?: string;
}

export interface WorkflowOption {
  _id: string;
  name: string;
  description?: string;
  /** Parsed input schema if available — used to render extra fields. */
  parsed?: { input?: Record<string, { type?: string; required?: boolean }> };
}

export type DispatchTarget =
  | { kind: 'agent'; name: string }
  | { kind: 'team-lead'; teamName: string; agentName: string }
  | { kind: 'workflow'; workflowId: string; workflowName: string };

export interface DispatchModalProps {
  open: boolean;
  issue: {
    id: string;
    identifier: string;
    title: string;
    description?: string | null;
  };
  currentAgent: string | null;
  agents: AgentOption[];
  teams: TeamOption[];
  workflows?: WorkflowOption[];
  workflowsLoading?: boolean;
  repos: Repo[];
  reposLoading: boolean;
  onClose: () => void;
  onSubmit: (args: {
    target: DispatchTarget;
    repoId: string;
    extraInstructions: string;
    promptTemplate?: string;
    /** Schema-driven input map when target is a workflow. Already
     *  type-cast (string/number/boolean) per the workflow's input schema. */
    workflowInput?: Record<string, unknown>;
  }) => Promise<void>;
}

// ── Internal types for the searchable picker ─────────────────────────────

type PickerEntry =
  | {
      kind: 'team-lead';
      key: string;
      teamName: string;
      teamLabel: string;
      agentName: string;
      agentDisplay: string;
      searchHaystack: string;
    }
  | {
      kind: 'agent';
      key: string;
      agentName: string;
      agentDisplay: string;
      teamLabel?: string;
      isLead?: boolean;
      searchHaystack: string;
    }
  | {
      kind: 'workflow';
      key: string;
      workflowId: string;
      workflowName: string;
      description?: string;
      searchHaystack: string;
    };

interface PickerSection {
  label: string;
  entries: PickerEntry[];
}

function buildAgentDispatchPromptTemplate(issue: DispatchModalProps['issue'], extraInstructions: string): string {
  const header = `You've been assigned Linear ticket ${issue.identifier}: ${issue.title}.`;
  const body = issue.description ? `\n\n---\n${issue.description}` : '';
  const extra = extraInstructions.trim() ? `\n\n---\nAdditional instructions:\n${extraInstructions.trim()}` : '';
  return `${header}${body}${extra}\n\nWORKSPACE CONTEXT:\n- Worktree path: {{worktreePath}}\n- Repository path: {{repoPath}}\n\nWork inside this workspace. Start by skimming the repo structure, then plan your approach before editing code. Ask clarifying questions if anything is ambiguous.`;
}

/**
 * Dispatch picker — supports three target kinds in a searchable grouped
 * dropdown (Team leads / Agents per team / Workflows). The parent
 * decides which API to call based on the chosen target kind.
 */
export default function DispatchModal({
  open, issue, currentAgent, agents, teams, workflows, workflowsLoading,
  repos, reposLoading, onClose, onSubmit,
}: DispatchModalProps) {
  // Encoded as `<kind>:<id>` so the picker round-trips a single string.
  const [targetKey, setTargetKey] = useState<string>('');
  const [repoId, setRepoId] = useState<string>('');
  const [extra, setExtra] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Workflow-target state: when a workflow is selected, fetch its full
  // record (parsed.input schema) and collect per-field values.
  const [fullWorkflow, setFullWorkflow] = useState<any | null>(null);
  const [loadingWorkflow, setLoadingWorkflow] = useState(false);
  const [workflowInput, setWorkflowInput] = useState<Record<string, string>>({});
  const [promptTemplate, setPromptTemplate] = useState('');
  const [promptCustomized, setPromptCustomized] = useState(false);

  // Build all picker sections once. Each entry carries a denormalized
  // searchHaystack so filtering matches across team / agent / workflow
  // names + descriptions in one pass.
  const sections = useMemo<PickerSection[]>(() => {
    const teamLeads = new Map<string, AgentOption>();
    const byTeam = new Map<string, AgentOption[]>();
    const independent: AgentOption[] = [];
    for (const a of agents ?? []) {
      const t = a.teamName;
      if (!t) {
        independent.push(a);
        continue;
      }
      if (a.teamRole === 'lead') teamLeads.set(t, a);
      if (!byTeam.has(t)) byTeam.set(t, []);
      byTeam.get(t)!.push(a);
    }
    const teamLabel = (name: string) => teams.find(t => t.name === name)?.displayName ?? name;
    const teamSections = Array.from(byTeam.entries())
      .sort((a, b) => teamLabel(a[0]).localeCompare(teamLabel(b[0])))
      .map(([name, list]) => ({
        teamName: name,
        teamLabel: teamLabel(name),
        lead: teamLeads.get(name) ?? null,
        members: list.slice().sort((a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name)),
      }));

    const out: PickerSection[] = [];

    const leadEntries: PickerEntry[] = teamSections
      .filter(s => s.lead)
      .map(s => ({
        kind: 'team-lead',
        key: `team-lead:${s.teamName}`,
        teamName: s.teamName,
        teamLabel: s.teamLabel,
        agentName: s.lead!.name,
        agentDisplay: s.lead!.displayName ?? s.lead!.name,
        searchHaystack: [s.teamLabel, s.teamName, s.lead!.displayName, s.lead!.name].filter(Boolean).join(' ').toLowerCase(),
      }));
    if (leadEntries.length > 0) {
      out.push({ label: 'Team leads (delegate to lead)', entries: leadEntries });
    }

    for (const s of teamSections) {
      const entries: PickerEntry[] = s.members.map(a => ({
        kind: 'agent',
        key: `agent:${a.name}`,
        agentName: a.name,
        agentDisplay: a.displayName ?? a.name,
        teamLabel: s.teamLabel,
        isLead: a.teamRole === 'lead',
        searchHaystack: [a.name, a.displayName, s.teamLabel, s.teamName].filter(Boolean).join(' ').toLowerCase(),
      }));
      out.push({ label: `Agents · ${s.teamLabel}`, entries });
    }

    if (independent.length > 0) {
      const entries: PickerEntry[] = independent
        .sort((a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name))
        .map(a => ({
          kind: 'agent',
          key: `agent:${a.name}`,
          agentName: a.name,
          agentDisplay: a.displayName ?? a.name,
          searchHaystack: [a.name, a.displayName, 'unassigned'].filter(Boolean).join(' ').toLowerCase(),
        }));
      out.push({ label: 'Agents · Unassigned', entries });
    }

    if (workflows && workflows.length > 0) {
      const entries: PickerEntry[] = workflows.map(w => ({
        kind: 'workflow',
        key: `workflow:${w._id}`,
        workflowId: w._id,
        workflowName: w.name,
        description: w.description,
        searchHaystack: [w.name, w.description, 'workflow'].filter(Boolean).join(' ').toLowerCase(),
      }));
      out.push({ label: 'Workflows', entries });
    }

    return out;
  }, [agents, teams, workflows]);

  useEffect(() => {
    if (!open) return;
    setTargetKey(currentAgent ? `agent:${currentAgent}` : '');
    setRepoId('');
    setExtra('');
    setError(null);
    setSubmitting(false);
    setFullWorkflow(null);
    setWorkflowInput({});
    setPromptTemplate(buildAgentDispatchPromptTemplate(issue, ''));
    setPromptCustomized(false);
  }, [open, currentAgent]);

  // When the target switches to a workflow, fetch its full record (so we
  // have parsed.input) and seed defaults from the schema. The `task`-style
  // fields are pre-filled with the ticket title + description so the user
  // doesn't have to retype context that's already on the ticket.
  useEffect(() => {
    if (!open) return;
    if (!targetKey.startsWith('workflow:')) {
      setFullWorkflow(null);
      setWorkflowInput({});
      return;
    }
    const id = targetKey.split(':')[1];
    let cancelled = false;
    setLoadingWorkflow(true);
    setFullWorkflow(null);
    wfApi.get(id)
      .then((wf) => {
        if (cancelled) return;
        setFullWorkflow(wf);
        const defaults: Record<string, string> = {};
        const seedTask = `[${issue.identifier}] ${issue.title}${
          issue.description ? `\n\n${issue.description}` : ''
        }`;
        for (const [key, schema] of Object.entries((wf?.parsed?.input ?? {}) as Record<string, any>)) {
          let v = schema?.default != null ? String(schema.default) : '';
          // Auto-seed common ticket-context fields so the user can just
          // hit Run on most workflows.
          if (!v && (key === 'task' || key === 'topic' || key === 'description' || key === 'user_request' || key === 'bug_report')) {
            v = seedTask;
          } else if (!v && (key === 'ticket_id' || key === 'identifier')) {
            v = issue.identifier;
          } else if (!v && (key === 'ticket_url' || key === 'url')) {
            // Try to find a URL on the ticket — caller passes it through
            // issue if available.
            v = (issue as any).url ?? '';
          } else if (!v && key === 'title') {
            v = issue.title;
          }
          defaults[key] = v;
        }
        setWorkflowInput(defaults);
      })
      .catch(() => { if (!cancelled) setFullWorkflow(null); })
      .finally(() => { if (!cancelled) setLoadingWorkflow(false); });
    return () => { cancelled = true; };
  }, [open, targetKey, issue]);

  useEffect(() => {
    if (!open || targetKey.startsWith('workflow:') || promptCustomized) return;
    setPromptTemplate(buildAgentDispatchPromptTemplate(issue, extra));
  }, [open, targetKey, promptCustomized, issue, extra]);

  if (!open) return null;

  const selectedRepo = repos.find(r => String(r._id) === repoId);
  const targetKind = targetKey.split(':')[0];

  function decodeTarget(): DispatchTarget | null {
    if (!targetKey) return null;
    for (const sec of sections) {
      const e = sec.entries.find(x => x.key === targetKey);
      if (!e) continue;
      if (e.kind === 'agent') return { kind: 'agent', name: e.agentName };
      if (e.kind === 'team-lead') {
        return { kind: 'team-lead', teamName: e.teamName, agentName: e.agentName };
      }
      if (e.kind === 'workflow') {
        return { kind: 'workflow', workflowId: e.workflowId, workflowName: e.workflowName };
      }
    }
    return null;
  }

  const selectedTarget = decodeTarget();
  const promptPreview = selectedTarget && selectedTarget.kind !== 'workflow'
    ? promptTemplate
    : '';

  async function submit() {
    setError(null);
    const target = decodeTarget();
    if (!target) { setError('Pick an agent, team lead, or workflow'); return; }
    if (target.kind !== 'workflow' && !repoId) {
      setError('Pick a repository — the agent needs a workspace to work in');
      return;
    }

    // Type-cast workflow inputs per the parsed.input schema. Required
    // fields without a value short-circuit with a helpful error.
    let castInput: Record<string, unknown> | undefined;
    if (target.kind === 'workflow' && fullWorkflow?.parsed?.input) {
      const schemaByKey = fullWorkflow.parsed.input as Record<string, any>;
      castInput = {};
      for (const [k, schema] of Object.entries(schemaByKey)) {
        const raw = workflowInput[k];
        const v = typeof raw === 'string' ? raw.trim() : raw;
        const isRequired = schema?.required !== false;
        const type = schema?.type ?? 'string';
        if (v === '' || v == null) {
          if (isRequired) {
            setError(`${schema?.label ?? k} is required`);
            return;
          }
          continue;
        }
        if (type === 'boolean') {
          castInput[k] = v === 'true';
        } else if (type === 'number') {
          const n = Number(v);
          if (Number.isNaN(n)) {
            setError(`${schema?.label ?? k} must be a number`);
            return;
          }
          castInput[k] = n;
        } else {
          castInput[k] = v;
        }
      }
    }

    setSubmitting(true);
    try {
      await onSubmit({
        target,
        repoId,
        extraInstructions: extra.trim(),
        promptTemplate: target.kind === 'workflow' ? undefined : promptTemplate,
        workflowInput: castInput,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dispatch');
      setSubmitting(false);
    }
  }

  const ctaLabel = submitting
    ? 'Dispatching…'
    : targetKind === 'workflow'
      ? 'Run workflow'
      : 'Dispatch';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md" onClick={onClose}>
      <div className="bg-app-card border border-app rounded-lg w-full max-w-3xl max-h-[85vh] shadow-popover animate-in fade-in zoom-in-95 duration-200 overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-4 border-b border-app flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-[14px] font-semibold text-theme-primary tracking-tight">Dispatch</h2>
            <div className="mt-0.5 text-[11px] font-mono text-theme-muted">
              <span className="text-theme-subtle">{issue.identifier}</span> · {issue.title}
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md text-theme-muted hover:text-theme-primary hover:bg-app-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 overflow-y-auto min-h-0 flex-1">
          <div>
            <label className="overline mb-1.5 block">
              <Sparkles className="inline w-3 h-3 text-accent mr-1" /> Target
            </label>
            <TargetPicker
              value={targetKey}
              onChange={setTargetKey}
              sections={sections}
              workflowsLoading={!!workflowsLoading}
            />
            <div className="mt-1 text-[10px] font-mono text-theme-subtle">
              Pick an individual agent, hand it to a team lead, or run a workflow. Search by agent, team, lead, or workflow name.
            </div>
          </div>

          {targetKind === 'workflow' ? (
            <WorkflowInputs
              loading={loadingWorkflow}
              workflow={fullWorkflow}
              values={workflowInput}
              repos={repos}
              onChange={(k, v) => setWorkflowInput((prev) => ({ ...prev, [k]: v }))}
            />
          ) : (
            <div className="space-y-4">
              <div>
                <label className="overline mb-1.5 block">
                  Prompt template
                </label>
                <div className="mb-1.5 flex items-center justify-between gap-3">
                  <div className="text-[10px] font-mono text-theme-subtle">
                    {selectedTarget?.kind === 'team-lead'
                      ? `Editable prompt that will be sent to the selected team lead (${selectedTarget.agentName}).`
                      : selectedTarget?.kind === 'agent'
                        ? `Editable prompt that will be sent to the selected agent (${selectedTarget.name}).`
                        : 'Pick an agent or team lead to edit the prompt.'}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setPromptTemplate(buildAgentDispatchPromptTemplate(issue, extra));
                      setPromptCustomized(false);
                    }}
                    className="text-[10px] font-mono text-accent hover:underline shrink-0"
                  >
                    Reset from ticket
                  </button>
                </div>
                <textarea
                  value={promptPreview}
                  onChange={(e) => {
                    setPromptTemplate(e.target.value);
                    setPromptCustomized(true);
                  }}
                  rows={14}
                  className="input py-2 text-[12px] font-mono resize-y w-full"
                />
                <div className="mt-1.5 text-[10px] font-mono text-theme-subtle">
                  Placeholders: <span className="text-theme-muted">{'{{worktreePath}}'}</span> and <span className="text-theme-muted">{'{{repoPath}}'}</span> are replaced after workspace creation.
                </div>
              </div>

              <div>
                <label className="overline mb-1.5 block">
                  <FolderGit2 className="inline w-3 h-3 text-accent-purple mr-1" /> Repository
                </label>
                <select
                  value={repoId}
                  onChange={e => setRepoId(e.target.value)}
                  disabled={reposLoading}
                  className="input py-2 text-[13px] w-full disabled:opacity-50"
                >
                  <option value="">
                    {reposLoading ? 'Loading repos…' : '— Pick a repository —'}
                  </option>
                  {repos.map(r => (
                    <option key={String(r._id)} value={String(r._id)}>
                      {r.name}{r.path ? ` · ${r.path}` : ''}
                    </option>
                  ))}
                </select>
                {selectedRepo?.path && (
                  <div className="mt-1.5 text-[10px] font-mono text-theme-subtle">
                    A fresh workspace will be created from <span className="text-theme-muted">{selectedRepo.path}</span>. The agent works on its own branch; original repo isn't touched.
                  </div>
                )}
                {!reposLoading && repos.length === 0 && (
                  <div className="mt-1.5 text-[10px] font-mono text-theme-muted italic">
                    No repositories registered. Add one on the Repos page first.
                  </div>
                )}
              </div>

              <div>
                <label className="overline mb-1.5 block">
                  Extra instructions <span className="text-theme-subtle normal-case">(optional)</span>
                </label>
                <textarea
                  value={extra}
                  onChange={e => setExtra(e.target.value)}
                  rows={4}
                  placeholder="Any additional context beyond the ticket body…"
                  className="input py-2 text-[13px] resize-y w-full"
                />
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-accent-red/30 bg-accent-red/10 text-xs text-accent-red font-body">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-app bg-app-muted/40 flex items-center justify-between shrink-0">
          <div className="text-[10px] font-mono text-theme-subtle">
            {targetKind === 'workflow'
              ? 'Workflow runs as a normal execution. Results show up in Activity.'
              : 'Workspace creates first, then the agent starts working in it.'}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} disabled={submitting} className="btn btn-ghost btn-sm">Cancel</button>
            <button
              onClick={submit}
              disabled={submitting || !targetKey || (targetKind !== 'workflow' && !repoId)}
              className="btn btn-primary btn-sm"
            >
              {submitting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              {ctaLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Searchable target picker ─────────────────────────────────────────────

function TargetPicker({
  value, onChange, sections, workflowsLoading,
}: {
  value: string;
  onChange: (k: string) => void;
  sections: PickerSection[];
  workflowsLoading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hoverIdx, setHoverIdx] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Find the currently selected entry across all sections.
  const selected = useMemo<PickerEntry | null>(() => {
    if (!value) return null;
    for (const sec of sections) {
      const e = sec.entries.find(x => x.key === value);
      if (e) return e;
    }
    return null;
  }, [value, sections]);

  // Filter sections by the search query.
  const filteredSections = useMemo<PickerSection[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections
      .map(s => ({ label: s.label, entries: s.entries.filter(e => e.searchHaystack.includes(q)) }))
      .filter(s => s.entries.length > 0);
  }, [sections, query]);

  // Flat list for keyboard navigation.
  const flat = useMemo(() => filteredSections.flatMap(s => s.entries), [filteredSections]);

  useEffect(() => { setHoverIdx(0); }, [query, filteredSections.length]);

  // Outside click + escape to close.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  useEffect(() => {
    if (open) {
      // Focus the search input as soon as the popover renders.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  function commit(entry: PickerEntry) {
    onChange(entry.key);
    setOpen(false);
    setQuery('');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHoverIdx((i) => Math.min(i + 1, Math.max(0, flat.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHoverIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = flat[hoverIdx];
      if (target) commit(target);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      setQuery('');
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="input py-2 text-[13px] w-full text-left flex items-center gap-2"
      >
        {selected ? (
          <SelectedSummary entry={selected} />
        ) : (
          <span className="flex-1 text-theme-muted">— Pick an agent, team lead, or workflow —</span>
        )}
        <ChevronDown className={`w-3.5 h-3.5 text-theme-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 left-0 right-0 bg-app-card border border-app rounded-lg shadow-popover overflow-hidden">
          {/* Search */}
          <div className="border-b border-app p-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-theme-muted pointer-events-none" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Search agents, teams, leads, workflows…"
                className="input pl-8 pr-3 py-1.5 w-full text-[12px]"
              />
            </div>
          </div>

          {/* Scrollable list */}
          <div className="max-h-[320px] overflow-y-auto py-1">
            {workflowsLoading && (
              <div className="px-3 py-2 text-[11px] font-mono text-theme-subtle italic flex items-center gap-2">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading workflows…
              </div>
            )}
            {filteredSections.length === 0 && !workflowsLoading && (
              <div className="px-3 py-6 text-center text-[12px] text-theme-muted font-body italic">
                {query ? `No matches for "${query}".` : 'No targets available.'}
              </div>
            )}
            {(() => {
              let runningIdx = -1;
              return filteredSections.map((sec) => (
                <div key={sec.label} className="mb-1">
                  <div className="overline px-3 pt-2 pb-1">{sec.label}</div>
                  {sec.entries.map((e) => {
                    runningIdx += 1;
                    const idx = runningIdx;
                    const isHover = idx === hoverIdx;
                    const isSelected = e.key === value;
                    return (
                      <button
                        key={e.key}
                        type="button"
                        onMouseEnter={() => setHoverIdx(idx)}
                        onClick={() => commit(e)}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                          isHover ? 'bg-app-muted' : ''
                        } ${isSelected ? 'bg-accent-soft' : ''}`}
                      >
                        <EntryIcon entry={e} />
                        <EntryLabel entry={e} highlight={query} />
                      </button>
                    );
                  })}
                </div>
              ));
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

function SelectedSummary({ entry }: { entry: PickerEntry }) {
  return (
    <span className="flex items-center gap-2 flex-1 min-w-0">
      <EntryIcon entry={entry} />
      {entry.kind === 'team-lead' && (
        <span className="text-theme-primary truncate">
          {entry.teamLabel} <span className="text-theme-muted font-mono text-[11px]">· lead {entry.agentDisplay}</span>
        </span>
      )}
      {entry.kind === 'agent' && (
        <span className="text-theme-primary truncate">
          {entry.agentDisplay}
          {entry.teamLabel && (
            <span className="text-theme-muted font-mono text-[11px]"> · {entry.teamLabel}</span>
          )}
        </span>
      )}
      {entry.kind === 'workflow' && (
        <span className="text-theme-primary truncate">
          {entry.workflowName} <span className="text-theme-muted font-mono text-[11px]">· workflow</span>
        </span>
      )}
    </span>
  );
}

function EntryIcon({ entry }: { entry: PickerEntry }) {
  if (entry.kind === 'team-lead') {
    return (
      <span className="w-5 h-5 rounded bg-accent-yellow/15 text-accent-yellow flex items-center justify-center shrink-0">
        <Crown className="w-3 h-3" />
      </span>
    );
  }
  if (entry.kind === 'agent') {
    return (
      <span className="w-5 h-5 rounded bg-accent-soft text-accent flex items-center justify-center shrink-0">
        <Users className="w-3 h-3" />
      </span>
    );
  }
  return (
    <span className="w-5 h-5 rounded bg-accent-purple/15 text-accent-purple flex items-center justify-center shrink-0">
      <GitBranch className="w-3 h-3" />
    </span>
  );
}

function EntryLabel({ entry, highlight }: { entry: PickerEntry; highlight: string }) {
  if (entry.kind === 'team-lead') {
    return (
      <span className="flex-1 min-w-0 text-[13px] truncate">
        <Highlight text={entry.teamLabel} q={highlight} />
        <span className="text-theme-muted font-mono text-[11px] ml-2">· led by {entry.agentDisplay}</span>
      </span>
    );
  }
  if (entry.kind === 'agent') {
    return (
      <span className="flex-1 min-w-0 text-[13px] truncate flex items-center gap-1">
        <Highlight text={entry.agentDisplay} q={highlight} />
        {entry.isLead && <Crown className="w-3 h-3 text-accent-yellow shrink-0" />}
        {entry.teamLabel && (
          <span className="text-theme-muted font-mono text-[11px] ml-1">· <Highlight text={entry.teamLabel} q={highlight} /></span>
        )}
      </span>
    );
  }
  return (
    <span className="flex-1 min-w-0 text-[13px] truncate">
      <Highlight text={entry.workflowName} q={highlight} />
      {entry.description && (
        <span className="text-theme-muted font-mono text-[11px] ml-2 truncate">· {entry.description.slice(0, 60)}</span>
      )}
    </span>
  );
}

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const start = lower.indexOf(q.toLowerCase());
  if (start < 0) return <>{text}</>;
  const end = start + q.length;
  return (
    <>
      {text.slice(0, start)}
      <mark className="bg-accent-soft text-accent rounded px-0.5">{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  );
}

// ── Workflow inputs (schema-driven) ──────────────────────────────────────

const LONG_FIELDS = new Set([
  'task', 'topic', 'question', 'problem', 'description',
  'user_request', 'bug_report', 'greeting', 'feedback',
]);

function widgetFor(key: string, schema: any): 'text' | 'textarea' | 'number' | 'checkbox' | 'select' {
  if (schema?.widget) return schema.widget;
  if (Array.isArray(schema?.enum) && schema.enum.length > 0) return 'select';
  if (schema?.type === 'boolean') return 'checkbox';
  if (schema?.type === 'number') return 'number';
  if (LONG_FIELDS.has(key)) return 'textarea';
  return 'text';
}

function isRepoPickerField(schema: any): boolean {
  return typeof schema?.widget === 'string' && schema.widget.toLowerCase() === 'repo_picker';
}

function findRepoByPath(repos: Repo[], value: string): Repo | null {
  if (!value) return null;
  return repos.find(r => (r.path ?? '') === value) ?? null;
}

function WorkflowInputs({
  loading, workflow, values, repos, onChange,
}: {
  loading: boolean;
  workflow: any | null;
  values: Record<string, string>;
  repos: Repo[];
  onChange: (key: string, value: string) => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-3 rounded-md border border-app bg-app-muted/40 text-[12px] text-theme-muted">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading workflow inputs…
      </div>
    );
  }
  if (!workflow) {
    return (
      <div className="px-3 py-3 rounded-md border border-app bg-app-muted/40 text-[12px] text-theme-muted italic">
        Workflow definition not loaded. Pick another target or try again.
      </div>
    );
  }

  const schema = (workflow.parsed?.input ?? {}) as Record<string, any>;
  const keys = Object.keys(schema);

  if (keys.length === 0) {
    return (
      <div className="px-3 py-3 rounded-md border border-dashed border-app text-[12px] text-theme-muted italic">
        This workflow takes no inputs. Submit to run.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="overline">Workflow inputs · {workflow.name}</div>
      {keys.map((key) => {
        const s = schema[key];
        const w = widgetFor(key, s);
        const repoPicker = isRepoPickerField(s);
        const required = s?.required !== false;
        const label = s?.label ?? key.replace(/_/g, ' ');
        const description = s?.description as string | undefined;
        const placeholder = s?.placeholder ?? `Enter ${key.replace(/_/g, ' ')}…`;
        const value = values[key] ?? '';
        const selectedRepo = repoPicker ? findRepoByPath(repos, value) : null;

        return (
          <div key={key}>
            <label className="overline mb-1 flex items-center gap-1">
              {label}
              {required && <span className="text-accent-red normal-case text-[10px]">*</span>}
            </label>
            {description && w !== 'checkbox' && (
              <p className="text-[11px] text-theme-muted font-body mb-1.5 leading-relaxed">{description}</p>
            )}

            {repoPicker && (
              <>
                <select
                  value={value}
                  onChange={(e) => onChange(key, e.target.value)}
                  className="input py-2 text-[13px] w-full"
                >
                  <option value="">— Pick a repository —</option>
                  {repos.map(repo => {
                    const optionValue = repo.path ?? '';
                    const disabled = !repo.path;
                    return (
                      <option key={String(repo._id)} value={optionValue} disabled={disabled}>
                        {repo.name}{repo.path ? ` · ${repo.path}` : ''}{disabled ? ' · missing path' : ''}
                      </option>
                    );
                  })}
                </select>
                {selectedRepo?.path && (
                  <div className="mt-1.5 text-[10px] font-mono text-theme-subtle">
                    Selected repo path: <span className="text-theme-muted">{selectedRepo.path}</span>
                  </div>
                )}
                {repos.length === 0 && (
                  <div className="mt-1.5 text-[10px] font-mono text-theme-muted italic">
                    No repositories registered. Add one on the Repos page first.
                  </div>
                )}
              </>
            )}

            {!repoPicker && w === 'textarea' && (
              <textarea
                value={value}
                onChange={(e) => onChange(key, e.target.value)}
                placeholder={placeholder}
                rows={4}
                className="input py-2 text-[13px] resize-y w-full"
              />
            )}

            {!repoPicker && w === 'text' && (
              <input
                type="text"
                value={value}
                onChange={(e) => onChange(key, e.target.value)}
                placeholder={placeholder}
                className="input py-2 text-[13px] w-full"
              />
            )}

            {!repoPicker && w === 'number' && (
              <input
                type="number"
                value={value}
                onChange={(e) => onChange(key, e.target.value)}
                placeholder={placeholder}
                className="input py-2 text-[13px] w-full font-mono"
              />
            )}

            {!repoPicker && w === 'checkbox' && (
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={value === 'true'}
                  onChange={(e) => onChange(key, e.target.checked ? 'true' : 'false')}
                  className="mt-0.5 cursor-pointer"
                />
                <span className="text-[12px] text-theme-secondary leading-relaxed">
                  {description ?? label}
                </span>
              </label>
            )}

            {!repoPicker && w === 'select' && Array.isArray(s.enum) && (
              <select
                value={value}
                onChange={(e) => onChange(key, e.target.value)}
                className="input py-2 text-[13px] w-full"
              >
                <option value="">— Pick —</option>
                {s.enum.map((opt: string) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            )}
          </div>
        );
      })}
    </div>
  );
}

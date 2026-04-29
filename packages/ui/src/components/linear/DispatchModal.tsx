import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, FolderGit2, Loader2, Play, Sparkles, X } from 'lucide-react';
import type { AgentOption, TeamOption } from '../agents/AgentAssignDropdown';

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
  }) => Promise<void>;
}

/**
 * Dispatch picker — supports three target kinds in a grouped dropdown
 * (Agents / Team leads / Workflows). The parent decides which API to
 * call based on the chosen target kind.
 */
export default function DispatchModal({
  open, issue, currentAgent, agents, teams, workflows, workflowsLoading,
  repos, reposLoading, onClose, onSubmit,
}: DispatchModalProps) {
  // Encoded as `<kind>:<id>` so it round-trips through a single <select>.
  const [targetKey, setTargetKey] = useState<string>('');
  const [repoId, setRepoId] = useState<string>('');
  const [extra, setExtra] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Group agents by team for the optgroup labels. Independent agents
  // (no teamName) go under "Agents". Team leads get a marker.
  const grouped = useMemo(() => {
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
    // Sort by team display label
    const teamLabel = (name: string) => teams.find(t => t.name === name)?.displayName ?? name;
    const teamSections = Array.from(byTeam.entries())
      .sort((a, b) => teamLabel(a[0]).localeCompare(teamLabel(b[0])))
      .map(([name, list]) => ({
        teamName: name,
        teamLabel: teamLabel(name),
        lead: teamLeads.get(name) ?? null,
        members: list.slice().sort((a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name)),
      }));
    return {
      independent: independent.sort((a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name)),
      teamSections,
    };
  }, [agents, teams]);

  useEffect(() => {
    if (!open) return;
    setTargetKey(currentAgent ? `agent:${currentAgent}` : '');
    setRepoId('');
    setExtra('');
    setError(null);
    setSubmitting(false);
  }, [open, currentAgent]);

  if (!open) return null;

  const selectedRepo = repos.find(r => String(r._id) === repoId);
  const targetKind = targetKey.split(':')[0];

  function decodeTarget(): DispatchTarget | null {
    if (!targetKey) return null;
    const [kind, ...rest] = targetKey.split(':');
    const id = rest.join(':');
    if (kind === 'agent') return { kind: 'agent', name: id };
    if (kind === 'team-lead') {
      const lead = grouped.teamSections.find(s => s.teamName === id)?.lead;
      if (!lead) return null;
      return { kind: 'team-lead', teamName: id, agentName: lead.name };
    }
    if (kind === 'workflow') {
      const wf = workflows?.find(w => w._id === id);
      if (!wf) return null;
      return { kind: 'workflow', workflowId: wf._id, workflowName: wf.name };
    }
    return null;
  }

  async function submit() {
    setError(null);
    const target = decodeTarget();
    if (!target) { setError('Pick an agent, team lead, or workflow'); return; }
    if (target.kind !== 'workflow' && !repoId) {
      setError('Pick a repository — the agent needs a workspace to work in');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({ target, repoId, extraInstructions: extra.trim() });
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
      <div className="bg-app-card border border-app rounded-lg w-full max-w-xl shadow-popover animate-in fade-in zoom-in-95 duration-200 overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-4 border-b border-app flex items-center justify-between">
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
        <div className="p-5 space-y-4">
          <div>
            <label className="overline mb-1.5 block">
              <Sparkles className="inline w-3 h-3 text-accent mr-1" /> Target
            </label>
            <select
              value={targetKey}
              onChange={e => setTargetKey(e.target.value)}
              className="input py-2 text-[13px] w-full"
            >
              <option value="">— Pick an agent, team lead, or workflow —</option>

              {grouped.teamSections.length > 0 && (
                <optgroup label="Team leads (delegate to lead)">
                  {grouped.teamSections.filter(s => s.lead).map(s => (
                    <option key={`team-lead:${s.teamName}`} value={`team-lead:${s.teamName}`}>
                      {s.teamLabel} · led by {s.lead!.displayName ?? s.lead!.name}
                    </option>
                  ))}
                </optgroup>
              )}

              {grouped.teamSections.map(s => (
                <optgroup key={s.teamName} label={`Agents · ${s.teamLabel}`}>
                  {s.members.map(a => (
                    <option key={`agent:${a.name}`} value={`agent:${a.name}`}>
                      {a.displayName ?? a.name}{a.teamRole === 'lead' ? ' (lead)' : ''}
                    </option>
                  ))}
                </optgroup>
              ))}

              {grouped.independent.length > 0 && (
                <optgroup label="Agents · Unassigned">
                  {grouped.independent.map(a => (
                    <option key={`agent:${a.name}`} value={`agent:${a.name}`}>
                      {a.displayName ?? a.name}
                    </option>
                  ))}
                </optgroup>
              )}

              {(workflows && workflows.length > 0) && (
                <optgroup label="Workflows">
                  {workflows.map(w => (
                    <option key={`workflow:${w._id}`} value={`workflow:${w._id}`}>
                      {w.name}{w.description ? ` · ${w.description.slice(0, 50)}` : ''}
                    </option>
                  ))}
                </optgroup>
              )}
              {workflowsLoading && <option value="" disabled>Loading workflows…</option>}
            </select>
            <div className="mt-1 text-[10px] font-mono text-theme-subtle">
              Pick an individual agent, hand it to a team lead, or run a workflow with this ticket as input.
            </div>
          </div>

          {targetKind !== 'workflow' && (
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
          )}

          <div>
            <label className="overline mb-1.5 block">
              {targetKind === 'workflow' ? 'Workflow input / extra context' : 'Extra instructions'}
              <span className="text-theme-subtle normal-case"> (optional)</span>
            </label>
            <textarea
              value={extra}
              onChange={e => setExtra(e.target.value)}
              rows={4}
              placeholder={
                targetKind === 'workflow'
                  ? 'Forwarded to the workflow as the `task` input. Leave blank to use the ticket title + body.'
                  : 'Any additional context beyond the ticket body…'
              }
              className="input py-2 text-[13px] resize-y w-full"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-accent-red/30 bg-accent-red/10 text-xs text-accent-red font-body">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-app bg-app-muted/40 flex items-center justify-between">
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

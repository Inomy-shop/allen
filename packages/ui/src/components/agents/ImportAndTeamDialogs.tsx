/**
 * ImportAndTeamDialogs
 *
 * Three dialogs used by the Agents page:
 *
 *   1. ImportAgentsFromRepoDialog — pick a registered repo, preview the
 *      `.claude/agents/*.md` files found in it, and import selected rows.
 *   2. AssignToTeamDialog — move one or more existing agents into an
 *      existing team. Optional auto-wire of the team lead's canDelegateTo.
 *   3. CreateTeamFromAgentsDialog — create a brand-new team with an
 *      auto-generated lead. The selected agents become members. Zero
 *      members is also valid (scaffold an empty team and move agents in
 *      later via AssignToTeamDialog).
 *
 * All three share the same visual language as the existing RoleDialog to
 * avoid introducing a new dialog component. No portals; inline-fixed.
 */

import { useEffect, useState } from 'react';
import { X, Loader2, AlertTriangle, Check, FolderGit2, Plus } from 'lucide-react';
import { agents as agentsApi, teams as teamsApi, repos as reposApi } from '../../services/api';
import { useToast } from '../common/Toast';

// ── Types ────────────────────────────────────────────────────────────────

interface Repo {
  _id: string;
  name: string;
  path: string;
}

interface Team {
  name: string;
  displayName: string;
  leadAgentName?: string;
}

type ImportVerdict =
  | { kind: 'create'; agent: { name: string; description: string; tools: string[]; model: string } }
  | { kind: 'skip:name-collision'; agent: { name: string }; existingAgent: string }
  | { kind: 'skip:already-imported'; agent: { name: string }; existingAgent: string }
  | { kind: 'skip:parse-error'; file: string; error: string };

// ── Shared dialog shell ──────────────────────────────────────────────────

function DialogShell({
  title,
  children,
  onClose,
  footer,
  wide,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div
        className={`bg-surface-100 border border-border/30 rounded-lg shadow-xl flex flex-col max-h-[85vh] ${
          wide ? 'w-[720px] max-w-full' : 'w-[520px] max-w-full'
        }`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/20">
          <h3 className="font-heading text-sm font-bold text-theme-primary tracking-widest uppercase">
            {title}
          </h3>
          <button onClick={onClose} className="text-theme-subtle hover:text-theme-primary">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="px-5 py-3 border-t border-border/20 flex items-center justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Import dialog ────────────────────────────────────────────────────────

export function ImportAgentsFromRepoDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: (createdNames: string[]) => void;
}) {
  const toast = useToast();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [verdicts, setVerdicts] = useState<ImportVerdict[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [committing, setCommitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    reposApi.list().then((r: Repo[]) => setRepos(r ?? [])).catch(() => setRepos([]));
    setSelectedRepoId(null);
    setVerdicts([]);
    setSelected(new Set());
  }, [open]);

  async function runPreview(repoId: string) {
    setPreviewing(true);
    setVerdicts([]);
    try {
      const result = await agentsApi.importPreview(repoId);
      setVerdicts(result.verdicts);
      const autoPick = new Set<string>();
      for (const v of result.verdicts) {
        if (v.kind === 'create') autoPick.add(v.agent.name);
      }
      setSelected(autoPick);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  }

  function toggle(name: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function commit() {
    if (!selectedRepoId || selected.size === 0) return;
    setCommitting(true);
    try {
      const result = await agentsApi.import(selectedRepoId, Array.from(selected));
      const created = result.created.length;
      const skipped = result.skipped.length;
      toast.success(`Imported ${created} agent${created === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}`);
      onImported(result.created);
      onClose();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setCommitting(false);
    }
  }

  if (!open) return null;

  const createCount = verdicts.filter(v => v.kind === 'create').length;
  const skipCount = verdicts.length - createCount;

  return (
    <DialogShell
      title="Import Claude Agents from Repo"
      onClose={onClose}
      wide
      footer={
        <>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-full text-[11px] font-mono bg-surface-200/30 text-theme-muted hover:bg-surface-200/50"
          >
            Cancel
          </button>
          {verdicts.length > 0 && (
            <button
              onClick={commit}
              disabled={selected.size === 0 || committing}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[11px] font-mono bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {committing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              Import {selected.size} agent{selected.size === 1 ? '' : 's'}
            </button>
          )}
        </>
      }
    >
      {/* Step 1: repo picker */}
      <div className="mb-4">
        <label className="block overline mb-2">
          Source Repo
        </label>
        <select
          value={selectedRepoId ?? ''}
          onChange={e => {
            const id = e.target.value || null;
            setSelectedRepoId(id);
            setVerdicts([]);
            setSelected(new Set());
            if (id) runPreview(id);
          }}
          className="input text-xs w-full"
        >
          <option value="">— pick a registered repo —</option>
          {repos.map(r => (
            <option key={r._id} value={r._id}>
              {r.name} — {r.path}
            </option>
          ))}
        </select>
      </div>

      {/* Step 2: preview */}
      {previewing && (
        <div className="flex items-center gap-2 text-xs text-theme-muted py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Scanning .claude/agents...
        </div>
      )}

      {!previewing && selectedRepoId && verdicts.length === 0 && (
        <div className="text-xs text-theme-muted py-8 text-center">
          No agents found in <span className="font-mono">.claude/agents/</span>.
        </div>
      )}

      {!previewing && verdicts.length > 0 && (
        <>
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] font-mono text-theme-muted">
              {createCount} importable, {skipCount} skipped
              {createCount > 0 && (
                <> · <span className="text-accent-blue">{selected.size} selected</span></>
              )}
            </div>
            {createCount > 0 && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    const all = new Set<string>();
                    for (const v of verdicts) {
                      if (v.kind === 'create') all.add(v.agent.name);
                    }
                    setSelected(all);
                  }}
                  disabled={selected.size === createCount}
                  className="px-2 py-0.5 rounded-full text-[9px] font-mono bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  disabled={selected.size === 0}
                  className="px-2 py-0.5 rounded-full text-[9px] font-mono bg-surface-200/30 text-theme-muted hover:bg-surface-200/50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Deselect all
                </button>
              </div>
            )}
          </div>
          <div className="border border-border/20 rounded-lg overflow-hidden">
            {verdicts.map((v, i) => {
              if (v.kind === 'skip:parse-error') {
                return (
                  <div key={`err-${i}`} className="flex items-start gap-3 px-3 py-2 border-b border-border/10 last:border-b-0 bg-accent-red/5">
                    <AlertTriangle className="w-3.5 h-3.5 text-accent-red shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-xs text-accent-red truncate">{v.file}</div>
                      <div className="text-[10px] text-theme-muted">{v.error}</div>
                    </div>
                  </div>
                );
              }
              const isCreate = v.kind === 'create';
              const reason =
                v.kind === 'skip:name-collision'
                  ? `Name already used by "${v.existingAgent}"`
                  : v.kind === 'skip:already-imported'
                    ? `Already imported as "${v.existingAgent}"`
                    : '';
              return (
                <label
                  key={v.agent.name}
                  className={`flex items-center gap-3 px-3 py-2 border-b border-border/10 last:border-b-0 ${
                    isCreate ? 'hover:bg-surface-200/20 cursor-pointer' : 'bg-surface-200/10 cursor-not-allowed opacity-60'
                  }`}
                >
                  <input
                    type="checkbox"
                    disabled={!isCreate}
                    checked={isCreate && selected.has(v.agent.name)}
                    onChange={() => isCreate && toggle(v.agent.name)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-theme-primary">{v.agent.name}</span>
                      {isCreate && 'tools' in v.agent && v.agent.tools.length > 0 && (
                        <span className="text-[9px] font-mono text-theme-subtle">
                          {v.agent.tools.join(', ')}
                        </span>
                      )}
                      {isCreate && 'model' in v.agent && (
                        <span className="text-[9px] font-mono px-1.5 rounded bg-accent-purple/10 text-accent-purple">
                          {v.agent.model}
                        </span>
                      )}
                    </div>
                    {isCreate && 'description' in v.agent && (
                      <div className="text-[10px] text-theme-muted truncate">{v.agent.description}</div>
                    )}
                    {!isCreate && <div className="text-[10px] text-theme-muted">{reason}</div>}
                  </div>
                  <span className="text-[9px] font-mono uppercase tracking-widest text-theme-subtle shrink-0">
                    {isCreate ? 'create' : 'skip'}
                  </span>
                </label>
              );
            })}
          </div>
        </>
      )}
    </DialogShell>
  );
}

// ── Assign-to-team dialog ────────────────────────────────────────────────

export function AssignToTeamDialog({
  open,
  onClose,
  agentNames,
  onAssigned,
}: {
  open: boolean;
  onClose: () => void;
  agentNames: string[];
  onAssigned: () => void;
}) {
  const toast = useToast();
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamName, setTeamName] = useState<string>('');
  const [autoWire, setAutoWire] = useState(true);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!open) return;
    teamsApi.list().then((t: Team[]) => setTeams((t ?? []).filter(x => x.name !== 'unassigned')))
      .catch(() => setTeams([]));
    setTeamName('');
    setAutoWire(true);
  }, [open]);

  async function commit() {
    if (!teamName || agentNames.length === 0) return;
    setWorking(true);
    try {
      const result = await agentsApi.bulkAssignTeam(agentNames, teamName, autoWire);
      toast.success(`Moved ${result.moved.length} agent${result.moved.length === 1 ? '' : 's'} to "${teamName}"`);
      onAssigned();
      onClose();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Move failed');
    } finally {
      setWorking(false);
    }
  }

  if (!open) return null;

  return (
    <DialogShell
      title={`Assign ${agentNames.length} Agent${agentNames.length === 1 ? '' : 's'} to Team`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="px-4 py-1.5 rounded-full text-[11px] font-mono bg-surface-200/30 text-theme-muted hover:bg-surface-200/50">
            Cancel
          </button>
          <button
            onClick={commit}
            disabled={!teamName || working}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[11px] font-mono bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20 disabled:opacity-40"
          >
            {working ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
            Move
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block overline mb-2">
            Target Team
          </label>
          <select value={teamName} onChange={e => setTeamName(e.target.value)} className="input text-xs w-full">
            <option value="">— pick a team —</option>
            {teams.map(t => (
              <option key={t.name} value={t.name}>
                {t.displayName} ({t.name})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block overline mb-2">
            Agents to Move
          </label>
          <div className="text-[11px] font-mono text-theme-muted">
            {agentNames.join(', ')}
          </div>
        </div>
        <label className="flex items-center gap-2 text-[11px] font-mono text-theme-muted cursor-pointer">
          <input type="checkbox" checked={autoWire} onChange={e => setAutoWire(e.target.checked)} />
          Also allow the team lead to delegate to these agents
        </label>
      </div>
    </DialogShell>
  );
}

// ── Create-team dialog ───────────────────────────────────────────────────

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function CreateTeamFromAgentsDialog({
  open,
  onClose,
  memberAgentNames,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  memberAgentNames: string[];
  onCreated: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [mission, setMission] = useState('');
  const [parentTeamName, setParentTeamName] = useState('executive');
  const [allTeams, setAllTeams] = useState<Team[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [leadModel, setLeadModel] = useState('sonnet');
  const [leadEffort, setLeadEffort] = useState<'off' | 'low' | 'medium' | 'high'>('high');
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!open) return;
    teamsApi.list().then((t: Team[]) => setAllTeams(t ?? [])).catch(() => setAllTeams([]));
    setName('');
    setDisplayName('');
    setDescription('');
    setMission('');
    setParentTeamName('executive');
    setAdvancedOpen(false);
    setLeadModel('sonnet');
    setLeadEffort('high');
  }, [open]);

  useEffect(() => {
    // Auto-slug when the user types the display name.
    if (displayName && !name) setName(slugify(displayName));
  }, [displayName, name]);

  const leadSlug = name ? `${name}-lead` : '<team>-lead';

  async function commit() {
    if (!name || !displayName) {
      toast.error('Name and display name are required');
      return;
    }
    setWorking(true);
    try {
      await teamsApi.createWithMembers({
        team: { name, displayName, description, mission, parentTeamName },
        lead: { model: leadModel, reasoningEffort: leadEffort },
        memberAgentNames,
        autoWireDelegation: true,
      });
      toast.success(`Created team "${displayName}" with lead "${leadSlug}"`);
      onCreated();
      onClose();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setWorking(false);
    }
  }

  if (!open) return null;

  return (
    <DialogShell
      title="Create Team"
      onClose={onClose}
      wide
      footer={
        <>
          <button onClick={onClose} className="px-4 py-1.5 rounded-full text-[11px] font-mono bg-surface-200/30 text-theme-muted hover:bg-surface-200/50">
            Cancel
          </button>
          <button
            onClick={commit}
            disabled={!name || !displayName || working}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[11px] font-mono bg-accent-green/10 text-accent-green hover:bg-accent-green/20 disabled:opacity-40"
          >
            {working ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
            Create Team
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="p-3 bg-accent-blue/5 border border-accent-blue/20 rounded-lg text-[11px] text-theme-muted">
          A lead agent will be created as <span className="font-mono text-accent-blue">{leadSlug}</span>
          {memberAgentNames.length > 0
            ? <> and will delegate to {memberAgentNames.length} member{memberAgentNames.length === 1 ? '' : 's'}.</>
            : <>. You can move agents into this team later.</>}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block overline mb-2">
              Display Name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="Billing Team"
              className="input text-xs w-full"
            />
          </div>
          <div>
            <label className="block overline mb-2">
              Slug
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(slugify(e.target.value))}
              placeholder="billing"
              className="input text-xs w-full font-mono"
            />
          </div>
        </div>

        <div>
          <label className="block overline mb-2">
            Description
          </label>
          <input
            type="text"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="One sentence describing the team"
            className="input text-xs w-full"
          />
        </div>

        <div>
          <label className="block overline mb-2">
            Mission
          </label>
          <textarea
            value={mission}
            onChange={e => setMission(e.target.value)}
            rows={3}
            placeholder="2-3 sentences. Interpolated into the auto-generated lead's system prompt."
            className="input text-xs w-full resize-none"
          />
        </div>

        <div>
          <label className="block overline mb-2">
            Parent Team
          </label>
          <select value={parentTeamName} onChange={e => setParentTeamName(e.target.value)} className="input text-xs w-full">
            {allTeams.map(t => (
              <option key={t.name} value={t.name}>
                {t.displayName}
              </option>
            ))}
          </select>
        </div>

        {memberAgentNames.length > 0 && (
          <div>
            <label className="block overline mb-2">
              Members ({memberAgentNames.length})
            </label>
            <div className="text-[11px] font-mono text-theme-muted">
              {memberAgentNames.join(', ')}
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => setAdvancedOpen(o => !o)}
          className="text-[10px] font-mono text-theme-muted hover:text-theme-primary"
        >
          {advancedOpen ? '▾' : '▸'} Advanced — lead agent settings
        </button>

        {advancedOpen && (
          <div className="grid grid-cols-2 gap-4 p-3 border border-border/20 rounded-lg bg-surface-200/10">
            <div>
              <label className="block overline mb-2">
                Lead Model
              </label>
              <select value={leadModel} onChange={e => setLeadModel(e.target.value)} className="input text-xs w-full">
                <option value="haiku">haiku</option>
                <option value="sonnet">sonnet</option>
                <option value="opus">opus</option>
              </select>
            </div>
            <div>
              <label className="block overline mb-2">
                Reasoning Effort
              </label>
              <select value={leadEffort} onChange={e => setLeadEffort(e.target.value as any)} className="input text-xs w-full">
                <option value="off">off</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </div>
          </div>
        )}
      </div>
    </DialogShell>
  );
}

// ── Export aggregate icons (so the agents page doesn't have to re-import) ──

export { FolderGit2 as ImportIcon, Plus as CreateTeamIcon };

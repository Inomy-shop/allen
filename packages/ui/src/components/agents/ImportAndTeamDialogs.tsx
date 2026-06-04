/**
 * ImportAndTeamDialogs
 *
 * Three dialogs used by the Agents page:
 *
 *   1. ImportAgentsFromRepoDialog — pick a registered repo, preview the
 *      `.claude/agents/*.md` files found in it, and import selected rows.
 *   2. AssignToTeamDialog — move one or more existing agents into an
 *      existing team. Optional auto-wire of the team lead's spawn targets.
 *   3. CreateTeamFromAgentsDialog — create a brand-new team with an
 *      auto-generated lead. The selected agents become members. Zero
 *      members is also valid (scaffold an empty team and move agents in
 *      later via AssignToTeamDialog).
 *
 * All three share the same visual language as the existing RoleDialog to
 * avoid introducing a new dialog component. No portals; inline-fixed.
 */

import { useEffect, useState } from 'react';
import { X, Loader2, AlertTriangle, Check, FolderGit2, Plus, Users } from 'lucide-react';
import { agents as agentsApi, teams as teamsApi, repos as reposApi } from '../../services/api';
import { useToast } from '../common/Toast';
import IconTooltipButton from '../common/IconTooltipButton';
import Select from '../common/Select';

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
  description,
  icon,
  children,
  onClose,
  footer,
  wide,
}: {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm">
      <div
        className={`flex max-h-[88vh] flex-col overflow-hidden rounded-md border border-app bg-app-card shadow-[0_24px_80px_rgba(0,0,0,0.34)] animate-in fade-in zoom-in-95 duration-200 ${
          wide ? 'w-[760px] max-w-full' : 'w-[540px] max-w-full'
        }`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-app px-6 py-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-app bg-app text-accent">
              {icon ?? <Users className="h-[18px] w-[18px]" />}
            </span>
            <div className="min-w-0">
              <h3 className="text-[17px] font-semibold tracking-tight text-theme-primary">{title}</h3>
              {description && <p className="mt-1 text-[13px] text-theme-muted">{description}</p>}
            </div>
          </div>
          <IconTooltipButton label="Close" onClick={onClose} className="h-9 w-9">
            <X className="h-4 w-4" />
          </IconTooltipButton>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-app px-6 py-4">
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
      title="Import agents"
      description="Scan a registered repository for .claude/agents files and choose what to import."
      icon={<FolderGit2 className="h-[18px] w-[18px]" />}
      onClose={onClose}
      wide
      footer={
        <>
          <button
            onClick={onClose}
            className="btn btn-secondary btn-sm"
          >
            Cancel
          </button>
          {verdicts.length > 0 && (
            <button
              onClick={commit}
              disabled={selected.size === 0 || committing}
              className="btn btn-primary btn-sm disabled:cursor-not-allowed disabled:opacity-40"
            >
              {committing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Import {selected.size} agent{selected.size === 1 ? '' : 's'}
            </button>
          )}
        </>
      }
    >
      {/* Step 1: repo picker */}
      <div className="mb-4">
        <label className="mb-2 block overline">
          Source Repo
        </label>
        <Select
          value={selectedRepoId ?? ''}
          onChange={(value) => {
            const id = value || null;
            setSelectedRepoId(id);
            setVerdicts([]);
            setSelected(new Set());
            if (id) runPreview(id);
          }}
          placeholder="Pick a registered repo"
          searchPlaceholder="Search repositories..."
          options={repos.map(repo => ({
            value: repo._id,
            label: repo.name,
            sublabel: repo.path,
          }))}
        />
      </div>

      {/* Step 2: preview */}
      {previewing && (
        <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-theme-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Scanning .claude/agents...
        </div>
      )}

      {!previewing && selectedRepoId && verdicts.length === 0 && (
        <div className="py-8 text-center text-[13px] text-theme-muted">
          No agents found in <span className="font-mono">.claude/agents/</span>.
        </div>
      )}

      {!previewing && verdicts.length > 0 && (
        <>
          <div className="flex items-center justify-between mb-2">
            <div className="font-mono text-[11px] text-theme-muted">
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
                  className="rounded-md border border-app px-2 py-1 font-mono text-[10px] text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  disabled={selected.size === 0}
                  className="rounded-md border border-app px-2 py-1 font-mono text-[10px] text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Deselect all
                </button>
              </div>
            )}
          </div>
          <div className="overflow-hidden rounded-md border border-app">
            {verdicts.map((v, i) => {
              if (v.kind === 'skip:parse-error') {
                return (
                  <div key={`err-${i}`} className="flex items-start gap-3 border-b border-app bg-accent-red/5 px-3 py-2.5 last:border-b-0">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-red" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-mono text-[12px] text-accent-red">{v.file}</div>
                      <div className="text-[11px] text-theme-muted">{v.error}</div>
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
                  className={`flex items-center gap-3 border-b border-app px-3 py-2.5 last:border-b-0 ${
                    isCreate ? 'cursor-pointer hover:bg-app-muted/40' : 'cursor-not-allowed bg-app-muted/25 opacity-60'
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
                      <span className="font-mono text-[12px] text-theme-primary">{v.agent.name}</span>
                      {isCreate && 'tools' in v.agent && v.agent.tools.length > 0 && (
                        <span className="font-mono text-[10px] text-theme-subtle">
                          {v.agent.tools.join(', ')}
                        </span>
                      )}
                      {isCreate && 'model' in v.agent && (
                        <span className="rounded bg-accent-purple/10 px-1.5 font-mono text-[10px] text-accent-purple">
                          {v.agent.model}
                        </span>
                      )}
                    </div>
                    {isCreate && 'description' in v.agent && (
                      <div className="truncate text-[11px] text-theme-muted">{v.agent.description}</div>
                    )}
                    {!isCreate && <div className="text-[11px] text-theme-muted">{reason}</div>}
                  </div>
                  <span className="shrink-0 font-mono text-[10px] text-theme-subtle">
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
      title="Assign to team"
      description={`${agentNames.length} selected agent${agentNames.length === 1 ? '' : 's'} will move to the selected team.`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn btn-secondary btn-sm">
            Cancel
          </button>
          <button
            onClick={commit}
            disabled={!teamName || working}
            className="btn btn-primary btn-sm disabled:opacity-40"
          >
            {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Move
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="mb-2 block overline">
            Target Team
          </label>
          <Select
            value={teamName}
            onChange={setTeamName}
            placeholder="Pick a team"
            searchPlaceholder="Search teams..."
            options={teams.map(team => ({
              value: team.name,
              label: team.displayName,
              sublabel: team.name,
            }))}
          />
        </div>
        <div>
          <label className="mb-2 block overline">
            Agents to Move
          </label>
          <div className="rounded-md border border-app bg-app-muted px-3 py-2 font-mono text-[12px] text-theme-muted">
            {agentNames.join(', ')}
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-2 font-mono text-[12px] text-theme-muted">
          <input type="checkbox" checked={autoWire} onChange={e => setAutoWire(e.target.checked)} />
          Also allow the team lead to spawn these agents
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
        autoWireSpawnTargets: true,
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
      title="Create team"
      description="Create a team lead and optionally place selected agents under it."
      onClose={onClose}
      wide
      footer={
        <>
          <button onClick={onClose} className="btn btn-secondary btn-sm">
            Cancel
          </button>
          <button
            onClick={commit}
            disabled={!name || !displayName || working}
            className="btn btn-primary btn-sm disabled:opacity-40"
          >
            {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Create team
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-md border border-accent-blue/20 bg-accent-blue/5 p-3 text-[12px] text-theme-muted">
          A lead agent will be created as <span className="font-mono text-accent-blue">{leadSlug}</span>
          {memberAgentNames.length > 0
            ? <> and can spawn {memberAgentNames.length} member{memberAgentNames.length === 1 ? '' : 's'}.</>
            : <>. You can move agents into this team later.</>}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-2 block overline">
              Display Name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="Billing Team"
              className="h-10 w-full rounded-md border border-app bg-app-muted px-3 text-[13px] text-theme-primary outline-none placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
            />
          </div>
          <div>
            <label className="mb-2 block overline">
              Slug
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(slugify(e.target.value))}
              placeholder="billing"
              className="h-10 w-full rounded-md border border-app bg-app-muted px-3 font-mono text-[13px] text-theme-primary outline-none placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
            />
          </div>
        </div>

        <div>
          <label className="mb-2 block overline">
            Description
          </label>
          <input
            type="text"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="One sentence describing the team"
            className="h-10 w-full rounded-md border border-app bg-app-muted px-3 text-[13px] text-theme-primary outline-none placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
          />
        </div>

        <div>
          <label className="mb-2 block overline">
            Mission
          </label>
          <textarea
            value={mission}
            onChange={e => setMission(e.target.value)}
            rows={3}
            placeholder="2-3 sentences. Interpolated into the auto-generated lead's system prompt."
            className="min-h-[92px] w-full resize-none rounded-md border border-app bg-app-muted px-3 py-2 text-[13px] text-theme-primary outline-none placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
          />
        </div>

        <div>
          <label className="mb-2 block overline">
            Parent Team
          </label>
          <Select
            value={parentTeamName}
            onChange={setParentTeamName}
            placeholder="Pick a parent team"
            searchPlaceholder="Search teams..."
            options={[
              { value: '', label: 'Top-level', sublabel: 'No parent team' },
              ...allTeams.map(team => ({
                value: team.name,
                label: team.displayName,
                sublabel: team.name,
              })),
            ]}
          />
        </div>

        {memberAgentNames.length > 0 && (
          <div>
            <label className="mb-2 block overline">
              Members ({memberAgentNames.length})
            </label>
            <div className="rounded-md border border-app bg-app-muted px-3 py-2 font-mono text-[12px] text-theme-muted">
              {memberAgentNames.join(', ')}
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => setAdvancedOpen(o => !o)}
          className="font-mono text-[11px] text-theme-muted hover:text-theme-primary"
        >
          {advancedOpen ? '▾' : '▸'} Advanced — lead agent settings
        </button>

        {advancedOpen && (
          <div className="grid grid-cols-2 gap-4 rounded-md border border-app bg-app-muted/30 p-3">
            <div>
              <label className="mb-2 block overline">
                Lead Model
              </label>
              <Select
                value={leadModel}
                onChange={setLeadModel}
                searchable={false}
                options={[
                  { value: 'haiku', label: 'haiku' },
                  { value: 'sonnet', label: 'sonnet' },
                  { value: 'opus', label: 'opus' },
                ]}
              />
            </div>
            <div>
              <label className="mb-2 block overline">
                Reasoning Effort
              </label>
              <Select
                value={leadEffort}
                onChange={(value) => setLeadEffort(value as 'off' | 'low' | 'medium' | 'high')}
                searchable={false}
                options={[
                  { value: 'off', label: 'off' },
                  { value: 'low', label: 'low' },
                  { value: 'medium', label: 'medium' },
                  { value: 'high', label: 'high' },
                ]}
              />
            </div>
          </div>
        )}
      </div>
    </DialogShell>
  );
}

// ── Export aggregate icons (so the agents page doesn't have to re-import) ──

export { FolderGit2 as ImportIcon, Plus as CreateTeamIcon };

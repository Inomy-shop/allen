import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { teams as teamsApi, agents as agentsApi } from '../services/api';
import {
  Pencil, Trash2, X, AlertCircle, Crown, Users, RefreshCw, Sparkles,
} from 'lucide-react';

interface Team {
  _id?: string;
  name: string;
  displayName: string;
  description: string;
  mission?: string;
  leadAgentName: string;
  parentTeamName?: string;
  isBuiltIn: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

interface Agent {
  _id?: string;
  name: string;
  displayName?: string;
  teamName?: string;
  teamRole?: 'lead' | 'member';
  isBuiltIn?: boolean;
}

// ── Team Dialog (create / edit) ───────────────────────────────────────────────

type DialogMode =
  | { type: 'closed' }
  | { type: 'create' }
  | { type: 'edit'; team: Team };

function TeamDialog({
  mode, allAgents, allTeams, onClose, onSubmit,
}: {
  mode: DialogMode;
  allAgents: Agent[];
  allTeams: Team[];
  onClose: () => void;
  onSubmit: (input: Partial<Team>) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [mission, setMission] = useState('');
  const [leadAgentName, setLeadAgentName] = useState('');
  const [parentTeamName, setParentTeamName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode.type === 'closed') return;
    if (mode.type === 'edit') {
      setName(mode.team.name);
      setDisplayName(mode.team.displayName);
      setDescription(mode.team.description ?? '');
      setMission(mode.team.mission ?? '');
      setLeadAgentName(mode.team.leadAgentName);
      setParentTeamName(mode.team.parentTeamName ?? '');
    } else {
      setName('');
      setDisplayName('');
      setDescription('');
      setMission('');
      setLeadAgentName('');
      setParentTeamName('');
    }
    setError(null);
    setBusy(false);
  }, [mode]);

  if (mode.type === 'closed') return null;

  const isEdit = mode.type === 'edit';

  const handleSubmit = async () => {
    setError(null);
    if (!name.trim()) { setError('Team name (slug) is required'); return; }
    if (!isEdit && !/^[a-z][a-z0-9-]*$/.test(name)) {
      setError('Name must be lowercase letters, digits, and hyphens (e.g. "finance")');
      return;
    }
    if (!displayName.trim()) { setError('Display name is required'); return; }
    if (!leadAgentName) { setError('Pick a lead agent'); return; }

    setBusy(true);
    try {
      await onSubmit({
        name: name.trim(),
        displayName: displayName.trim(),
        description: description.trim(),
        mission: mission.trim() || undefined,
        leadAgentName,
        parentTeamName: parentTeamName || undefined,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message ?? String(err));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="card w-full max-w-lg mx-4 p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-heading text-lg text-theme-primary tracking-wide">
              {isEdit ? `Edit ${mode.team.displayName}` : 'New Team'}
            </h3>
            <p className="text-xs text-theme-muted font-body mt-1">
              {isEdit
                ? 'Update team metadata. The team slug and lead cannot be changed once set.'
                : 'Create a new team in the org chart. The lead agent must already exist.'}
            </p>
          </div>
          <button onClick={onClose} className="text-theme-muted hover:text-theme-secondary transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-[10px] font-label uppercase tracking-widest text-theme-muted block mb-1">
              Slug (lowercase, hyphenated)
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              disabled={isEdit}
              placeholder="finance"
              className="w-full bg-surface-200/50 border border-border/30 rounded-md px-3 py-2 text-sm font-mono text-theme-primary placeholder-theme-subtle focus:outline-none focus:border-accent-blue/50 disabled:opacity-60 disabled:cursor-not-allowed"
            />
          </div>

          <div>
            <label className="text-[10px] font-label uppercase tracking-widest text-theme-muted block mb-1">
              Display Name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Finance Team"
              className="w-full bg-surface-200/50 border border-border/30 rounded-md px-3 py-2 text-sm text-theme-primary placeholder-theme-subtle focus:outline-none focus:border-accent-blue/50"
            />
          </div>

          <div>
            <label className="text-[10px] font-label uppercase tracking-widest text-theme-muted block mb-1">
              Description (1 sentence)
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Manages financial planning, accounting, and reporting"
              className="w-full bg-surface-200/50 border border-border/30 rounded-md px-3 py-2 text-sm text-theme-primary placeholder-theme-subtle focus:outline-none focus:border-accent-blue/50"
            />
          </div>

          <div>
            <label className="text-[10px] font-label uppercase tracking-widest text-theme-muted block mb-1">
              Mission (longer, used in agent system prompts)
            </label>
            <textarea
              value={mission}
              onChange={(e) => setMission(e.target.value)}
              rows={3}
              placeholder="The Finance team is responsible for..."
              className="w-full bg-surface-200/50 border border-border/30 rounded-md px-3 py-2 text-sm text-theme-primary placeholder-theme-subtle focus:outline-none focus:border-accent-blue/50 resize-none"
            />
          </div>

          <div>
            <label className="text-[10px] font-label uppercase tracking-widest text-theme-muted block mb-1">
              Lead Agent
            </label>
            <select
              value={leadAgentName}
              onChange={(e) => setLeadAgentName(e.target.value)}
              disabled={isEdit}
              className="w-full bg-surface-200/50 border border-border/30 rounded-md px-3 py-2 text-sm text-theme-primary focus:outline-none focus:border-accent-blue/50 disabled:opacity-60"
            >
              <option value="">— pick an agent —</option>
              {allAgents.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.displayName ?? a.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[10px] font-label uppercase tracking-widest text-theme-muted block mb-1">
              Parent Team (optional)
            </label>
            <select
              value={parentTeamName}
              onChange={(e) => setParentTeamName(e.target.value)}
              className="w-full bg-surface-200/50 border border-border/30 rounded-md px-3 py-2 text-sm text-theme-primary focus:outline-none focus:border-accent-blue/50"
            >
              <option value="">— top-level (no parent) —</option>
              {allTeams.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.displayName}
                </option>
              ))}
            </select>
          </div>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-red-500/30 bg-red-500/10 text-xs text-red-400 font-body">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button onClick={onClose} disabled={busy} className="btn-ghost text-xs">Cancel</button>
          <button onClick={handleSubmit} disabled={busy} className="btn-primary text-xs">
            {busy ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Team'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Team Card ─────────────────────────────────────────────────────────────────

function TeamCard({
  team, members, onEdit, onDelete, onAddAgentWithAi,
}: {
  team: Team;
  members: Agent[];
  onEdit: (team: Team) => void;
  onDelete: (team: Team) => void;
  onAddAgentWithAi: (team: Team) => void;
}) {
  const lead = members.find((m) => m.teamRole === 'lead');
  const otherMembers = members.filter((m) => m.teamRole !== 'lead');

  // The meta team itself can't be extended via the agent-builder (it's built-in)
  // and we don't want infinite recursion. Hide the AI button on it.
  const canAddAgentWithAi = team.name !== 'meta';

  return (
    <div className="card p-5 group relative">
      <div className="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {canAddAgentWithAi && (
          <button
            onClick={() => onAddAgentWithAi(team)}
            className="btn-ghost p-1.5 text-theme-secondary hover:text-accent-purple"
            title="Add an agent to this team using the AI agent-builder"
          >
            <Sparkles className="w-3.5 h-3.5" />
          </button>
        )}
        {!team.isBuiltIn && (
          <>
            <button
              onClick={() => onEdit(team)}
              className="btn-ghost p-1.5 text-theme-secondary hover:text-accent-blue"
              title="Edit team"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onDelete(team)}
              className="btn-ghost p-1.5 text-theme-secondary hover:text-red-400"
              title="Delete team"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>

      <div className="flex items-start gap-3 mb-3">
        <div className="w-10 h-10 rounded-md bg-accent-blue/10 border border-accent-blue/20 flex items-center justify-center shrink-0">
          <Users className="w-5 h-5 text-accent-blue" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-heading text-base text-theme-primary tracking-wide truncate">
              {team.displayName}
            </h3>
            {team.isBuiltIn && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-sm bg-surface-200 text-theme-muted border border-border/40">
                built-in
              </span>
            )}
            {team.parentTeamName && (
              <span className="text-[10px] font-mono text-theme-muted">
                ↳ {team.parentTeamName}
              </span>
            )}
          </div>
          <div className="text-[11px] text-theme-muted font-body mt-0.5">{team.description}</div>
        </div>
      </div>

      {team.mission && (
        <p className="text-xs text-theme-muted italic mb-3 font-body line-clamp-2">{team.mission}</p>
      )}

      <div className="space-y-1.5">
        {lead && (
          <div className="flex items-center gap-2 text-xs">
            <Crown className="w-3 h-3 text-accent-yellow shrink-0" />
            <span className="font-mono text-accent-yellow">{lead.displayName ?? lead.name}</span>
            <span className="text-[10px] text-theme-muted">lead</span>
          </div>
        )}
        {otherMembers.map((m) => (
          <div key={m.name} className="flex items-center gap-2 text-xs pl-5">
            <div className="w-1 h-1 rounded-full bg-theme-muted" />
            <span className="font-mono text-theme-secondary">{m.displayName ?? m.name}</span>
          </div>
        ))}
        {members.length === 0 && (
          <div className="text-[11px] text-theme-muted italic font-body">No members yet</div>
        )}
      </div>
    </div>
  );
}

// ── Delete Confirm ────────────────────────────────────────────────────────────

function DeleteConfirm({
  team, memberCount, onCancel, onConfirm,
}: {
  team: Team | null;
  memberCount: number;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  if (!team) return null;
  const handleConfirm = async () => {
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="card w-full max-w-md mx-4 p-6 space-y-4">
        <h3 className="font-heading text-lg text-theme-primary tracking-wide">Delete team?</h3>
        {memberCount > 0 ? (
          <div className="text-xs text-yellow-400 font-body">
            <strong>Cannot delete:</strong> "{team.displayName}" still has {memberCount} agent(s).
            Move or delete them first.
          </div>
        ) : (
          <p className="text-xs text-theme-muted font-body">
            This will permanently remove <span className="font-mono text-theme-primary">{team.name}</span> from
            the org chart. This cannot be undone.
          </p>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button onClick={onCancel} disabled={busy} className="btn-ghost text-xs">Cancel</button>
          <button
            onClick={handleConfirm}
            disabled={busy || memberCount > 0}
            className="btn-danger text-xs disabled:opacity-30"
          >
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function TeamManagerPage() {
  const navigate = useNavigate();
  const [allTeams, setAllTeams] = useState<Team[]>([]);
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogMode>({ type: 'closed' });
  const [deleting, setDeleting] = useState<Team | null>(null);

  // ── AI-assisted creation handlers — open a chat preselected with the right
  // builder agent and a starter prompt. The user reviews/edits the prompt
  // before sending.

  const handleBuildTeamWithAi = useCallback(() => {
    const prompt = "Build me a new team. Tell me what kind of team you want (e.g. 'finance', 'marketing', 'design ops') and I'll research the domain, design the team structure, and create the agents after you approve.";
    const params = new URLSearchParams({ agent: 'team-builder-agent', prompt });
    navigate(`/chat?${params.toString()}`);
  }, [navigate]);

  const handleAddAgentWithAi = useCallback((team: Team) => {
    // Compute members inline so we don't depend on the membersByTeam Map
    // (which is built below the function body and not yet defined).
    const memberNames = allAgents
      .filter((a) => a.teamName === team.name)
      .map((m) => m.displayName ?? m.name)
      .join(', ') || '(no members yet)';
    const prompt = `Add a new agent to the "${team.displayName}" team.\n\nCurrent members: ${memberNames}\nMission: ${team.mission ?? team.description}\n\nWhat role would you like to add?`;
    const params = new URLSearchParams({ agent: 'agent-builder-agent', prompt });
    navigate(`/chat?${params.toString()}`);
  }, [navigate, allAgents]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [t, a] = await Promise.all([teamsApi.list(), agentsApi.list()]);
      setAllTeams((t ?? []).slice().sort((x: Team, y: Team) => x.name.localeCompare(y.name)));
      setAllAgents(a ?? []);
    } catch (err) {
      setLoadError((err as Error).message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Build a map of teamName → members
  const membersByTeam = new Map<string, Agent[]>();
  for (const a of allAgents) {
    if (!a.teamName) continue;
    const list = membersByTeam.get(a.teamName) ?? [];
    list.push(a);
    membersByTeam.set(a.teamName, list);
  }

  const handleSubmit = useCallback(async (input: Partial<Team>) => {
    if (dialog.type === 'edit') {
      await teamsApi.update(dialog.team.name, input);
    } else {
      await teamsApi.create(input);
    }
    await refresh();
  }, [dialog, refresh]);

  const handleDelete = useCallback(async () => {
    if (!deleting) return;
    await teamsApi.delete(deleting.name);
    setDeleting(null);
    await refresh();
  }, [deleting, refresh]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-xl font-bold text-theme-primary tracking-widest uppercase">Teams</h1>
          <p className="text-xs text-theme-muted mt-1 font-body">
            Org chart for agents. {allTeams.length} team{allTeams.length === 1 ? '' : 's'},{' '}
            {allAgents.filter((a) => a.teamName).length} member{allAgents.filter((a) => a.teamName).length === 1 ? '' : 's'}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button title="Refresh" onClick={refresh} className="btn-ghost text-xs">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleBuildTeamWithAi}
            className="btn-primary text-xs inline-flex items-center gap-1.5"
            title="Open the AI team-builder in a new chat — it researches a domain, designs the team structure, and creates it after your approval"
          >
            <Sparkles className="w-3.5 h-3.5" /> New Team
          </button>
        </div>
      </div>

      {loadError && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-red-500/30 bg-red-500/10 text-xs text-red-400 font-body">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>Failed to load teams: {loadError}</span>
        </div>
      )}

      {loading ? (
        <div className="text-xs text-theme-muted font-mono">Loading…</div>
      ) : allTeams.length === 0 ? (
        <div className="text-xs text-theme-muted font-body py-8 text-center">
          No teams yet. Click "New Team" to create one.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {allTeams.map((team) => (
            <TeamCard
              key={team.name}
              team={team}
              members={membersByTeam.get(team.name) ?? []}
              onEdit={(t) => setDialog({ type: 'edit', team: t })}
              onDelete={(t) => setDeleting(t)}
              onAddAgentWithAi={handleAddAgentWithAi}
            />
          ))}
        </div>
      )}

      <TeamDialog
        mode={dialog}
        allAgents={allAgents}
        allTeams={allTeams}
        onClose={() => setDialog({ type: 'closed' })}
        onSubmit={handleSubmit}
      />

      <DeleteConfirm
        team={deleting}
        memberCount={deleting ? (membersByTeam.get(deleting.name)?.length ?? 0) : 0}
        onCancel={() => setDeleting(null)}
        onConfirm={handleDelete}
      />
    </div>
  );
}

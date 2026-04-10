import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { teams as teamsApi, agents as agentsApi } from '../services/api';
import { useToast } from '../components/common/Toast';
import {
  Pencil, Trash2, X, AlertCircle, Crown, Users, RefreshCw, Sparkles,
  ChevronDown, ChevronRight, Plus,
} from 'lucide-react';

/* ── Types ──────────────────────────────────────────────────────────────────── */

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

/* ── Team Dialog (create / edit) ────────────────────────────────────────────── */

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md">
      <div className="card w-full max-w-lg mx-4 overflow-hidden shadow-glow-blue/20 animate-in fade-in zoom-in-95 duration-200 max-h-[90vh] flex flex-col">
        <div className="p-6 space-y-5 overflow-y-auto">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div>
              <h3 className="font-heading text-lg text-theme-primary tracking-wide">
                {isEdit ? `Edit ${mode.team.displayName}` : 'New Team'}
              </h3>
              <p className="text-xs text-theme-muted font-body mt-1">
                {isEdit
                  ? 'Update team metadata. The slug and lead cannot be changed once set.'
                  : 'Create a new team. The lead agent must already exist.'}
              </p>
            </div>
            <button onClick={onClose} className="text-theme-muted hover:text-theme-secondary transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Fields */}
          <div className="space-y-4">
            <div>
              <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">
                Slug (lowercase, hyphenated)
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
                disabled={isEdit}
                placeholder="finance"
                className="input w-full disabled:opacity-60 disabled:cursor-not-allowed"
              />
            </div>

            <div>
              <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">
                Display Name
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Finance Team"
                className="input w-full"
              />
            </div>

            <div>
              <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">
                Description
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Manages financial planning, accounting, and reporting"
                className="input w-full"
              />
            </div>

            <div>
              <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">
                Mission
              </label>
              <textarea
                value={mission}
                onChange={(e) => setMission(e.target.value)}
                rows={3}
                placeholder="The Finance team is responsible for..."
                className="input w-full resize-none"
              />
            </div>

            <div>
              <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">
                Lead Agent
              </label>
              <select
                value={leadAgentName}
                onChange={(e) => setLeadAgentName(e.target.value)}
                disabled={isEdit}
                className="input w-full disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <option value="">-- pick an agent --</option>
                {allAgents.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.displayName ?? a.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs font-label font-semibold text-theme-secondary mb-2 uppercase tracking-widest block">
                Parent Team (optional)
              </label>
              <select
                value={parentTeamName}
                onChange={(e) => setParentTeamName(e.target.value)}
                className="input w-full"
              >
                <option value="">-- top-level (no parent) --</option>
                {allTeams.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.displayName}
                  </option>
                ))}
              </select>
            </div>

            {error && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-accent-red/30 bg-accent-red/10 text-xs text-accent-red font-body">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button onClick={onClose} disabled={busy} className="btn-ghost text-xs">Cancel</button>
            <button onClick={handleSubmit} disabled={busy} className="btn-primary text-xs">
              {busy ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Team'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Delete Confirm ─────────────────────────────────────────────────────────── */

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md">
      <div className="card w-full max-w-md mx-4 overflow-hidden shadow-glow-blue/20 animate-in fade-in zoom-in-95 duration-200">
        <div className="p-6 space-y-4">
          <h3 className="font-heading text-lg text-theme-primary tracking-wide">Delete team?</h3>

          {memberCount > 0 ? (
            <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-accent-yellow/30 bg-accent-yellow/10 text-xs text-accent-yellow font-body">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                <strong>Cannot delete:</strong> "{team.displayName}" still has {memberCount} agent(s).
                Move or delete them first.
              </span>
            </div>
          ) : (
            <p className="text-xs text-theme-muted font-body">
              This will permanently remove <span className="font-mono text-theme-primary">{team.name}</span> from
              the org chart. This cannot be undone.
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button onClick={onCancel} disabled={busy} className="btn-ghost text-xs">Cancel</button>
            <button
              onClick={handleConfirm}
              disabled={busy || memberCount > 0}
              className="btn-primary text-xs bg-accent-red/80 hover:bg-accent-red disabled:opacity-30"
            >
              {busy ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Loading Row Skeleton ──────────────────────────────────────────────────── */

function RowSkeleton() {
  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b border-border/10 animate-pulse">
      <div className="w-8 h-8 rounded-lg bg-surface-200/50" />
      <div className="w-48 space-y-1.5">
        <div className="h-3.5 w-32 bg-surface-200/50 rounded" />
        <div className="h-2.5 w-20 bg-surface-200/30 rounded" />
      </div>
      <div className="flex-1">
        <div className="h-3 w-48 bg-surface-200/30 rounded" />
      </div>
      <div className="h-5 w-16 bg-surface-200/30 rounded-full" />
      <div className="h-3 w-24 bg-surface-200/20 rounded" />
      <div className="h-3 w-20 bg-surface-200/20 rounded" />
      <div className="flex gap-1.5">
        <div className="h-6 w-20 bg-surface-200/30 rounded-full" />
        <div className="h-6 w-14 bg-surface-200/30 rounded-full" />
        <div className="h-6 w-16 bg-surface-200/30 rounded-full" />
      </div>
    </div>
  );
}

/* ── Main Page ──────────────────────────────────────────────────────────────── */

export default function TeamManagerPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [allTeams, setAllTeams] = useState<Team[]>([]);
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<DialogMode>({ type: 'closed' });
  const [deleting, setDeleting] = useState<Team | null>(null);
  const [expandedTeam, setExpandedTeam] = useState<string | null>(null);

  /* ── AI navigation handlers ─────────────────────────────────────────────── */

  const handleBuildTeamWithAi = useCallback(() => {
    const prompt =
      "Build me a new team. Tell me what kind of team you want (e.g. 'finance', 'marketing', 'design ops') and I'll research the domain, design the team structure, and create the agents after you approve.";
    const params = new URLSearchParams({ agent: 'team-builder-agent', prompt });
    navigate(`/chat?${params.toString()}`);
  }, [navigate]);

  const handleAddAgentWithAi = useCallback(
    (team: Team) => {
      const memberNames =
        allAgents
          .filter((a) => a.teamName === team.name)
          .map((m) => m.displayName ?? m.name)
          .join(', ') || '(no members yet)';
      const prompt = `Add a new agent to the "${team.displayName}" team.\n\nCurrent members: ${memberNames}\nMission: ${team.mission ?? team.description}\n\nWhat role would you like to add?`;
      const params = new URLSearchParams({ agent: 'agent-builder-agent', prompt });
      navigate(`/chat?${params.toString()}`);
    },
    [navigate, allAgents],
  );

  /* ── Data fetching ──────────────────────────────────────────────────────── */

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [t, a] = await Promise.all([teamsApi.list(), agentsApi.list()]);
      setAllTeams((t ?? []).slice().sort((x: Team, y: Team) => x.name.localeCompare(y.name)));
      setAllAgents(a ?? []);
    } catch (err) {
      toast.error(`Failed to load teams: ${(err as Error).message ?? String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* ── Members lookup ─────────────────────────────────────────────────────── */

  const membersByTeam = new Map<string, Agent[]>();
  for (const a of allAgents) {
    if (!a.teamName) continue;
    const list = membersByTeam.get(a.teamName) ?? [];
    list.push(a);
    membersByTeam.set(a.teamName, list);
  }

  /* ── CRUD handlers ──────────────────────────────────────────────────────── */

  const handleSubmit = useCallback(
    async (input: Partial<Team>) => {
      if (dialog.type === 'edit') {
        await teamsApi.update(dialog.team.name, input);
        toast.success(`"${input.displayName}" updated.`);
      } else {
        await teamsApi.create(input);
        toast.success(`"${input.displayName}" created.`);
      }
      await refresh();
    },
    [dialog, refresh, toast],
  );

  const handleDelete = useCallback(async () => {
    if (!deleting) return;
    try {
      await teamsApi.delete(deleting.name);
      toast.success(`"${deleting.displayName}" deleted.`);
      setDeleting(null);
      await refresh();
    } catch (err) {
      toast.error((err as Error).message ?? 'Failed to delete team');
    }
  }, [deleting, refresh, toast]);

  /* ── Stats ──────────────────────────────────────────────────────────────── */

  const teamCount = allTeams.length;
  const memberCount = allAgents.filter((a) => a.teamName).length;

  const toggleExpand = useCallback((teamName: string) => {
    setExpandedTeam(prev => (prev === teamName ? null : teamName));
  }, []);

  /* ── Render ─────────────────────────────────────────────────────────────── */

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-4">
          <h1 className="font-heading text-xl font-bold text-theme-primary tracking-widest uppercase">
            Teams
          </h1>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 text-[10px] font-mono text-theme-muted">
              <Users className="w-3 h-3 text-accent-blue" /> {teamCount} teams
            </div>
            <div className="flex items-center gap-1 text-[10px] font-mono text-theme-muted">
              <Users className="w-3 h-3 text-accent-green" /> {memberCount} assigned
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button title="Refresh" onClick={refresh} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono bg-surface-200/30 text-theme-muted hover:bg-surface-200/50 transition-colors">
            <RefreshCw className="w-3 h-3" />
          </button>
          <button
            onClick={() => setDialog({ type: 'create' })}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-[10px] font-mono bg-surface-200/30 text-theme-muted hover:bg-surface-200/50 transition-colors"
            title="Create a team manually"
          >
            <Plus className="w-3 h-3" /> Manual
          </button>
          <button
            onClick={handleBuildTeamWithAi}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-[10px] font-mono bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20 transition-colors"
            title="Open the AI team-builder in a new chat"
          >
            <Sparkles className="w-3 h-3" /> Build with AI
          </button>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div>
          {Array.from({ length: 4 }).map((_, i) => <RowSkeleton key={i} />)}
        </div>
      ) : teamCount === 0 ? (
        <div className="text-xs text-theme-muted font-body py-16 text-center">
          No teams yet. Click "Build with AI" or "Manual" to get started.
        </div>
      ) : (
        <div>
          {/* Column headers */}
          <div className="flex items-center gap-4 px-4 py-2 border-b border-border/20 text-[10px] font-label uppercase tracking-widest text-theme-subtle">
            <span className="w-5" />
            <span className="w-8" />
            <span className="w-48">Name</span>
            <span className="flex-1">Description</span>
            <span className="w-20 text-center">Members</span>
            <span className="w-32">Lead</span>
            <span className="w-28">Parent</span>
            <span className="w-48 text-right">Actions</span>
          </div>

          {allTeams.map((team) => {
            const members = membersByTeam.get(team.name) ?? [];
            const lead = members.find((m) => m.teamRole === 'lead');
            const otherMembers = members.filter((m) => m.teamRole !== 'lead');
            const isExpanded = expandedTeam === team.name;
            const canAddAgentWithAi = team.name !== 'meta';

            return (
              <div key={team.name}>
                {/* Team row */}
                <div
                  className="flex items-center gap-4 px-4 py-3 border-b border-border/10 hover:bg-surface-200/10 transition-colors cursor-pointer select-none"
                  onClick={() => toggleExpand(team.name)}
                >
                  {/* Chevron */}
                  <span className="w-5 shrink-0 text-theme-muted">
                    {isExpanded
                      ? <ChevronDown className="w-4 h-4" />
                      : <ChevronRight className="w-4 h-4" />}
                  </span>

                  {/* Icon with bg */}
                  <div className="w-8 h-8 rounded-lg bg-accent-blue/10 flex items-center justify-center shrink-0">
                    <Users className="w-4 h-4 text-accent-blue" />
                  </div>

                  {/* Name */}
                  <div className="w-48 min-w-0 shrink-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-heading font-semibold text-theme-primary tracking-wide truncate">
                        {team.displayName}
                      </span>
                      {team.isBuiltIn && (
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full bg-surface-200/50 text-theme-muted">
                          built-in
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] font-mono text-theme-subtle block truncate">{team.name}</span>
                  </div>

                  {/* Description truncated */}
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-theme-muted font-body truncate">
                      {team.description || 'No description'}
                    </p>
                  </div>

                  {/* Member count badge */}
                  <div className="w-20 text-center">
                    <div className="flex items-center justify-center gap-1 text-[10px] font-mono text-theme-muted">
                      <Users className="w-3 h-3 text-accent-blue" /> {members.length}
                    </div>
                  </div>

                  {/* Lead agent */}
                  <div className="w-32 min-w-0 shrink-0">
                    {lead ? (
                      <div className="flex items-center gap-1.5">
                        <Crown className="w-3 h-3 text-accent-yellow shrink-0" />
                        <span className="text-[10px] font-mono text-theme-secondary truncate">
                          {lead.displayName ?? lead.name}
                        </span>
                      </div>
                    ) : (
                      <span className="text-[10px] font-mono text-theme-subtle">--</span>
                    )}
                  </div>

                  {/* Parent team */}
                  <div className="w-28 min-w-0 shrink-0">
                    <span className="text-[10px] font-mono text-theme-muted truncate block">
                      {team.parentTeamName || '--'}
                    </span>
                  </div>

                  {/* Action buttons */}
                  <div className="w-48 flex items-center justify-end gap-1.5 shrink-0" onClick={e => e.stopPropagation()}>
                    {canAddAgentWithAi && (
                      <button
                        onClick={() => handleAddAgentWithAi(team)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono bg-accent-purple/10 text-accent-purple hover:bg-accent-purple/20 transition-colors"
                        title="Add an agent to this team via AI"
                      >
                        <Sparkles className="w-3 h-3" /> Add Agent
                      </button>
                    )}
                    {!team.isBuiltIn && (
                      <>
                        <button
                          onClick={() => setDialog({ type: 'edit', team })}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono bg-accent-yellow/10 text-accent-yellow hover:bg-accent-yellow/20 transition-colors"
                          title="Edit team"
                        >
                          <Pencil className="w-3 h-3" /> Edit
                        </button>
                        <button
                          onClick={() => setDeleting(team)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono bg-accent-red/10 text-accent-red hover:bg-accent-red/20 transition-colors"
                          title="Delete team"
                        >
                          <Trash2 className="w-3 h-3" /> Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Expanded detail — sub-rows + mission */}
                {isExpanded && (
                  <div className="bg-surface-200/5 border-b border-border/15">
                    {/* Mission */}
                    {team.mission && (
                      <div className="px-8 py-2.5 border-b border-border/10">
                        <span className="text-[10px] font-label uppercase tracking-widest text-theme-subtle mr-2">Mission:</span>
                        <span className="text-[11px] text-theme-muted italic font-body">{team.mission}</span>
                      </div>
                    )}

                    {/* Members sub-header */}
                    <div className="flex items-center gap-4 px-8 pl-16 py-1.5 text-[9px] font-label uppercase tracking-widest text-theme-subtle border-b border-border/10">
                      <span className="w-6" />
                      <span className="flex-1">Agent</span>
                      <span className="w-16 text-center">Role</span>
                    </div>

                    {/* Lead member */}
                    {lead && (
                      <div className="flex items-center gap-4 px-8 pl-16 py-2.5 border-b border-border/8 hover:bg-surface-200/10 transition-colors">
                        <div className="w-6 h-6 rounded-lg bg-accent-yellow/10 flex items-center justify-center shrink-0">
                          <Crown className="w-3 h-3 text-accent-yellow" />
                        </div>
                        <span className="flex-1 text-xs font-mono text-theme-primary">{lead.displayName ?? lead.name}</span>
                        <span className="w-16 text-center text-[9px] font-mono px-1.5 py-0.5 rounded-full bg-accent-yellow/10 text-accent-yellow">Lead</span>
                      </div>
                    )}

                    {/* Other members */}
                    {otherMembers.map((m) => (
                      <div key={m.name} className="flex items-center gap-4 px-8 pl-16 py-2.5 border-b border-border/8 hover:bg-surface-200/10 transition-colors">
                        <div className="w-6 h-6 rounded-lg bg-surface-200/30 flex items-center justify-center shrink-0">
                          <div className="w-1.5 h-1.5 rounded-full bg-theme-muted" />
                        </div>
                        <span className="flex-1 text-xs font-mono text-theme-secondary">{m.displayName ?? m.name}</span>
                        <span className="w-16 text-center text-[9px] font-mono text-theme-muted">Member</span>
                      </div>
                    ))}

                    {members.length === 0 && (
                      <div className="px-8 pl-16 py-3 text-[11px] text-theme-muted italic font-body">
                        No members yet
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Modals */}
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

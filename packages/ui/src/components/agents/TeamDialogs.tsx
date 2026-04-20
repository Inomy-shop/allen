import { useEffect, useState } from 'react';
import { X, AlertCircle } from 'lucide-react';

export interface Team {
  _id?: string;
  name: string;
  displayName: string;
  description: string;
  mission?: string;
  leadAgentName: string;
  parentTeamName?: string;
  isBuiltIn: boolean;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface AgentOption {
  name: string;
  displayName?: string;
}

export type TeamDialogMode =
  | { type: 'closed' }
  | { type: 'create' }
  | { type: 'edit'; team: Team };

export function TeamDialog({
  mode, allAgents, allTeams, onClose, onSubmit,
}: {
  mode: TeamDialogMode;
  allAgents: AgentOption[];
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

export function TeamDeleteConfirm({
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

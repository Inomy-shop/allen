import { useEffect, useState } from 'react';
import { AlertCircle, Trash2, Users, X } from 'lucide-react';
import IconTooltipButton from '../common/IconTooltipButton';
import Select from '../common/Select';

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-[620px] flex-col overflow-hidden rounded-md border border-app bg-app-card shadow-[0_24px_80px_rgba(0,0,0,0.34)] animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-start justify-between gap-4 border-b border-app px-6 py-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-app bg-app text-accent">
              <Users className="h-[18px] w-[18px]" />
            </span>
            <div className="min-w-0">
              <h3 className="text-[17px] font-semibold tracking-tight text-theme-primary">
                {isEdit ? 'Edit team' : 'New team'}
              </h3>
              <p className="mt-1 text-[13px] text-theme-muted">
                {isEdit
                  ? `Update ${mode.team.displayName}. Slug and lead are locked after creation.`
                  : 'Create a new team. The lead agent must already exist.'}
              </p>
            </div>
          </div>
          <IconTooltipButton label="Close" onClick={onClose} className="h-9 w-9">
            <X className="h-4 w-4" />
          </IconTooltipButton>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-[13px] text-accent-red">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="overline mb-2 block">
                Slug (lowercase, hyphenated)
              </span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
                disabled={isEdit}
                placeholder="finance"
                className="h-10 w-full rounded-md border border-app bg-app-muted px-3 font-mono text-[13px] text-theme-primary outline-none placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>

            <label className="block">
              <span className="overline mb-2 block">
                Display Name
              </span>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Finance Team"
                className="h-10 w-full rounded-md border border-app bg-app-muted px-3 text-[13px] text-theme-primary outline-none placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
              />
            </label>
          </div>

          <label className="block">
            <span className="overline mb-2 block">
                Description
            </span>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Manages financial planning, accounting, and reporting"
                className="h-10 w-full rounded-md border border-app bg-app-muted px-3 text-[13px] text-theme-primary outline-none placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
              />
          </label>

          <label className="block">
            <span className="overline mb-2 block">
                Mission
            </span>
              <textarea
                value={mission}
                onChange={(e) => setMission(e.target.value)}
                rows={3}
                placeholder="The Finance team is responsible for..."
                className="min-h-[92px] w-full resize-none rounded-md border border-app bg-app-muted px-3 py-2 text-[13px] text-theme-primary outline-none placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
              />
          </label>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="overline mb-2 block">
                Lead Agent
              </span>
              <Select
                value={leadAgentName}
                onChange={setLeadAgentName}
                disabled={isEdit}
                placeholder="Pick an agent"
                searchPlaceholder="Search agents..."
                options={allAgents.map((agent) => ({
                  value: agent.name,
                  label: agent.displayName ?? agent.name,
                  sublabel: agent.name,
                }))}
              />
            </label>

            <label className="block">
              <span className="overline mb-2 block">
                Parent Team (optional)
              </span>
              <Select
                value={parentTeamName}
                onChange={setParentTeamName}
                placeholder="Top-level"
                searchPlaceholder="Search teams..."
                options={[
                  { value: '', label: 'Top-level', sublabel: 'No parent team' },
                  ...allTeams.map((team) => ({
                    value: team.name,
                    label: team.displayName,
                    sublabel: team.name,
                  })),
                ]}
              />
            </label>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-app px-6 py-4">
          <button onClick={onClose} disabled={busy} className="btn btn-secondary btn-sm">Cancel</button>
          <button onClick={handleSubmit} disabled={busy} className="btn btn-primary btn-sm">
            {busy ? 'Saving...' : isEdit ? 'Save changes' : 'Create team'}
          </button>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm">
      <div className="w-full max-w-[460px] overflow-hidden rounded-md border border-app bg-app-card shadow-[0_24px_80px_rgba(0,0,0,0.34)] animate-in fade-in zoom-in-95 duration-200">
        <div className="border-b border-app px-6 py-5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-md border border-accent-red/30 bg-accent-red/10 text-accent-red">
              <Trash2 className="h-[18px] w-[18px]" />
            </span>
            <div>
              <h3 className="text-[17px] font-semibold tracking-tight text-theme-primary">Delete team?</h3>
              <p className="mt-1 text-[13px] text-theme-muted">{team.displayName}</p>
            </div>
          </div>
        </div>

        <div className="space-y-4 px-6 py-5">
          {memberCount > 0 ? (
            <div className="flex items-start gap-2 rounded-md border border-accent-yellow/30 bg-accent-yellow/10 px-3 py-2 text-[13px] text-accent-yellow">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                <strong>Cannot delete:</strong> "{team.displayName}" still has {memberCount} agent(s).
                Move or delete them first.
              </span>
            </div>
          ) : (
            <div className="text-[13px] leading-6 text-theme-muted">
              <p>
                This will permanently remove <span className="font-mono text-theme-primary">{team.name}</span> from
                the org chart.
              </p>
              <p className="mt-2">
                Deleted teams can be recovered by recreating with the same name.
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-app px-6 py-4">
          <button onClick={onCancel} disabled={busy} className="btn btn-secondary btn-sm">Cancel</button>
          <button
            onClick={handleConfirm}
            disabled={busy || memberCount > 0}
            className="btn btn-danger btn-sm disabled:opacity-30"
          >
            {busy ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

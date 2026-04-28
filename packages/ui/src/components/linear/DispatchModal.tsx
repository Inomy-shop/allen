import { useEffect, useState } from 'react';
import { AlertCircle, FolderGit2, Loader2, Play, Sparkles, X } from 'lucide-react';
import AgentAssignDropdown, { type AgentOption, type TeamOption } from '../agents/AgentAssignDropdown';

interface Repo {
  _id: string;
  name: string;
  path?: string;
}

export interface DispatchModalProps {
  open: boolean;
  issue: {
    id: string;
    identifier: string;
    title: string;
  };
  currentAgent: string | null;
  agents: AgentOption[];
  teams: TeamOption[];
  repos: Repo[];
  reposLoading: boolean;
  onClose: () => void;
  onSubmit: (args: { agentName: string; repoId: string; extraInstructions: string }) => Promise<void>;
}

export default function DispatchModal({
  open, issue, currentAgent, agents, teams, repos, reposLoading, onClose, onSubmit,
}: DispatchModalProps) {
  const [agentName, setAgentName] = useState<string | null>(null);
  const [repoId, setRepoId] = useState<string>('');
  const [extra, setExtra] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAgentName(currentAgent ?? null);
    setRepoId('');
    setExtra('');
    setError(null);
    setSubmitting(false);
  }, [open, currentAgent]);

  if (!open) return null;

  const selectedRepo = repos.find(r => String(r._id) === repoId);

  async function submit() {
    setError(null);
    if (!agentName) { setError('Pick an agent to dispatch to'); return; }
    if (!repoId) { setError('Pick a repository — the agent needs a workspace to work in'); return; }
    setSubmitting(true);
    try {
      await onSubmit({ agentName, repoId, extraInstructions: extra.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dispatch');
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md" onClick={onClose}>
      <div className="bg-surface-100 border border-border rounded-lg w-full max-w-xl shadow-popover animate-in fade-in zoom-in-95 duration-200 overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-4 border-b border-border/60 flex items-center justify-between">
          <div>
            <h2 className="font-heading text-sm font-bold text-theme-primary tracking-widest uppercase">Dispatch to agent</h2>
            <div className="mt-0.5 text-[11px] font-mono text-theme-muted">
              <span className="text-theme-subtle">{issue.identifier}</span> · {issue.title}
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md text-theme-muted hover:text-theme-primary hover:bg-surface-200/50">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          <div>
            <label className="overline font-semibold mb-1.5 block">
              <Sparkles className="inline w-3 h-3 text-accent-blue mr-1" /> Agent
            </label>
            <AgentAssignDropdown
              value={agentName}
              onChange={setAgentName}
              agents={agents}
              teams={teams}
              placeholder="Pick an agent or team lead…"
              allowClear={false}
            />
            <div className="mt-1 text-[10px] font-mono text-theme-subtle">
              Team leads are highlighted. Search by agent or team name.
            </div>
          </div>

          <div>
            <label className="overline font-semibold mb-1.5 block">
              <FolderGit2 className="inline w-3 h-3 text-accent-purple mr-1" /> Repository
            </label>
            <select
              value={repoId}
              onChange={e => setRepoId(e.target.value)}
              disabled={reposLoading}
              className="w-full px-3 py-2 rounded-lg bg-surface-200/40 border border-border/50 text-sm text-theme-primary focus:outline-none focus:border-accent-blue/50 disabled:opacity-50"
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
            <label className="overline font-semibold mb-1.5 block">
              Extra instructions <span className="text-theme-subtle normal-case">(optional)</span>
            </label>
            <textarea
              value={extra}
              onChange={e => setExtra(e.target.value)}
              rows={4}
              placeholder="Any additional context beyond the ticket body…"
              className="w-full px-3 py-2 rounded-lg bg-surface-200/40 border border-border/50 text-sm text-theme-primary placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/50 resize-y"
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
        <div className="px-5 py-3.5 border-t border-border/60 bg-surface-200/10 flex items-center justify-between">
          <div className="text-[10px] font-mono text-theme-subtle">
            Workspace creates first, then the agent starts working in it.
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} disabled={submitting} className="btn-ghost text-xs">Cancel</button>
            <button
              onClick={submit}
              disabled={submitting || !agentName || !repoId}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[11px] font-mono bg-accent-green/10 text-accent-green hover:bg-accent-green/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              {submitting ? 'Dispatching…' : 'Dispatch'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

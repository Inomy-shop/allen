import { Crown, Play, Pencil, Trash2, Eye, ArrowRight, FolderGit2 } from 'lucide-react';
import RoleIcon from '../common/RoleIcon';

interface AgentCardProps {
  agent: Record<string, unknown>;
  onEdit: (agent: Record<string, unknown>) => void;
  onDelete: (name: string) => void;
  onRun: (agent: Record<string, unknown>) => void;
  onView: (agent: Record<string, unknown>) => void;
  selected?: boolean;
  onToggleSelect?: (name: string) => void;
}

export function AgentCard({
  agent, onEdit, onDelete, onRun, onView, selected, onToggleSelect,
}: AgentCardProps) {
  const isLead = agent.teamRole === 'lead';
  const isBuiltIn = !!agent.isBuiltIn;
  const capabilities = (agent.capabilities as string[] | undefined) ?? [];
  const delegateTargets = (agent.canDelegateTo as string[] | undefined) ?? [];
  const fromRepo = !!agent.sourceRepoId;
  const provider = String(agent.provider ?? 'claude');
  const model = String(agent.model ?? 'sonnet');
  const color = (agent.color as string) ?? '#666';
  const displayName = (agent.displayName as string) ?? (agent.name as string);
  const name = agent.name as string;
  const description = (agent.description as string) ?? '';

  const providerTone =
    provider === 'codex' ? 'bg-accent-green/10 text-accent-green border-accent-green/30'
    : provider === 'openai' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
    : 'bg-accent-blue/10 text-accent-blue border-accent-blue/30';

  return (
    <div
      className={`group relative rounded-xl border border-border/40 bg-surface-100/40 hover:bg-surface-100/70 hover:border-border/70 transition-all p-4 ${
        selected ? 'ring-1 ring-accent-blue/50 border-accent-blue/50' : ''
      } ${isLead ? 'bg-accent-yellow/[0.03]' : ''}`}
    >
      <div className="flex items-start gap-4">
        {/* Selection checkbox */}
        <input
          type="checkbox"
          checked={!!selected}
          disabled={isBuiltIn}
          onChange={() => onToggleSelect?.(name)}
          title={isBuiltIn ? 'Built-in agents cannot be moved' : 'Select'}
          className="mt-1 shrink-0"
        />

        {/* Agent icon */}
        <button
          onClick={() => onView(agent)}
          className="w-12 h-12 rounded-lg flex items-center justify-center shrink-0 hover:opacity-80 transition-opacity border border-border/30"
          style={{ backgroundColor: color + '18' }}
          title="View instructions"
        >
          <RoleIcon icon={agent.icon as string} color={color} size={22} />
        </button>

        {/* Identity + description + capabilities */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <button
              onClick={() => onView(agent)}
              className="text-sm font-heading font-semibold text-theme-primary tracking-wide truncate text-left hover:underline decoration-dotted underline-offset-4"
            >
              {displayName}
            </button>
            {isLead && (
              <span
                title="Team lead"
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-mono bg-accent-yellow/10 text-accent-yellow border border-accent-yellow/30"
              >
                <Crown className="w-2.5 h-2.5" /> Lead
              </span>
            )}
            {fromRepo && (
              <span
                title={`Imported from ${agent.sourceFile ?? 'repo'}`}
                className="inline-flex items-center gap-0.5 text-[9px] font-mono px-1.5 py-0.5 rounded-full bg-accent-purple/10 text-accent-purple border border-accent-purple/20"
              >
                <FolderGit2 className="w-2.5 h-2.5" /> repo
              </span>
            )}
            {isBuiltIn && (
              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full bg-surface-200/60 text-theme-muted">
                built-in
              </span>
            )}
          </div>
          <div className="text-[10px] font-mono text-theme-subtle truncate">
            {name}
            {description ? <span className="text-theme-muted"> · {description}</span> : null}
          </div>
          {capabilities.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap mt-2">
              {capabilities.slice(0, 6).map(cap => (
                <span
                  key={cap}
                  className="text-[9px] font-mono px-2 py-0.5 rounded-full bg-accent-purple/8 text-accent-purple/80 border border-accent-purple/15"
                >
                  {cap}
                </span>
              ))}
              {capabilities.length > 6 && (
                <span className="text-[9px] text-theme-subtle">+{capabilities.length - 6}</span>
              )}
            </div>
          )}
          {delegateTargets.length > 0 && (
            <div className="flex items-center gap-1 text-[10px] font-mono text-theme-muted mt-2">
              <ArrowRight className="w-3 h-3 text-accent-blue" />
              delegates to {delegateTargets.length} agent{delegateTargets.length === 1 ? '' : 's'}
            </div>
          )}
        </div>

        {/* Provider + model stacked badge */}
        <div
          className={`shrink-0 rounded-lg border overflow-hidden text-center ${providerTone}`}
          style={{ minWidth: '7rem' }}
        >
          <div className="text-[9px] font-label uppercase tracking-widest px-3 py-1 border-b border-current/20 opacity-80">
            {provider}
          </div>
          <div className="text-[11px] font-mono px-3 py-1.5 text-theme-primary bg-surface-100/40">
            {model}
          </div>
        </div>
      </div>

      {/* Actions — second row */}
      <div className="flex items-center justify-end gap-1.5 mt-3 pt-3 border-t border-border/30">
        <button
          onClick={() => onView(agent)}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20 transition-colors"
        >
          <Eye className="w-3 h-3" /> View
        </button>
        <button
          onClick={() => onRun(agent)}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono bg-accent-green/10 text-accent-green hover:bg-accent-green/20 transition-colors"
        >
          <Play className="w-3 h-3" /> Run
        </button>
        <button
          onClick={() => onEdit(agent)}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono bg-accent-yellow/10 text-accent-yellow hover:bg-accent-yellow/20 transition-colors"
        >
          <Pencil className="w-3 h-3" /> Edit
        </button>
        {!isBuiltIn && (
          <button
            onClick={() => onDelete(name)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono bg-accent-red/10 text-accent-red hover:bg-accent-red/20 transition-colors"
          >
            <Trash2 className="w-3 h-3" /> Delete
          </button>
        )}
      </div>
    </div>
  );
}

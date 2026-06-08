import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { DesignRoutingDecision } from '../../services/designService';

interface DesignRoutingSelectorProps {
  decision: DesignRoutingDecision | null;
  onChange: (overrideKey: string) => void;
  disabled?: boolean;
}

const OVERRIDE_OPTIONS: Array<{ key: string; label: string }> = [
  { key: 'auto', label: 'Auto (recommended)' },
  { key: 'full_workflow', label: 'Full design workflow' },
  { key: 'fast_frontend', label: 'Fast frontend update' },
  { key: 'design_refinement', label: 'Design refinement' },
  { key: 'design_review', label: 'Design review' },
];

function resolveLabel(decision: DesignRoutingDecision): string {
  if (decision.mode === 'workflow') {
    if (decision.workflowName === 'source-prd-to-ui-designs-variations') return 'Full design workflow';
    return 'Full design workflow';
  }
  if (decision.agentName === 'frontend-developer') return 'Fast frontend update';
  if (decision.agentName === 'design-iteration-refiner') return 'Design refinement';
  if (decision.agentName === 'design-critic') return 'Design review';
  return decision.agentName ?? 'Agent run';
}

function resolveRunner(decision: DesignRoutingDecision): string {
  if (decision.workflowName) return decision.workflowName;
  if (decision.agentName) return decision.agentName;
  return '';
}

export default function DesignRoutingSelector({ decision, onChange, disabled }: DesignRoutingSelectorProps) {
  const [open, setOpen] = useState(false);

  if (!decision) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-theme-subtle">
        <span>Routing: auto</span>
      </div>
    );
  }

  const label = resolveLabel(decision);
  const runner = resolveRunner(decision);

  return (
    <div className="relative flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] font-medium text-theme-primary">{label}</span>
          {runner && (
            <span className="font-mono text-[11px] text-theme-muted">{runner}</span>
          )}
        </div>
        {decision.reason && (
          <p className="mt-0.5 text-[11px] text-theme-muted">{decision.reason}</p>
        )}
      </div>

      <div className="relative shrink-0">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          aria-label="Change routing"
          className="inline-flex items-center gap-1 rounded-md border border-app bg-app px-2 py-1 text-[11.5px] font-medium text-theme-secondary transition-colors hover:border-app-strong hover:text-theme-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          Change
          <ChevronDown className="h-3 w-3" />
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div className="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-lg border border-app bg-app-card shadow-popover">
              {OVERRIDE_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => {
                    onChange(opt.key);
                    setOpen(false);
                  }}
                  className="flex w-full items-center px-3 py-2 text-left text-[12.5px] text-theme-secondary transition-colors hover:bg-app-muted hover:text-theme-primary"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

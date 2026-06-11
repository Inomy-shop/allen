import { GitBranch, Plus } from 'lucide-react';

interface DesignSetupPanelProps {
  onOnboard: () => void;
  onBootstrap: () => void;
}

export default function DesignSetupPanel({ onOnboard, onBootstrap }: DesignSetupPanelProps) {
  return (
    <div className="w-full max-w-md rounded-xl border border-app bg-app-card p-8 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-app bg-app-muted mx-auto">
        <GitBranch className="h-6 w-6 text-theme-muted" />
      </div>
      <h2 className="text-[18px] font-semibold text-theme-primary">Set up Design</h2>
      <p className="mt-2 text-[13px] text-theme-muted">
        Connect a design or prototyping repository to start generating UI designs and prototypes with Allen.
      </p>
      <div className="mt-6 flex flex-col gap-3">
        <button
          type="button"
          onClick={onOnboard}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-app bg-app px-4 py-2.5 text-[13px] font-medium text-theme-primary transition-colors hover:border-app-strong hover:bg-app-muted"
        >
          <GitBranch className="h-4 w-4 text-theme-muted" />
          Onboard existing design/prototyping repo
        </button>
        <button
          type="button"
          onClick={onBootstrap}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-accent/30 bg-accent-soft px-4 py-2.5 text-[13px] font-medium text-accent transition-colors hover:bg-accent/20"
        >
          <Plus className="h-4 w-4" />
          Create from ui-designs template
        </button>
      </div>
    </div>
  );
}

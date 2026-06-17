import { useState, useEffect } from 'react';
import { workspaces } from '../../services/workspaceService';
import { Loader2, X, XCircle } from 'lucide-react';
import IconTooltipButton from '../common/IconTooltipButton';

interface Props {
  workspaceId: string;
  onComplete: (ws: any) => void;
  onFailed: (error: string) => void;
  onCancel?: (workspaceId: string) => void;
}

export function SetupProgressDialog({ workspaceId, onComplete, onFailed, onCancel }: Props) {
  const [ws, setWs] = useState<any>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState('');

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      while (alive) {
        try {
          const data = await workspaces.get(workspaceId);
          if (!alive) return;
          setWs(data);
          if (data.status === 'active' || data.status === 'running') { onComplete(data); return; }
          if (data.status === 'failed') { onFailed(data.setupProgress?.log?.slice(-1)[0] ?? 'Setup failed'); return; }
        } catch {}
        await new Promise(r => setTimeout(r, 2000));
      }
    };
    poll();
    return () => { alive = false; };
  }, [workspaceId]);

  async function handleCancel() {
    if (!onCancel || cancelling) return;
    setCancelling(true);
    setCancelError('');
    try {
      await workspaces.archive(workspaceId);
      onCancel(workspaceId);
    } catch (err: any) {
      setCancelError(err?.message ?? 'Failed to cancel workspace creation.');
      setCancelling(false);
    }
  }

  const progress = ws?.setupProgress;
  const log = progress?.log ?? [];

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-surface-100 border border-app rounded-lg w-[500px] overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-app">
          {ws?.status === 'failed' ? (
            <XCircle className="w-4 h-4 text-accent-red" />
          ) : (
            <Loader2 className="w-4 h-4 text-accent animate-spin" />
          )}
          <span className="text-sm font-semibold text-theme-primary">
            {ws?.status === 'failed' ? 'Setup Failed' : 'Setting up workspace...'}
          </span>
          <span className="text-[10px] font-mono text-theme-muted">{ws?.name}</span>
          {onCancel && (
            <IconTooltipButton
              label="Cancel workspace creation"
              onClick={handleCancel}
              disabled={cancelling}
              className="ml-auto h-8 w-8"
            >
              {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
            </IconTooltipButton>
          )}
        </div>

        {/* Progress */}
        <div className="px-4 py-3">
          {cancelError && (
            <div className="mb-3 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-[12px] text-accent-red">{cancelError}</div>
          )}
          {progress && (
            <div className="mb-3">
              <div className="flex items-center justify-between text-[10px] text-theme-muted mb-1">
                <span>Step {progress.currentStep}/{progress.totalSteps}</span>
                <span className="font-mono">{progress.currentCommand}</span>
              </div>
              <div className="h-1.5 bg-surface-200 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${ws?.status === 'failed' ? 'bg-red-400' : 'bg-blue-400'}`}
                  style={{ width: `${(progress.currentStep / progress.totalSteps) * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* Log */}
          <div className="bg-[rgb(var(--color-editor-background))] rounded p-3 max-h-48 overflow-y-auto font-mono text-[10px] space-y-1">
            {log.length === 0 && ws?.status !== 'failed' && (
              <div className="text-theme-subtle animate-pulse">Initializing workspace...</div>
            )}
            {log.map((line: string, i: number) => (
              <div key={i} className={line.startsWith('✓') ? 'text-accent-green' : line.startsWith('✗') ? 'text-accent-red' : 'text-theme-muted'}>
                {line.split('\n')[0]}
              </div>
            ))}
            {ws?.status !== 'failed' && progress?.status === 'running' && (
              <div className="text-accent animate-pulse">Running: {progress.currentCommand}...</div>
            )}
          </div>
        </div>

        {/* Footer */}
        {ws?.status === 'failed' && (
          <div className="px-4 py-3 border-t border-app flex justify-end">
            <button onClick={() => onFailed('Setup failed')} className="btn-ghost text-xs">Close</button>
          </div>
        )}
      </div>
    </div>
  );
}

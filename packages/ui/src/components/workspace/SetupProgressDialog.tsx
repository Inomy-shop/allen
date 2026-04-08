import { useState, useEffect } from 'react';
import { workspaces } from '../../services/workspaceService';
import { Loader2, CheckCircle, XCircle, Terminal } from 'lucide-react';

interface Props {
  workspaceId: string;
  onComplete: (ws: any) => void;
  onFailed: (error: string) => void;
}

export function SetupProgressDialog({ workspaceId, onComplete, onFailed }: Props) {
  const [ws, setWs] = useState<any>(null);

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

  const progress = ws?.setupProgress;
  const log = progress?.log ?? [];

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-surface-100 border border-border/30 rounded-lg w-[500px] overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/20">
          {ws?.status === 'failed' ? (
            <XCircle className="w-4 h-4 text-red-400" />
          ) : (
            <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
          )}
          <span className="text-sm font-semibold text-white">
            {ws?.status === 'failed' ? 'Setup Failed' : 'Setting up workspace...'}
          </span>
          <span className="text-[10px] font-mono text-gray-500">{ws?.name}</span>
        </div>

        {/* Progress */}
        <div className="px-4 py-3">
          {progress && (
            <div className="mb-3">
              <div className="flex items-center justify-between text-[10px] text-gray-500 mb-1">
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
          <div className="bg-[rgb(13,17,28)] rounded p-3 max-h-48 overflow-y-auto font-mono text-[10px] space-y-1">
            {log.length === 0 && ws?.status !== 'failed' && (
              <div className="text-gray-600 animate-pulse">Initializing workspace...</div>
            )}
            {log.map((line: string, i: number) => (
              <div key={i} className={line.startsWith('✓') ? 'text-emerald-400' : line.startsWith('✗') ? 'text-red-400' : 'text-gray-500'}>
                {line.split('\n')[0]}
              </div>
            ))}
            {ws?.status !== 'failed' && progress?.status === 'running' && (
              <div className="text-blue-400 animate-pulse">Running: {progress.currentCommand}...</div>
            )}
          </div>
        </div>

        {/* Footer */}
        {ws?.status === 'failed' && (
          <div className="px-4 py-3 border-t border-border/20 flex justify-end">
            <button onClick={() => onFailed('Setup failed')} className="btn-ghost text-xs">Close</button>
          </div>
        )}
      </div>
    </div>
  );
}

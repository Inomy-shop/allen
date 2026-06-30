import { AlertTriangle, Info } from 'lucide-react';
import type { ChatSession } from '../../hooks/useChat';

interface Props {
  session: ChatSession;
}

export default function ImportedChatBanner({ session }: Props) {
  if (!session.isImported) return null;

  const env = session.sourceEnvironment;

  return (
    <div className="border-b border-yellow-400/30 bg-yellow-50/60 px-5 py-3">
      <div className="flex items-start gap-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" aria-hidden="true" />
        <div className="min-w-0 text-[12px] leading-relaxed">
          <p className="text-yellow-800">
            <strong>Imported replay.</strong> This chat was generated in another Allen environment and is read-only.
            You can review messages, logs, tool calls, executions, and artifacts, but you cannot continue
            the original session.
          </p>
          {env && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-yellow-700/80">
              {(env.appName || env.appVersion) && (
                <span>
                  Original source:{' '}
                  {[env.appName, env.appVersion].filter(Boolean).join(' ')}
                </span>
              )}
              {env.hostname && <span>Host: {env.hostname}</span>}
              {env.exportedAt && (
                <span>
                  Exported:{' '}
                  {new Date(env.exportedAt).toLocaleString()}
                </span>
              )}
              <span className="flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                These references may not resolve on this system.
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

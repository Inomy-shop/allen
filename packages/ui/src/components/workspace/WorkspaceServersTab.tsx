import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Play, RotateCw, Square, Terminal } from 'lucide-react';
import { openExternalUrl, previewUrlFor } from '../../lib/workspace-preview';
import { sendTerminalInput, XTerminal } from './XTerminal';

export type WorkspaceServiceSummary = {
  name: string;
  command?: string;
  port: number;
  status?: string;
  healthCheck?: string;
};

type Props = {
  workspaceId: string;
  services?: WorkspaceServiceSummary[] | null;
};

type RunningServer = {
  name: string;
  terminalId: string;
  commandOnConnect?: string;
};

function terminalIdFor(serviceName: string): string {
  return `server-${serviceName.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function runningStorageKey(workspaceId: string): string {
  return `allen-workspace-running-servers:${workspaceId}`;
}

function readRunningServers(workspaceId: string): RunningServer[] {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(runningStorageKey(workspaceId)) ?? '[]') as RunningServer[];
    return Array.isArray(parsed)
      ? parsed
          .filter(item => typeof item?.name === 'string' && typeof item?.terminalId === 'string')
          .map(item => ({ name: item.name, terminalId: item.terminalId }))
      : [];
  } catch {
    return [];
  }
}

function openPreview(url: string): void {
  if (!url) return;
  void openExternalUrl(url);
}

export default function WorkspaceServersTab({ workspaceId, services }: Props) {
  const configuredServices = useMemo(
    () => services?.filter(service => service.name && service.port) ?? [],
    [services],
  );
  const [selectedName, setSelectedName] = useState('');
  const [running, setRunning] = useState<RunningServer[]>(() => readRunningServers(workspaceId));
  const restartTimersRef = useRef<number[]>([]);

  useEffect(() => {
    try {
      localStorage.removeItem(runningStorageKey(workspaceId));
    } catch {}
    setRunning(readRunningServers(workspaceId));
  }, [workspaceId]);

  useEffect(() => {
    if (configuredServices.length === 0) {
      setSelectedName('');
      return;
    }
    if (!selectedName || !configuredServices.some(service => service.name === selectedName)) {
      setSelectedName(configuredServices[0].name);
    }
  }, [configuredServices, selectedName]);

  useEffect(() => {
    setRunning(current => current.filter(item => configuredServices.some(service => service.name === item.name)));
  }, [configuredServices]);

  useEffect(() => {
    return () => {
      for (const timer of restartTimersRef.current) window.clearTimeout(timer);
      restartTimersRef.current = [];
    };
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        runningStorageKey(workspaceId),
        JSON.stringify(running.map(item => ({ name: item.name, terminalId: item.terminalId }))),
      );
    } catch {}
  }, [running, workspaceId]);

  const selected = configuredServices.find(service => service.name === selectedName) ?? configuredServices[0] ?? null;
  const runningNames = new Set(running.map(item => item.name));
  const selectedRunning = Boolean(selected && runningNames.has(selected.name));

  function startService(serviceName: string) {
    const service = configuredServices.find(item => item.name === serviceName);
    if (!service?.command?.trim()) {
      window.alert(`No command configured for ${serviceName}`);
      return;
    }
    setSelectedName(serviceName);
    setRunning(current => {
      if (current.some(item => item.name === serviceName)) return current;
      return [...current, { name: serviceName, terminalId: terminalIdFor(serviceName), commandOnConnect: service.command }];
    });
  }

  function interruptService(serviceName: string): void {
    const item = running.find(candidate => candidate.name === serviceName);
    if (!item) return;
    sendTerminalInput('workspace', workspaceId, item.terminalId, '\x03');
  }

  function stopService(serviceName: string) {
    interruptService(serviceName);
    const timer = window.setTimeout(() => {
      setRunning(current => current.filter(item => item.name !== serviceName));
    }, 150);
    restartTimersRef.current.push(timer);
  }

  function restartService(serviceName: string) {
    const service = configuredServices.find(item => item.name === serviceName);
    if (!service?.command?.trim()) {
      window.alert(`No command configured for ${serviceName}`);
      return;
    }
    setSelectedName(serviceName);
    interruptService(serviceName);
    setRunning(current => current.filter(item => item.name !== serviceName));
    const timer = window.setTimeout(() => {
      setRunning(current => [...current.filter(item => item.name !== serviceName), { name: serviceName, terminalId: terminalIdFor(serviceName), commandOnConnect: service.command }]);
    }, 350);
    restartTimersRef.current.push(timer);
  }

  useEffect(() => {
    function handleStopAll(event: Event) {
      const detail = (event as CustomEvent<{ workspaceId?: string }>).detail;
      if (detail?.workspaceId !== workspaceId) return;
      for (const item of running) {
        sendTerminalInput('workspace', workspaceId, item.terminalId, '\x03');
      }
      try {
        sessionStorage.setItem(runningStorageKey(workspaceId), '[]');
      } catch {}
      setRunning([]);
    }
    window.addEventListener('allen:workspace-servers-stop', handleStopAll);
    return () => window.removeEventListener('allen:workspace-servers-stop', handleStopAll);
  }, [running, workspaceId]);

  if (configuredServices.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-app text-xs text-theme-subtle">
        No workspace servers are configured for this workspace.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 bg-app">
      <aside className="ws-servers-list w-[260px] shrink-0">
        {configuredServices.map(service => {
          const active = service.name === selected?.name;
          const isRunning = runningNames.has(service.name);
          return (
            <div
              key={service.name}
              className={`ws-server-row ${active ? 'active' : ''}`}
            >
              <button
                type="button"
                onClick={() => setSelectedName(service.name)}
                className="ws-server-select"
              >
                <span className={`ws-server-dot ${isRunning ? 'running' : ''}`} />
                <span className="ws-server-main">
                  <strong>{service.name}</strong>
                  <span className="ws-server-meta">
                    <span>:{service.port}</span>
                  </span>
                </span>
              </button>
            </div>
          );
        })}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="ws-server-toolbar">
          <Terminal className="h-3.5 w-3.5 text-theme-muted" />
          <span className="ws-server-title">
            <span className="min-w-0 truncate">{selected?.name}</span>
          </span>
          {selected && <span className="font-mono text-[10px] text-theme-subtle">:{selected.port}</span>}
          <span className={`ws-server-header-status ${selected && runningNames.has(selected.name) ? 'running' : ''}`}>
            {selected && runningNames.has(selected.name) ? 'running' : 'stopped'}
          </span>
          <span className="flex-1" />
          {selected && (
            <div className="flex items-center gap-1">
              {runningNames.has(selected.name) ? (
                <>
                  <button type="button" onClick={() => restartService(selected.name)} className="btn btn-secondary btn-sm" title="Send Ctrl+C and run again">
                    <RotateCw className="h-3 w-3" />
                    Restart
                  </button>
                  <button type="button" onClick={() => stopService(selected.name)} className="btn btn-secondary btn-sm" title="Send Ctrl+C">
                    <Square className="h-3 w-3" />
                    Stop
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => startService(selected.name)} className="btn btn-primary btn-sm" title="Run command in terminal">
                  <Play className="h-3 w-3" />
                  Run
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (selectedRunning) openPreview(previewUrlFor(selected, workspaceId));
                }}
                disabled={!selectedRunning}
                className="btn btn-secondary btn-sm disabled:cursor-not-allowed disabled:opacity-50"
                title={selectedRunning ? 'Open preview in browser' : 'Run the server to enable preview'}
              >
                <ExternalLink className="h-3 w-3" />
                Preview
              </button>
            </div>
          )}
        </div>
        <div className="relative min-h-0 flex-1 bg-[#0b0f14]">
          {!selectedRunning && (
            <div className="flex h-full items-center justify-center px-6 text-center text-xs text-theme-subtle">
              {selected ? `Run ${selected.name} to open a terminal. Logs will appear in that terminal.` : 'Select a configured server and run it to open a terminal.'}
            </div>
          )}
          {running.map(item => {
            const service = configuredServices.find(candidate => candidate.name === item.name);
            if (!service?.command) return null;
            const active = item.name === selected?.name;
            return (
              <div key={item.terminalId} className={`absolute inset-0 ${active ? '' : 'invisible pointer-events-none'}`}>
                <XTerminal
                  workspaceId={workspaceId}
                  terminalId={item.terminalId}
                  className="h-full"
                  initialCommand={item.commandOnConnect}
                />
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

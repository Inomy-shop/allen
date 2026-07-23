import type { ExecutionLog } from '../../hooks/useExecution';
import Timeline from './Timeline';

interface StructuredExecutionLogsProps {
  executionId: string;
  logs: ExecutionLog[];
  nodeFilter: string | null;
  workflowNodes: string[];
  traces: any[];
  isLive: boolean;
  loadedCount: number;
  hasOlderLogs: boolean;
  loadingInitial: boolean;
  loadingOlderLogs: boolean;
  error: string | null;
  onNodeFilterChange: (node: string | null) => void;
  onLoadOlderLogs: () => Promise<void> | void;
}

export default function StructuredExecutionLogs({
  executionId,
  logs,
  nodeFilter,
  workflowNodes,
  traces,
  isLive,
  loadedCount,
  hasOlderLogs,
  loadingInitial,
  loadingOlderLogs,
  error,
  onNodeFilterChange,
  onLoadOlderLogs,
}: StructuredExecutionLogsProps) {
  const nodeCount = new Set(logs.map(log => log.node).filter(Boolean)).size;
  const issueCount = logs.filter(log => log.level === 'warn' || log.level === 'error').length;

  return (
    <section className="v8-structured-log-view" aria-label="Execution logs">
      <header className="v8-structured-log-view__head">
        <div>
          <h3>
            Execution logs
            <span className={isLive ? 'live' : ''}><i />{isLive ? 'live' : 'captured'}</span>
          </h3>
          <p>
            {loadingInitial
              ? 'Loading the latest log history…'
              : `${logs.length} shown · ${nodeCount} ${nodeCount === 1 ? 'node' : 'nodes'} · ${issueCount} warnings or errors`}
          </p>
        </div>
        <div className="v8-structured-log-view__meta">
          <code title={executionId}>{executionId}</code>
          <span>{hasOlderLogs ? `${loadedCount} loaded · scroll up for older` : 'full history loaded'}</span>
        </div>
      </header>

      {error && <div className="v8-structured-log-view__error">{error}</div>}

      <div className="v8-structured-log-view__timeline">
        <Timeline
          logs={logs}
          nodeFilter={nodeFilter}
          onNodeFilterChange={onNodeFilterChange}
          workflowNodes={workflowNodes}
          hasOlderLogs={hasOlderLogs}
          loadingOlderLogs={loadingOlderLogs}
          onLoadOlderLogs={onLoadOlderLogs}
          traces={traces}
        />
      </div>
    </section>
  );
}

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionLog } from '../../hooks/useExecution';
import StructuredExecutionLogs from './StructuredExecutionLogs';

const logs: ExecutionLog[] = [
  {
    _id: 'log-1',
    executionId: 'exec-1',
    timestamp: new Date('2026-07-23T10:00:00.000Z'),
    level: 'info',
    category: 'agent',
    node: 'implement',
    message: 'Implementation completed',
  },
  {
    _id: 'log-2',
    executionId: 'exec-1',
    timestamp: new Date('2026-07-23T10:00:01.000Z'),
    level: 'warn',
    category: 'system',
    node: 'verify',
    message: 'Verification needs attention',
  },
];

describe('StructuredExecutionLogs', () => {
  it('turns the execution log dump into a searchable, categorized viewer', () => {
    render(
      <StructuredExecutionLogs
        executionId="exec-1"
        logs={logs}
        nodeFilter={null}
        workflowNodes={['implement', 'verify']}
        traces={[]}
        isLive
        loadedCount={2}
        hasOlderLogs={false}
        loadingInitial={false}
        loadingOlderLogs={false}
        error={null}
        onNodeFilterChange={vi.fn()}
        onLoadOlderLogs={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: /Execution logs/ })).toBeInTheDocument();
    expect(screen.getByText('2 shown · 2 nodes · 1 warnings or errors')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search logs...')).toBeInTheDocument();
    expect(screen.getByText('Implementation completed')).toBeInTheDocument();
    expect(screen.getByText('Verification needs attention')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search logs...'), { target: { value: 'attention' } });
    expect(screen.queryByText('Implementation completed')).not.toBeInTheDocument();
    expect(screen.getByText('Verification needs attention')).toBeInTheDocument();
  });
});

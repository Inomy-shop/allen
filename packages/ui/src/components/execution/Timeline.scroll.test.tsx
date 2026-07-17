import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionLog } from '../../hooks/useExecution';
import Timeline from './Timeline';

function log(overrides: Partial<ExecutionLog> = {}): ExecutionLog {
  return {
    _id: overrides._id ?? 'log-1',
    executionId: 'exec-1',
    timestamp: new Date('2026-07-17T10:00:00.000Z'),
    level: 'info',
    category: 'system',
    message: 'Log message',
    ...overrides,
  };
}

function renderTimeline(logs: ExecutionLog[]) {
  return render(
    <Timeline
      logs={logs}
      nodeFilter={null}
      onNodeFilterChange={vi.fn()}
      workflowNodes={[]}
    />,
  );
}

describe('Timeline scrolling', () => {
  it('renders variable-height log history without fixed-height virtual gaps', () => {
    const logs = Array.from({ length: 100 }, (_, index) => log({
      _id: `log-${index}`,
      timestamp: new Date(Date.parse('2026-07-17T10:00:00.000Z') + index * 1000),
      message: index === 99
        ? 'Last wrapped log '.repeat(20)
        : `Log message ${index}`,
    }));

    renderTimeline(logs);

    expect(screen.getByText('Log message 0')).toBeInTheDocument();
    expect(screen.getByText(/Last wrapped log/)).toBeInTheDocument();
  });

  it('does not resume live follow while the user is scrolling upward', () => {
    const firstLogs = [log({ _id: 'log-1', message: 'First log' })];
    const { rerender } = renderTimeline(firstLogs);
    const container = screen.getByTestId('execution-log-scroll');

    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1000 },
      scrollTop: { configurable: true, writable: true, value: 400 },
    });

    fireEvent.wheel(container, { deltaY: -100 });

    rerender(
      <Timeline
        logs={[...firstLogs, log({ _id: 'log-2', message: 'New live log' })]}
        nodeFilter={null}
        onNodeFilterChange={vi.fn()}
        workflowNodes={[]}
      />,
    );

    expect(container.scrollTop).toBe(400);
    expect(screen.getByTitle('Scroll to latest')).toBeInTheDocument();
  });

  it('keeps an expanded tool row open when older logs are prepended', () => {
    const toolLog = log({
      _id: 'tool-log',
      category: 'tool',
      message: 'Run tool',
      data: { tool: 'Bash', args: { command: 'npm test' }, toolUseId: 'tool-1' },
    });
    const { rerender } = renderTimeline([toolLog]);

    fireEvent.click(screen.getByText('Run tool'));
    expect(screen.getByText('Input')).toBeInTheDocument();
    expect(screen.getByText(/npm test/)).toBeInTheDocument();

    rerender(
      <Timeline
        logs={[
          log({ _id: 'older-log', timestamp: new Date('2026-07-17T09:59:00.000Z'), message: 'Older log' }),
          toolLog,
        ]}
        nodeFilter={null}
        onNodeFilterChange={vi.fn()}
        workflowNodes={[]}
      />,
    );

    expect(screen.getByText('Input')).toBeInTheDocument();
    expect(screen.getByText(/npm test/)).toBeInTheDocument();
  });
});

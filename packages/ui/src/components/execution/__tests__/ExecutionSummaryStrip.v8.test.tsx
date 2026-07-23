import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ExecutionSummaryStrip from '../ExecutionSummaryStrip';

describe('ExecutionSummaryStrip V8', () => {
  it('shows the prototype run metrics in a compact readable strip', () => {
    render(
      <ExecutionSummaryStrip
        completed={4}
        total={5}
        duration="31m 0s"
        cost={3.84}
        tokens="4.2M cache · 391K in · 48K out"
      />,
    );

    expect(screen.getByText('duration')).toBeInTheDocument();
    expect(screen.getByText('4 of 5 · 1 upcoming')).toBeInTheDocument();
    expect(screen.getByText('31m 0s')).toBeInTheDocument();
    expect(screen.getByText('$3.84')).toBeInTheDocument();
    expect(screen.getByText('4.2M cache · 391K in · 48K out')).toBeInTheDocument();
  });
});

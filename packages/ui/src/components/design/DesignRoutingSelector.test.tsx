import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DesignRoutingSelector from './DesignRoutingSelector';
import type { DesignRoutingDecision } from '../../services/designService';

const workflowDecision: DesignRoutingDecision = {
  mode: 'workflow',
  resolvedBy: 'auto',
  workflowName: 'source-prd-to-ui-designs-variations',
  reason: 'New design request with no existing output',
  outputMode: 'spec_only',
};

const agentDecision: DesignRoutingDecision = {
  mode: 'agent',
  resolvedBy: 'auto',
  agentName: 'frontend-developer',
  reason: 'Existing design session/workspace selected',
  outputMode: 'spec_only',
};

describe('DesignRoutingSelector', () => {
  it('shows Full design workflow label for workflow mode (REQ-029, AC-010)', () => {
    render(<DesignRoutingSelector decision={workflowDecision} onChange={() => {}} />);
    expect(screen.getByText(/Full design workflow/i)).toBeInTheDocument();
  });

  it('shows reason text', () => {
    render(<DesignRoutingSelector decision={workflowDecision} onChange={() => {}} />);
    expect(screen.getByText(/New design request/i)).toBeInTheDocument();
  });

  it('shows agent mode label', () => {
    render(<DesignRoutingSelector decision={agentDecision} onChange={() => {}} />);
    expect(screen.getByText(/Fast frontend update/i)).toBeInTheDocument();
  });

  it('calls onChange when user picks override (AC-011)', () => {
    const onChange = vi.fn();
    render(<DesignRoutingSelector decision={workflowDecision} onChange={onChange} />);
    // Click Change button to open dropdown
    fireEvent.click(screen.getByRole('button', { name: /change/i }));
    // Select fast_frontend option
    const fastFrontendOption = screen.getAllByText(/Fast frontend update/i)[0];
    fireEvent.click(fastFrontendOption);
    expect(onChange).toHaveBeenCalledWith('fast_frontend');
  });

  it('renders null-state message when decision is null', () => {
    render(<DesignRoutingSelector decision={null} onChange={() => {}} />);
    expect(screen.getByText(/Routing: auto/i)).toBeInTheDocument();
  });

  it('design_refinement agent maps to Design refinement label', () => {
    const refinementDecision: DesignRoutingDecision = {
      mode: 'agent',
      resolvedBy: 'auto',
      agentName: 'design-iteration-refiner',
      reason: 'Refining existing design',
      outputMode: 'spec_only',
    };
    render(<DesignRoutingSelector decision={refinementDecision} onChange={() => {}} />);
    expect(screen.getByText(/Design refinement/i)).toBeInTheDocument();
  });
});

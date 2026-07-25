import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OnboardingShell } from './OnboardingShell';

function renderShell(
  step: 'account' | 'health' | 'repository' | 'first_workflow' | 'complete',
  stepCopy?: {
    account?: string;
    health?: string;
    repository?: string;
    first_workflow?: string;
  },
) {
  return render(
    <OnboardingShell
      step={step}
      eyebrow="allen setup"
      title="Your engineering org, run by agents."
      description="Setup description"
      stepCopy={stepCopy}
    >
      <div>Page content</div>
    </OnboardingShell>,
  );
}

describe('OnboardingShell', () => {
  it('renders the four-step prototype path without a separate model step', () => {
    renderShell('repository');

    const path = screen.getByLabelText('Bootstrap path');
    const labels = within(path).getAllByText(/Account|Environment|Repository|First run/)
      .map(element => element.textContent);

    expect(labels).toEqual(['Account', 'Environment', 'Repository', 'First run']);
    expect(within(path).queryByText(/model defaults/i)).not.toBeInTheDocument();
  });

  it('shows page-provided completion details on the launch state', () => {
    renderShell('complete', {
      account: 'elena@company.com',
      health: '6 checks passed',
      repository: 'test-website · demo',
      first_workflow: 'bug-fix-by-severity',
    });

    const path = screen.getByLabelText('Bootstrap path');
    expect(within(path).getByText('elena@company.com')).toBeInTheDocument();
    expect(within(path).getByText('6 checks passed')).toBeInTheDocument();
    expect(within(path).getByText('test-website · demo')).toBeInTheDocument();
    expect(within(path).getByText('bug-fix-by-severity')).toBeInTheDocument();
    expect(path.querySelectorAll('.ob-step.done')).toHaveLength(4);
  });
});

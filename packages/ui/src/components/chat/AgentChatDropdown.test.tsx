import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AgentChatDropdown from './AgentChatDropdown';

describe('AgentChatDropdown V8 Home presentation', () => {
  it('uses the exact prototype assistant and caret glyphs', () => {
    const { container } = render(
      <AgentChatDropdown
        value={null}
        onChange={vi.fn()}
        agents={[]}
        variant="composer"
        controlPresentation="v8-home"
      />,
    );

    expect(screen.getByRole('button', { name: /Assistant/ })).toBeInTheDocument();
    expect(container.querySelector('[data-v8-icon="composer-user"]')).toBeInTheDocument();
    expect(container.querySelector('[data-v8-icon="chevron-down"]')).toBeInTheDocument();
  });
});

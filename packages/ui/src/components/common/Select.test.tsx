import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ProviderIcon from './ProviderIcon';
import Select from './Select';

describe('Select provider presentation', () => {
  it('aligns and preserves option icons in the trigger and listbox', () => {
    const onChange = vi.fn();
    render(
      <Select
        ariaLabel="Provider"
        value="claude"
        onChange={onChange}
        searchable={false}
        options={[
          { value: 'claude', label: 'Claude', icon: <ProviderIcon provider="claude" /> },
          { value: 'codex', label: 'Codex', icon: <ProviderIcon provider="codex" /> },
        ]}
      />,
    );

    expect(screen.getByLabelText('Provider').querySelector('[data-provider-icon="claude"]')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Provider'));
    const codexOption = screen.getByRole('option', { name: 'Codex' });
    expect(codexOption.querySelector('[data-provider-icon="openai"]')).toBeTruthy();
    fireEvent.click(codexOption);

    expect(onChange).toHaveBeenCalledWith('codex');
  });
});

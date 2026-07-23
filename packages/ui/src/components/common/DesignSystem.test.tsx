import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Plus } from 'lucide-react';
import Button from './Button';
import Dialog from './Dialog';
import { Field, Input } from './Field';
import Select from './Select';
import StatusBadge from './StatusBadge';
import { COLOR_MODE_TOKENS } from '../../lib/theme';
import { useSettingsStore } from '../../stores/settingsStore';

describe('V8 design system foundation', () => {
  it('exposes the canonical V8 light and dark theme colors', () => {
    expect(COLOR_MODE_TOKENS.light.surface).toBe('#fbfcfe');
    expect(COLOR_MODE_TOKENS.light.accent).toBe('#5e6ad2');
    expect(COLOR_MODE_TOKENS.dark.surface).toBe('#131418');
    expect(COLOR_MODE_TOKENS.dark.accent).toBe('#828be0');
  });

  it('applies the canonical tokens through persisted theme settings', () => {
    useSettingsStore.getState().setColorMode('dark');
    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement.style.getPropertyValue('--color-surface')).toBe('19 20 24');
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe('130 139 224');

    useSettingsStore.getState().setColorMode('light');
    expect(document.documentElement).not.toHaveClass('dark');
    expect(document.documentElement.style.getPropertyValue('--color-surface')).toBe('251 252 254');
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe('94 106 210');
  });

  it('renders a reusable button variant with an accessible icon', () => {
    render(<Button variant="primary" leadingIcon={<Plus />}>New workspace</Button>);

    const button = screen.getByRole('button', { name: 'New workspace' });
    expect(button).toHaveClass('btn-primary');
    expect(button.querySelector('.btn-icon-slot')).toHaveAttribute('aria-hidden', 'true');
  });

  it('associates field labels and hint text with a shared input', () => {
    render(
      <Field label="Name" htmlFor="name" hint="Used in the sidebar" required>
        <Input id="name" />
      </Field>,
    );

    expect(screen.getByLabelText(/Name/)).toBeInTheDocument();
    expect(screen.getByText('Used in the sidebar')).toHaveClass('field-message');
  });

  it('renders an accessible dialog and dismisses it with Escape', () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="Delete workspace" description="This cannot be undone." />);

    expect(screen.getByRole('dialog', { name: 'Delete workspace' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('supports keyboard selection in the shared dropdown', () => {
    const onChange = vi.fn();
    render(
      <Select
        value=""
        onChange={onChange}
        searchable={false}
        options={[
          { value: 'one', label: 'One' },
          { value: 'two', label: 'Two' },
        ]}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Select...' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('two');
  });

  it('uses the compact dropdown rhythm and aligns non-searchable menus to their trigger', () => {
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 66,
      top: 66,
      right: 260,
      bottom: 100,
      left: 100,
      width: 160,
      height: 34,
      toJSON: () => ({}),
    } as DOMRect);

    render(
      <Select
        value="one"
        onChange={vi.fn()}
        searchable={false}
        options={[{ value: 'one', label: 'One' }]}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'One' });
    expect(trigger).toHaveClass('select-trigger', 'h-[34px]', 'rounded-[8px]');
    expect(trigger.querySelector('.select-chevron')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(trigger);
    const popover = screen.getByRole('listbox').parentElement;
    expect(popover).toHaveClass('select-popover');
    expect(popover).toHaveStyle({ top: '106px', left: '100px', width: '160px' });

    rectSpy.mockRestore();
  });

  it('renders status as a semantic dot and lowercase mono label', () => {
    const { container } = render(<StatusBadge status="waiting_for_input" />);
    expect(screen.getByText('waiting for input')).toBeInTheDocument();
    expect(container.querySelector('.status-dot')).toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeInTheDocument();
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import SettingsPage from '../SettingsPage';
import { useAuthStore } from '../../stores/authStore';
import { useSettingsStore } from '../../stores/settingsStore';

describe('SettingsPage V8 surface', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.setState({
      user: {
        id: 'u1',
        email: 'operator@example.com',
        name: 'Operator',
        role: 'admin',
        mustResetPassword: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: '2026-07-20T00:00:00.000Z',
      },
    });
    useSettingsStore.setState({ colorMode: 'system' });
  });

  it('renders the compact General ledger with readable controls', () => {
    render(
      <MemoryRouter initialEntries={['/settings/general']}>
        <Routes>
          <Route path="/settings/:tab" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy();
    expect(screen.getByText('Workspace identity, appearance, and application updates.')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Workspace name' })).toHaveValue('allen-internal');
    expect(screen.getByText('Version')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Update channel' })).toHaveValue('Stable');
    expect(screen.getByRole('combobox', { name: 'Update channel' })).toHaveClass('select-native');
    expect(screen.getByRole('button', { name: /Dark/i })).toBeTruthy();
    expect(screen.getByRole('switch')).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: /Dark/i }));
    expect(useSettingsStore.getState().colorMode).toBe('dark');
  });

  it('persists the compact context engine controls', () => {
    render(
      <MemoryRouter initialEntries={['/settings/context']}>
        <Routes>
          <Route path="/settings/:tab" element={<SettingsPage />} />
          <Route path="/repos" element={<div>Repository settings</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Repo memory that grounds agents in your codebase.')).toBeTruthy();
    expect(screen.getByText('connected')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Refresh cadence' })).toHaveClass('select-native');

    fireEvent.change(screen.getByRole('combobox', { name: 'Refresh cadence' }), { target: { value: 'Hourly' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Default injection policy' }), { target: { value: 'Manifest only' } });

    expect(localStorage.getItem('allen.context.refresh-cadence')).toBe('Hourly');
    expect(localStorage.getItem('allen.context.injection-policy')).toBe('Manifest only');

    fireEvent.click(screen.getByRole('button', { name: /Open repositories/i }));
    expect(screen.getByText('Repository settings')).toBeTruthy();
  });

  it('renders the compact account identity and working account actions', () => {
    render(
      <MemoryRouter initialEntries={['/settings/account']}>
        <Routes>
          <Route path="/settings/:tab" element={<SettingsPage />} />
          <Route path="/reset-password" element={<div>Change password form</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Operator')).toBeTruthy();
    expect(screen.getByText('operator@example.com')).toBeTruthy();
    expect(screen.getByText('admin')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(screen.getByText('Change password form')).toBeTruthy();
  });

  it('hands team management off to the working Teams surface', () => {
    render(
      <MemoryRouter initialEntries={['/settings/team']}>
        <Routes>
          <Route path="/settings/:tab" element={<SettingsPage />} />
          <Route path="/agents" element={<div>Teams surface</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Manage people and roles in Teams')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Open Teams/i }));
    expect(screen.getByText('Teams surface')).toBeTruthy();
  });
});

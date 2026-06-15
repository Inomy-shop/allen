import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ContextImportExport } from './ContextImportExport';

// Mock api
vi.mock('../../services/api', () => ({
  repos: {
    previewContextExport: vi.fn(),
    exportContext: vi.fn().mockResolvedValue({ kind: 'allen.repo-context-package', schemaVersion: 1, curatedEntries: [], mandatoryMappings: [] }),
    previewContextImport: vi.fn(),
    applyContextImport: vi.fn(),
  },
}));

// Mock toast
const mockToast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
vi.mock('../common/Toast', () => ({
  useToast: () => mockToast,
}));

import { repos } from '../../services/api';

describe('ContextImportExport', () => {
  const defaultProps = { repoId: 'repo-1', repoName: 'allen-internal', onImported: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Export and Import buttons', () => {
    render(<ContextImportExport {...defaultProps} />);
    expect(screen.getByText('Export')).toBeTruthy();
    expect(screen.getByText('Import')).toBeTruthy();
  });

  it('Import modal: rejects malformed JSON paste', async () => {
    render(<ContextImportExport {...defaultProps} />);
    fireEvent.click(screen.getByText('Import'));
    const textarea = screen.getByPlaceholderText(/allen.repo-context-package/);
    fireEvent.change(textarea, { target: { value: 'not-valid-json{' } });
    await waitFor(() => expect(screen.getByText(/Invalid JSON/)).toBeTruthy());
  });

  it('Import preview: shows preview error and disables Apply button', async () => {
    (repos.previewContextImport as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('Package is not a valid Allen repo-context package'), { code: 'PACKAGE_INVALID' })
    );
    render(<ContextImportExport {...defaultProps} />);
    fireEvent.click(screen.getByText('Import'));
    const textarea = screen.getByPlaceholderText(/allen.repo-context-package/);
    fireEvent.change(textarea, { target: { value: JSON.stringify({ kind: 'allen.repo-context-package', schemaVersion: 1, sourceRepo: { repoName: 'foo' }, curatedEntries: [], mandatoryMappings: [], manifest: { contentSha256: '', curatedCount: 0, mandatoryCount: 0 } }) } });
    await waitFor(() => expect(screen.getByText(/Package is not a valid/)).toBeTruthy());
    // Apply button is present but disabled when preview errored
    const applyBtn = screen.queryByText('Apply Import');
    expect(applyBtn).not.toBeNull();
    expect(applyBtn).toBeDisabled();
  });

  it('Import preview: shows mismatch warning when source repo name differs from target', async () => {
    const mockPreview = {
      targetRepo: { _id: 'repo-1', name: 'allen-internal' },
      repoNameMismatch: { source: 'other-repo', target: 'allen-internal' },
      checksumValid: true,
      curatedActions: [],
      mandatoryActions: [],
      summary: { curated: { add: 0, skip_duplicate: 0, skip_clash: 0 }, mandatory: { add: 0, skip_duplicate: 0, skip_clash: 0, skip_missing_agent: 0 } },
    };
    (repos.previewContextImport as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockPreview);
    render(<ContextImportExport {...defaultProps} />);
    fireEvent.click(screen.getByText('Import'));
    const textarea = screen.getByPlaceholderText(/allen.repo-context-package/);
    fireEvent.change(textarea, { target: { value: JSON.stringify({ kind: 'allen.repo-context-package', schemaVersion: 1, sourceRepo: { repoName: 'other-repo' }, curatedEntries: [], mandatoryMappings: [], manifest: { contentSha256: '', curatedCount: 0, mandatoryCount: 0 } }) } });
    await waitFor(() => expect(screen.getByText(/other-repo/)).toBeTruthy());
    // Mismatch warning should be visible
    expect(screen.getByText(/Confirm to proceed/)).toBeTruthy();
    // Apply button should be disabled (checkbox not checked yet)
    const applyBtn = screen.getByText('Apply Import');
    expect(applyBtn).toBeDisabled();
  });

  it('Import preview: Apply enabled only after checking mismatch confirmation', async () => {
    const mockPreview = {
      targetRepo: { _id: 'repo-1', name: 'allen-internal' },
      repoNameMismatch: { source: 'other-repo', target: 'allen-internal' },
      checksumValid: true,
      curatedActions: [],
      mandatoryActions: [],
      summary: { curated: { add: 0, skip_duplicate: 0, skip_clash: 0 }, mandatory: { add: 0, skip_duplicate: 0, skip_clash: 0, skip_missing_agent: 0 } },
    };
    (repos.previewContextImport as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockPreview);
    render(<ContextImportExport {...defaultProps} />);
    fireEvent.click(screen.getByText('Import'));
    const textarea = screen.getByPlaceholderText(/allen.repo-context-package/);
    fireEvent.change(textarea, { target: { value: JSON.stringify({ kind: 'allen.repo-context-package', schemaVersion: 1, sourceRepo: { repoName: 'other-repo' }, curatedEntries: [], mandatoryMappings: [], manifest: { contentSha256: '', curatedCount: 0, mandatoryCount: 0 } }) } });
    await waitFor(() => screen.getByText('Apply Import'));
    const applyBtn = screen.getByText('Apply Import');
    expect(applyBtn).toBeDisabled();
    // Check the confirmation checkbox
    const checkbox = screen.getByTestId('mismatch-confirm-checkbox');
    fireEvent.click(checkbox);
    await waitFor(() => expect(applyBtn).not.toBeDisabled());
  });

  it('Import apply: success toast + error toast on clashes + stale-context banner', async () => {
    const mockPreview = {
      targetRepo: { _id: 'repo-1', name: 'allen-internal' },
      checksumValid: true,
      curatedActions: [{ entryId: 'e1', title: 'Test', path: '/test', action: 'add' }],
      mandatoryActions: [],
      summary: { curated: { add: 1, skip_duplicate: 0, skip_clash: 0 }, mandatory: { add: 0, skip_duplicate: 0, skip_clash: 0, skip_missing_agent: 0 } },
    };
    const mockApply = {
      imported: { curated: 1, mandatory: 0 },
      skipped: { curated: { duplicate: 0, clash: 1 }, mandatory: { duplicate: 0, clash: 0, missing_agent: 0 } },
      clashes: [{ kind: 'curated', key: 'title', title: 'Clash Title' }],
      missingAgents: [],
      staleContextMessage: 'Imported curated context is saved. Semantic context is stale — Refresh Context from Context Graph before relying on semantic recall. Mandatory context takes effect on new agent runs immediately.',
    };
    (repos.previewContextImport as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockPreview);
    (repos.applyContextImport as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockApply);

    render(<ContextImportExport {...defaultProps} />);
    fireEvent.click(screen.getByText('Import'));
    const textarea = screen.getByPlaceholderText(/allen.repo-context-package/);
    fireEvent.change(textarea, { target: { value: JSON.stringify({ kind: 'allen.repo-context-package', schemaVersion: 1, sourceRepo: { repoName: 'allen-internal' }, curatedEntries: [], mandatoryMappings: [], manifest: { contentSha256: '', curatedCount: 0, mandatoryCount: 0 } }) } });
    await waitFor(() => screen.getByText('Apply Import'));
    fireEvent.click(screen.getByText('Apply Import'));
    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith(expect.stringContaining('1 curated entries'));
      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('clashes'));
    });
    await waitFor(() => expect(screen.getByText(/Semantic context is stale/)).toBeTruthy());
  });

  it('Import preview: header shows package source repo name, not target repo name, when mismatch exists', async () => {
    const mockPreview = {
      targetRepo: { _id: 'repo-1', name: 'allen-internal' },
      repoNameMismatch: { source: 'original-source-repo', target: 'allen-internal' },
      checksumValid: true,
      curatedActions: [],
      mandatoryActions: [],
      summary: { curated: { add: 0, skip_duplicate: 0, skip_clash: 0 }, mandatory: { add: 0, skip_duplicate: 0, skip_clash: 0, skip_missing_agent: 0 } },
    };
    (repos.previewContextImport as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockPreview);
    render(<ContextImportExport {...defaultProps} />);
    fireEvent.click(screen.getByText('Import'));
    const textarea = screen.getByPlaceholderText(/allen.repo-context-package/);
    fireEvent.change(textarea, { target: { value: JSON.stringify({ kind: 'allen.repo-context-package', schemaVersion: 1, sourceRepo: { repoName: 'original-source-repo' }, curatedEntries: [], mandatoryMappings: [], manifest: { contentSha256: '', curatedCount: 0, mandatoryCount: 0 } }) } });
    await waitFor(() => screen.getByText(/original-source-repo/));
    // The "Source:" label should display the package's origin repo name
    const sourceLabel = screen.getByText(/Source:/)?.closest('div');
    expect(sourceLabel?.textContent).toContain('original-source-repo');
    // Target should show the current repo name (repoName prop = 'allen-internal')
    expect(sourceLabel?.textContent).toContain('allen-internal');
  });

  it('Import: mismatch warning disappears when paste is replaced with invalid JSON', async () => {
    const mockPreview = {
      targetRepo: { _id: 'repo-1', name: 'allen-internal' },
      repoNameMismatch: { source: 'other-repo', target: 'allen-internal' },
      checksumValid: true,
      curatedActions: [],
      mandatoryActions: [],
      summary: { curated: { add: 0, skip_duplicate: 0, skip_clash: 0 }, mandatory: { add: 0, skip_duplicate: 0, skip_clash: 0, skip_missing_agent: 0 } },
    };
    (repos.previewContextImport as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockPreview);
    render(<ContextImportExport {...defaultProps} />);
    fireEvent.click(screen.getByText('Import'));
    const textarea = screen.getByPlaceholderText(/allen.repo-context-package/);
    // First: valid package → preview with mismatch warning
    fireEvent.change(textarea, { target: { value: JSON.stringify({ kind: 'allen.repo-context-package', schemaVersion: 1, sourceRepo: { repoName: 'other-repo' }, curatedEntries: [], mandatoryMappings: [], manifest: { contentSha256: '', curatedCount: 0, mandatoryCount: 0 } }) } });
    await waitFor(() => expect(screen.getByText(/Confirm to proceed/)).toBeTruthy());
    // Then: paste invalid JSON — mismatch warning must disappear
    fireEvent.change(textarea, { target: { value: 'not-valid-json{' } });
    await waitFor(() => {
      expect(screen.queryByText(/Confirm to proceed/)).toBeNull();
    });
  });
});

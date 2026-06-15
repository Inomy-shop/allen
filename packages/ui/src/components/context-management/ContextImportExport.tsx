import { useState, useRef, type FC } from 'react';
import { Download, Upload, X, AlertCircle, Info } from 'lucide-react';
import { repos } from '../../services/api';
import { useToast } from '../common/Toast';
import { CuratedActionsTable, MandatoryActionsTable, type CuratedActionRow, type MandatoryActionRow } from './import-action-tables';

type Props = {
  repoId: string;
  repoName: string;
  onImported: () => void;
};

type ExportPreview = {
  repoName: string;
  curatedCount: number;
  mandatoryCount: number;
};

type ImportPreview = {
  targetRepo: { _id: string; name: string };
  repoNameMismatch: { source: string; target: string } | null;
  checksumValid: boolean;
  curatedActions: CuratedActionRow[];
  mandatoryActions: MandatoryActionRow[];
  summary: {
    curated: { add: number; skip_duplicate: number; skip_clash: number };
    mandatory: { add: number; skip_duplicate: number; skip_clash: number; skip_missing_agent: number };
  };
};

type ApplyResult = {
  imported: { curated: number; mandatory: number };
  skipped: {
    curated: { duplicate: number; clash: number };
    mandatory: { duplicate: number; clash: number; missing_agent: number };
  };
  clashes: Array<{ kind: string; key: string; title?: string; agentName?: string; sourcePath?: string }>;
  missingAgents: string[];
  staleContextMessage: string;
};

export const ContextImportExport: FC<Props> = ({ repoId, repoName, onImported }) => {
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Export state
  const [exportOverlayOpen, setExportOverlayOpen] = useState(false);
  const [exportPreview, setExportPreview] = useState<ExportPreview | null>(null);
  const [exportLoading, setExportLoading] = useState(false);

  // Import state
  const [importOverlayOpen, setImportOverlayOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [parsedPkg, setParsedPkg] = useState<Record<string, unknown> | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applyLoading, setApplyLoading] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [repoMismatchConfirmed, setRepoMismatchConfirmed] = useState(false);

  // ── Export flow ───────────────────────────────────────────────────────────
  const openExport = async () => {
    setExportLoading(true);
    try {
      const preview = await repos.previewContextExport(repoId) as ExportPreview;
      setExportPreview(preview);
      setExportOverlayOpen(true);
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to load export preview');
    } finally {
      setExportLoading(false);
    }
  };

  const confirmExport = async () => {
    try {
      // Fetch with auth headers, then trigger a blob download (same pattern as WorkflowListPage / RoleManagerPage).
      const pkg = await repos.exportContext(repoId);
      const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${repoName.replace(/[^a-z0-9_-]/gi, '_')}-context-package.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast.error(err.message ?? 'Export failed');
    }
    setExportOverlayOpen(false);
  };

  // ── Import flow ───────────────────────────────────────────────────────────
  const parsePkg = (text: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      setParseError(null);
      return parsed;
    } catch {
      setParseError('Invalid JSON. Please paste a valid context package.');
      return null;
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setPasteText(text);
    const pkg = parsePkg(text);
    if (pkg) {
      setParsedPkg(pkg);
      void runPreview(pkg);
    } else {
      setParsedPkg(null);
      setImportPreview(null);
      setPreviewError(null);
      setRepoMismatchConfirmed(false);
    }
  };

  const handlePasteChange = (text: string) => {
    setPasteText(text);
    const pkg = parsePkg(text);
    if (pkg) {
      setParsedPkg(pkg);
      void runPreview(pkg);
    } else {
      setParsedPkg(null);
      setImportPreview(null);
      setPreviewError(null);
      setRepoMismatchConfirmed(false);
    }
  };

  const runPreview = async (pkg: Record<string, unknown>) => {
    setPreviewLoading(true);
    setPreviewError(null);
    setImportPreview(null);
    setApplyResult(null);
    try {
      const preview = await repos.previewContextImport(repoId, { package: pkg }) as ImportPreview;
      setImportPreview(preview);
      setRepoMismatchConfirmed(false);
    } catch (err: any) {
      setPreviewError(err.message ?? 'Preview failed');
      setRepoMismatchConfirmed(false);
    } finally {
      setPreviewLoading(false);
    }
  };

  const applyImport = async () => {
    if (!parsedPkg) return;
    setApplyLoading(true);
    try {
      const result = await repos.applyContextImport(repoId, { package: parsedPkg, confirmRepoNameMismatch: repoMismatchConfirmed }) as ApplyResult;
      setApplyResult(result);
      toast.success(`Imported ${result.imported.curated} curated entries and ${result.imported.mandatory} mandatory mappings`);
      if (result.clashes.length > 0) {
        toast.error(`Skipped ${result.clashes.length} title/path/sourcePath clashes`);
      }
      if (result.missingAgents.length > 0) {
        toast.info(`Skipped ${result.missingAgents.length} mappings: missing agents in this instance`);
      }
      onImported();
    } catch (err: any) {
      toast.error(err.message ?? 'Import failed');
    } finally {
      setApplyLoading(false);
    }
  };

  const closeImport = () => {
    setImportOverlayOpen(false);
    setPasteText('');
    setParsedPkg(null);
    setParseError(null);
    setImportPreview(null);
    setPreviewError(null);
    setApplyResult(null);
    setRepoMismatchConfirmed(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const isPreviewOk = importPreview && !previewError;
  const canApply = isPreviewOk && !applyResult && !applyLoading && (!importPreview?.repoNameMismatch || repoMismatchConfirmed);

  return (
    <>
      {/* Buttons rendered inline — parent places them in the header */}
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => void openExport()}
        disabled={exportLoading}
        title="Export curated and mandatory context"
      >
        <Download className="w-3.5 h-3.5" /> Export
      </button>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => setImportOverlayOpen(true)}
        title="Import curated and mandatory context"
      >
        <Upload className="w-3.5 h-3.5" /> Import
      </button>

      {/* Export confirm overlay */}
      {exportOverlayOpen && exportPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setExportOverlayOpen(false)}>
          <div className="w-full max-w-sm rounded-md border border-app bg-app-card animate-in fade-in zoom-in-95 duration-200 p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-sm">Export context for {exportPreview.repoName}</h3>
              <button type="button" onClick={() => setExportOverlayOpen(false)}><X className="w-4 h-4 text-theme-muted" /></button>
            </div>
            <div className="space-y-1 text-sm mb-4">
              <div className="flex justify-between"><span className="text-theme-muted">Curated entries</span><span>{exportPreview.curatedCount}</span></div>
              <div className="flex justify-between"><span className="text-theme-muted">Mandatory mappings</span><span>{exportPreview.mandatoryCount}</span></div>
            </div>
            <div className="flex gap-2 justify-end">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setExportOverlayOpen(false)}>Cancel</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void confirmExport()}>
                <Download className="w-3.5 h-3.5" /> Download JSON
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import overlay */}
      {importOverlayOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={closeImport}>
          <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-md border border-app bg-app-card animate-in fade-in zoom-in-95 duration-200 p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-sm">Import context</h3>
              <button type="button" onClick={closeImport}><X className="w-4 h-4 text-theme-muted" /></button>
            </div>

            {/* Input area */}
            {!applyResult && (
              <div className="space-y-3 mb-4">
                <div>
                  <label className="text-xs font-medium text-theme-muted block mb-1">Upload JSON file</label>
                  <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={handleFileChange} className="text-xs" />
                </div>
                <div>
                  <label className="text-xs font-medium text-theme-muted block mb-1">Or paste JSON</label>
                  <textarea
                    className="w-full h-24 text-xs font-mono border border-app rounded px-2 py-1 bg-app-input resize-none"
                    placeholder='{"kind":"allen.repo-context-package",...}'
                    value={pasteText}
                    onChange={(e) => handlePasteChange(e.target.value)}
                  />
                </div>
                {parseError && <p className="text-xs text-red-500">{parseError}</p>}
              </div>
            )}

            {/* Preview section */}
            {previewLoading && <p className="text-xs text-theme-muted animate-pulse mb-4">Loading preview…</p>}

            {previewError && (
              <div className="mb-4 rounded border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-400 flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{previewError}</span>
              </div>
            )}

            {importPreview && !previewError && (
              <div className="space-y-3 mb-4">
                {/* Header: source → target */}
                <div className="text-xs text-theme-muted">
                  Source: <span className="text-theme-primary font-medium">{importPreview.repoNameMismatch?.source ?? repoName}</span>
                  {' → '}Target: <span className="text-theme-primary font-medium">{repoName}</span>
                </div>

                {/* Checksum warning */}
                {!importPreview.checksumValid && (
                  <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
                    <AlertCircle className="w-3 h-3" /> Checksum did not verify (proceeding — package-integrity only)
                  </span>
                )}

                {/* Repo name mismatch warning + confirmation */}
                {importPreview.repoNameMismatch && !applyResult && (
                  <div className="rounded border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-900/20 px-3 py-2 text-xs">
                    <div className="flex items-start gap-2 mb-2">
                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-600" />
                      <span className="text-amber-700 dark:text-amber-400">
                        Package is from repo <strong>{importPreview.repoNameMismatch.source}</strong> but you are importing into <strong>{importPreview.repoNameMismatch.target}</strong>. Confirm to proceed.
                      </span>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer pl-5">
                      <input
                        type="checkbox"
                        checked={repoMismatchConfirmed}
                        onChange={(e) => setRepoMismatchConfirmed(e.target.checked)}
                        data-testid="mismatch-confirm-checkbox"
                      />
                      <span className="text-amber-700 dark:text-amber-400">I understand and want to import anyway</span>
                    </label>
                  </div>
                )}

                {/* Summary cards */}
                <div className="grid grid-cols-4 gap-2">
                  {[
                    ['Will add', importPreview.summary.curated.add + importPreview.summary.mandatory.add],
                    ['Duplicates', importPreview.summary.curated.skip_duplicate + importPreview.summary.mandatory.skip_duplicate],
                    ['Clashes', importPreview.summary.curated.skip_clash + importPreview.summary.mandatory.skip_clash],
                    ['Missing agents', importPreview.summary.mandatory.skip_missing_agent],
                  ].map(([label, val]) => (
                    <div key={String(label)} className="rounded border border-app p-2 text-center">
                      <div className="text-lg font-semibold">{val}</div>
                      <div className="text-xs text-theme-muted">{label}</div>
                    </div>
                  ))}
                </div>

                {/* Action tables */}
                <div>
                  <p className="text-xs font-medium mb-1">Curated entries</p>
                  <CuratedActionsTable actions={importPreview.curatedActions} />
                </div>
                <div>
                  <p className="text-xs font-medium mb-1">Mandatory mappings</p>
                  <MandatoryActionsTable actions={importPreview.mandatoryActions} />
                </div>
              </div>
            )}

            {/* Apply result (completion summary) */}
            {applyResult && (
              <div className="space-y-3 mb-4">
                <div className="rounded border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-900/20 px-3 py-2 text-xs text-green-700 dark:text-green-400">
                  Imported {applyResult.imported.curated} curated entries and {applyResult.imported.mandatory} mandatory mappings.
                </div>

                {applyResult.clashes.length > 0 && (
                  <div>
                    <p className="text-xs font-medium mb-1 text-amber-600">Skipped clashes ({applyResult.clashes.length})</p>
                    <ul className="space-y-0.5 text-xs text-theme-muted list-disc pl-4">
                      {applyResult.clashes.map((c, i) => (
                        <li key={i}>{c.kind === 'curated' ? `Curated "${c.title ?? ''}"` : `Mandatory agent "${c.agentName ?? ''}" — "${c.title ?? ''}"`} (clash on {c.key})</li>
                      ))}
                    </ul>
                  </div>
                )}

                {applyResult.missingAgents.length > 0 && (
                  <div>
                    <p className="text-xs font-medium mb-1 text-theme-muted">Missing agents ({applyResult.missingAgents.length})</p>
                    <ul className="space-y-0.5 text-xs text-theme-muted list-disc pl-4">
                      {applyResult.missingAgents.map((a) => <li key={a}>{a}</li>)}
                    </ul>
                  </div>
                )}

                {/* Stale context banner */}
                <div className="rounded border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-900/20 px-3 py-2 text-xs flex items-start gap-2">
                  <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-600" />
                  <span className="text-amber-700 dark:text-amber-400">{applyResult.staleContextMessage}</span>
                </div>
              </div>
            )}

            {/* Footer actions */}
            <div className="flex gap-2 justify-end">
              <button type="button" className="btn btn-secondary btn-sm" onClick={closeImport}>
                {applyResult ? 'Close' : 'Cancel'}
              </button>
              {!applyResult && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!canApply}
                  onClick={() => void applyImport()}
                >
                  {applyLoading ? 'Importing…' : 'Apply Import'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default ContextImportExport;

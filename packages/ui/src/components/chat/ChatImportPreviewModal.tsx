import { useCallback, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileJson,
  Loader2,
  X,
} from 'lucide-react';
import { chat as chatApi } from '../../services/api';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onImported: (newSessionId: string) => void;
}

interface PreviewData {
  title?: string;
  exportedAt?: string;
  messageCount?: number;
  executionCount?: number;
  artifactCount?: number;
  bundleVersion?: number;
  sourceEnvironment?: { appName?: string; appVersion?: string; hostname?: string };
  estimatedImportedSize?: number;
  importsAs?: string;
  warnings?: string[];
}

type Stage = 'pick' | 'preview' | 'importing' | 'done';

const ERROR_MAP: Record<string, string> = {
  IMPORT_INVALID_JSON:
    "This file isn't a valid Allen chat export. Make sure it ends with .json.",
  IMPORT_UNSUPPORTED_VERSION:
    'This bundle uses an unsupported version (v{version}). Re-export from a compatible Allen build.',
  IMPORT_MISSING_FIELDS:
    'Required fields are missing — the file may be corrupted.',
  IMPORT_XSS_REJECTED:
    'This bundle contains unsafe content and cannot be imported. Re-export from the source.',
  IMPORT_SIZE_EXCEEDED:
    'Bundle exceeds the maximum allowed size.',
  IMPORT_BUNDLE_ROLLED_BACK:
    'The previous import failed and was rolled back. Re-upload the file to try again.',
};

function formatBytes(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ChatImportPreviewModal({ isOpen, onClose, onImported }: Props) {
  const [stage, setStage] = useState<Stage>('pick');
  const [error, setError] = useState<string | null>(null);
  const [bundleId, setBundleId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setStage('pick');
    setError(null);
    setBundleId(null);
    setPreview(null);
    setFilename(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  if (!isOpen) return null;

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFilename(file.name);

    // Client-side JSON parse to fail fast
    let parsed: object;
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch {
      setError("This file isn't a valid Allen chat export. Make sure it ends with .json.");
      return;
    }

    setError(null);
    setStage('preview');

    try {
      const result = await chatApi.importPreview(parsed);
      setBundleId(result.bundleId);
      setPreview(result.preview);
    } catch (err: unknown) {
      const apiError = err as Error & { body?: Record<string, unknown>; status?: number };
      // Parse error code from the response body
      const errorCode =
        (apiError.body as any)?.error || apiError.message || 'UNKNOWN';
      const version = (apiError.body as any)?.bundleVersion;
      const message =
        errorCode === 'IMPORT_UNSUPPORTED_VERSION' && version != null
          ? ERROR_MAP.IMPORT_UNSUPPORTED_VERSION.replace('{version}', String(version))
          : ERROR_MAP[errorCode] || apiError.message || 'Import failed';
      setError(message);
      setStage('pick');
    }
  }

  async function handleConfirm() {
    if (!bundleId) return;
    setStage('importing');
    setError(null);

    try {
      const result = await chatApi.importConfirm(bundleId);
      setStage('done');
      // Brief delay before navigating so the user sees the success state
      setTimeout(() => {
        onImported(result.sessionId);
        reset();
      }, 800);
    } catch (err: unknown) {
      const apiError = err as Error & { body?: Record<string, unknown> };
      const errorCode =
        (apiError.body as any)?.error || apiError.message || 'UNKNOWN';
      const message =
        ERROR_MAP[errorCode] || apiError.message || 'Failed to import chat';
      setError(message);
      setStage('preview');
    }
  }

  function handleClose() {
    reset();
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm"
      onClick={handleClose}
    >
      <div
        className="w-[500px] max-w-[calc(100vw-32px)] overflow-hidden rounded-md border border-app bg-app-card shadow-[0_24px_80px_rgba(0,0,0,0.34)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex items-start justify-between gap-4 border-b border-app px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-app bg-app-muted">
              {stage === 'done' ? (
                <CheckCircle2 className="h-4 w-4 text-accent-green" />
              ) : (
                <Download className="h-4 w-4 text-accent" />
              )}
            </div>
            <div>
              <h2 className="text-[14px] font-semibold text-theme-primary">
                {stage === 'pick' && 'Import chat'}
                {stage === 'preview' && 'Preview import'}
                {stage === 'importing' && 'Importing…'}
                {stage === 'done' && 'Import complete'}
              </h2>
              <p className="mt-0.5 text-[11px] text-theme-muted">
                {stage === 'pick' && 'Select an Allen chat export file to import.'}
                {stage === 'preview' && filename}
                {stage === 'importing' && 'Creating imported session…'}
                {stage === 'done' && 'Redirecting to imported chat…'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={stage === 'importing'}
            className="rounded-md p-1.5 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary disabled:opacity-35"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── Body ── */}
        <div className="px-5 py-4">
          {error && stage !== 'preview' && (
            <div className="flex items-start gap-2 rounded-md border border-accent-red/25 bg-accent-red/10 px-3 py-2.5 text-[11px] text-accent-red">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </div>
          )}

          {/* Stage 1: File picker */}
          {stage === 'pick' && (
            <div>
              {error && (
                <div className="mb-4 flex items-start gap-2 rounded-md border border-accent-red/25 bg-accent-red/10 px-3 py-2.5 text-[11px] text-accent-red">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {error}
                </div>
              )}
              <label
                htmlFor="import-file-input"
                className="flex cursor-pointer flex-col items-center gap-3 rounded-md border-2 border-dashed border-app-strong px-6 py-10 text-center transition-colors hover:border-accent hover:bg-accent/5"
              >
                <FileJson className="h-8 w-8 text-theme-muted" />
                <div>
                  <p className="text-[13px] font-medium text-theme-primary">
                    Click to select a file
                  </p>
                  <p className="mt-0.5 text-[11px] text-theme-muted">
                    or drag and drop a .json export file
                  </p>
                </div>
                <input
                  id="import-file-input"
                  ref={fileInputRef}
                  type="file"
                  accept=".json,application/json"
                  className="sr-only"
                  onChange={handleFileSelected}
                />
              </label>
            </div>
          )}

          {/* Stage 2: Preview */}
          {stage === 'preview' && preview && (
            <div className="space-y-3">
              {/* Preview card */}
              <div className="rounded-md border border-app bg-app-muted px-3 py-2.5">
                <div className="text-[13px] font-medium text-theme-primary">
                  {preview.title || 'Untitled chat'}
                </div>
                {preview.exportedAt && (
                  <div className="mt-0.5 text-[11px] font-mono text-theme-muted">
                    Exported:{' '}
                    {new Date(preview.exportedAt).toLocaleString()}
                  </div>
                )}
                {preview.sourceEnvironment && (
                  <div className="mt-1.5 text-[11px] text-theme-subtle">
                    Source:{' '}
                    {[
                      preview.sourceEnvironment.appName,
                      preview.sourceEnvironment.appVersion,
                    ]
                      .filter(Boolean)
                      .join(' v')}
                    {preview.sourceEnvironment.hostname
                      ? ` · ${preview.sourceEnvironment.hostname}`
                      : ''}
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-theme-secondary">
                  <span>{preview.messageCount ?? 0} messages</span>
                  <span>{preview.executionCount ?? 0} executions</span>
                  <span>{preview.artifactCount ?? 0} artifacts</span>
                  {preview.estimatedImportedSize != null && (
                    <span>Size: {formatBytes(preview.estimatedImportedSize)}</span>
                  )}
                </div>
                <div className="mt-1 text-[10px] font-mono text-theme-subtle">
                  Bundle version: {preview.bundleVersion ?? '?'} · Imports as:{' '}
                  {preview.importsAs || 'read-only replay'}
                </div>
              </div>

              {/* Warnings */}
              {preview.warnings && preview.warnings.length > 0 && (
                <div className="space-y-0.5">
                  {preview.warnings.map((w, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-1.5 text-[11px] text-yellow-700"
                    >
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Error banner */}
              {error && (
                <div className="flex items-start gap-2 rounded-md border border-accent-red/25 bg-accent-red/10 px-3 py-2.5 text-[11px] text-accent-red">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {error}
                </div>
              )}
            </div>
          )}

          {/* Stage 3: Importing spinner */}
          {stage === 'importing' && (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-6 w-6 animate-spin text-accent" />
            </div>
          )}

          {/* Stage 4: Done */}
          {stage === 'done' && (
            <div className="flex flex-col items-center justify-center py-6">
              <CheckCircle2 className="mb-2 h-8 w-8 text-accent-green" />
              <p className="text-[13px] font-medium text-theme-primary">
                Chat imported successfully
              </p>
            </div>
          )}
        </div>

        {/* ── Footer — only for preview stage ── */}
        {stage === 'preview' && (
          <div className="flex items-center justify-end gap-2 border-t border-app px-5 py-3">
            <button
              type="button"
              onClick={() => {
                reset();
                // Re-trigger file input click
                fileInputRef.current?.click();
              }}
              className="inline-flex h-8 items-center justify-center rounded-md border border-app bg-app px-3 text-[12px] font-medium text-theme-secondary transition-colors hover:border-app-strong hover:bg-app-muted hover:text-theme-primary"
            >
              Choose different file
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-medium text-white transition-colors hover:bg-accent-hover"
            >
              <Download className="h-3.5 w-3.5" />
              Import
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

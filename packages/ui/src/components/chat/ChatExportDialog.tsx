import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Download,
  FileJson,
  Loader2,
  ShieldAlert,
  X,
} from 'lucide-react';
import { chat as chatApi } from '../../services/api';

interface Props {
  sessionId: string;
  sessionTitle: string;
  isOpen: boolean;
  onClose: () => void;
}

interface ExportOptions {
  messageCount: number;
  toolCallCount: number;
  executionCount: number;
  descendantExecutionCount: number;
  chatLogCount: number;
  traceCount: number;
  artifactCount: number;
  codeDiffCount: number;
  estimatedSizeBytes: number;
  warnings: string[];
}

interface SizeLimitError {
  estimatedSizeBytes: number;
  maxSizeBytes: number;
  suggestedExclusions: string[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Helper: a single toggle row. */
function ToggleRow({
  id,
  label,
  checked,
  locked,
  disabled,
  onChange,
  muted,
}: {
  id: string;
  label: string;
  checked: boolean;
  locked?: boolean;
  disabled?: boolean;
  onChange?: (v: boolean) => void;
  muted?: boolean;
}) {
  return (
    <label
      htmlFor={id}
      className={`flex items-center gap-3 px-1 py-1.5 text-[12px] ${
        muted ? 'text-theme-subtle' : 'text-theme-secondary'
      }`}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={locked || disabled}
        onChange={(e) => onChange?.(e.target.checked)}
        className="h-3.5 w-3.5 shrink-0 rounded border-app-strong accent-accent disabled:opacity-40"
      />
      <span className={`flex-1 ${locked ? 'font-medium text-theme-primary' : ''}`}>
        {label}
        {locked && (
          <span className="ml-1.5 text-[10px] font-mono text-theme-subtle">always included</span>
        )}
      </span>
    </label>
  );
}

export default function ChatExportDialog({ sessionId, sessionTitle, isOpen, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<ExportOptions | null>(null);
  const [sizeLimitError, setSizeLimitError] = useState<SizeLimitError | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Toggle state — defaults match TDD §2.2
  const [includeHiddenMessages, setIncludeHiddenMessages] = useState(false);
  const [includeLogs, setIncludeLogs] = useState(true);
  const [includeTraces, setIncludeTraces] = useState(true);
  const [includeArtifacts, setIncludeArtifacts] = useState(true);
  const [includeArtifactContents, setIncludeArtifactContents] = useState(false);
  const [includeCodeDiffs, setIncludeCodeDiffs] = useState(true);
  const [includeThinking, setIncludeThinking] = useState(false);

  // Redaction state — defaults match TDD §2.2
  const [redactPaths, setRedactPaths] = useState(true);
  const [redactIdentity, setRedactIdentity] = useState(false);
  const [redactSecrets, setRedactSecrets] = useState(true);

  // Reset state on open
  const reset = useCallback(() => {
    setLoading(true);
    setError(null);
    setOptions(null);
    setSizeLimitError(null);
    setDownloading(false);
    setIncludeHiddenMessages(false);
    setIncludeLogs(true);
    setIncludeTraces(true);
    setIncludeArtifacts(true);
    setIncludeArtifactContents(false);
    setIncludeCodeDiffs(true);
    setIncludeThinking(false);
    setRedactPaths(true);
    setRedactIdentity(false);
    setRedactSecrets(true);

    chatApi
      .exportOptions(sessionId)
      .then((result) => {
        setOptions(result);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load export options');
        setLoading(false);
      });
  }, [sessionId]);

  useEffect(() => {
    if (isOpen) reset();
  }, [isOpen, reset]);

  function buildBody() {
    return {
      includeHiddenMessages,
      includeLogs,
      includeTraces,
      includeArtifacts,
      includeArtifactContents,
      includeCodeDiffs,
      includeThinking,
      redactPaths,
      redactIdentity,
      redactSecrets,
    };
  }

  async function handleDownload() {
    setDownloading(true);
    setSizeLimitError(null);
    setError(null);
    try {
      const blob = await chatApi.exportChat(sessionId, buildBody());
      const safeTitle = sessionTitle
        .replace(/[^a-zA-Z0-9一-鿿_-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .toLowerCase() || 'chat';
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const filename = `allen-chat-${safeTitle}-${date}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      onClose();
    } catch (err: unknown) {
      const apiError = err as Error & { body?: Record<string, unknown> };
      if (
        apiError.body &&
        (apiError.body as any).error === 'EXPORT_SIZE_LIMIT_EXCEEDED'
      ) {
        const body = apiError.body as any;
        setSizeLimitError({
          estimatedSizeBytes: body.estimatedSizeBytes ?? 0,
          maxSizeBytes: body.maxSizeBytes ?? 0,
          suggestedExclusions: body.suggestedExclusions ?? [],
        });
      } else {
        setError(apiError.message || 'Export failed');
      }
    } finally {
      setDownloading(false);
    }
  }

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-[520px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-md border border-app bg-app-card shadow-[0_24px_80px_rgba(0,0,0,0.34)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-app px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-app bg-app-muted">
              <FileJson className="h-4 w-4 text-accent" />
            </div>
            <div>
              <h2 className="text-[14px] font-semibold text-theme-primary">Export chat</h2>
              <p className="mt-0.5 text-[11px] text-theme-muted truncate max-w-[380px]">
                {sessionTitle}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={downloading}
            className="rounded-md p-1.5 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary disabled:opacity-35"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── Body ── */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-theme-muted" />
              <span className="ml-2 text-[12px] text-theme-muted">Loading export options…</span>
            </div>
          )}

          {error && (
            <div className="mb-3 flex items-start gap-2 rounded-md border border-accent-red/25 bg-accent-red/10 px-3 py-2.5 text-[11px] text-accent-red">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </div>
          )}

          {options && !error && (
            <>
              {/* Counts summary */}
              <div className="mb-4 rounded-md border border-app bg-app-muted px-3 py-2.5">
                <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] font-mono text-theme-secondary">
                  <span>{options.messageCount} messages</span>
                  <span>{options.toolCallCount} tool calls</span>
                  <span>{options.executionCount} executions</span>
                  {options.descendantExecutionCount > 0 && (
                    <span>+{options.descendantExecutionCount} descendant runs</span>
                  )}
                  <span>{options.chatLogCount} log entries</span>
                  <span>{options.traceCount} traces</span>
                  <span>{options.artifactCount} artifacts</span>
                  <span>{options.codeDiffCount} code diffs</span>
                </div>
                <div className="mt-1.5 text-[11px] text-theme-primary font-medium">
                  Estimated size: {formatBytes(options.estimatedSizeBytes)}
                </div>
                {options.warnings.length > 0 && (
                  <div className="mt-2 space-y-0.5">
                    {options.warnings.map((w, i) => (
                      <div key={i} className="flex items-start gap-1.5 text-[10px] text-yellow-700">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>{w}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Size limit error recovery */}
              {sizeLimitError && (
                <div className="mb-4 rounded-md border border-yellow-400/30 bg-yellow-50/60 px-3 py-2.5">
                  <div className="flex items-start gap-2 text-[11px] text-yellow-800">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <div>
                      <p className="font-medium">
                        Export exceeds the maximum size ({formatBytes(sizeLimitError.maxSizeBytes)}).
                        Estimated: {formatBytes(sizeLimitError.estimatedSizeBytes)}.
                      </p>
                      {sizeLimitError.suggestedExclusions.length > 0 && (
                        <p className="mt-1">
                          Try disabling:{' '}
                          {sizeLimitError.suggestedExclusions.map((exclusion) => (
                            <button
                              key={exclusion}
                              type="button"
                              className="ml-1 inline-flex items-center gap-1 rounded-full border border-yellow-400/30 bg-yellow-100/60 px-2 py-0.5 text-[10px] font-mono text-yellow-800 hover:bg-yellow-200/60 transition-colors"
                              onClick={() => {
                                // Map exclusion string to the matching toggle
                                const key = exclusion.toLowerCase();
                                if (key.includes('artifact') && key.includes('content')) {
                                  setIncludeArtifactContents(false);
                                } else if (key.includes('artifact')) {
                                  setIncludeArtifacts(false);
                                } else if (key.includes('trace') || key.includes('log')) {
                                  setIncludeTraces(false);
                                  setIncludeLogs(false);
                                } else if (key.includes('diff')) {
                                  setIncludeCodeDiffs(false);
                                } else if (key.includes('thinking')) {
                                  setIncludeThinking(false);
                                }
                                setSizeLimitError(null);
                              }}
                            >
                              <X className="h-2.5 w-2.5" />
                              {exclusion}
                            </button>
                          ))}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* ── Toggles section ── */}
              <div className="mb-3">
                <h3 className="text-[11px] font-semibold tracking-wide text-theme-primary uppercase mb-1">
                  Include in export
                </h3>
                <div className="rounded-md border border-app px-3 py-1.5">
                  {/* Messages — always included */}
                  <ToggleRow id="export-msg" label="Messages" checked={true} locked />
                  {/* Hidden messages */}
                  <ToggleRow
                    id="export-hidden"
                    label="Hidden / system messages"
                    checked={includeHiddenMessages}
                    onChange={setIncludeHiddenMessages}
                  />
                  {/* Tool calls — always included */}
                  <ToggleRow id="export-tc" label="Tool calls" checked={true} locked disabled />
                  {/* Workflow evidence — always included */}
                  <ToggleRow id="export-wf" label="Workflow evidence" checked={true} locked disabled />
                  {/* Chat logs */}
                  <ToggleRow id="export-logs" label="Chat logs" checked={includeLogs} onChange={setIncludeLogs} />
                  {/* Execution traces */}
                  <ToggleRow id="export-traces" label="Execution traces" checked={includeTraces} onChange={setIncludeTraces} />
                  {/* Artifacts */}
                  <ToggleRow id="export-artifacts" label="Artifacts" checked={includeArtifacts} onChange={setIncludeArtifacts} />
                  {/* Artifact contents — OFF with warning */}
                  <ToggleRow
                    id="export-artifact-contents"
                    label="Artifact contents"
                    checked={includeArtifactContents}
                    onChange={setIncludeArtifactContents}
                    muted
                  />
                  {/* Code-diff snapshots */}
                  <ToggleRow id="export-diffs" label="Code-diff snapshots" checked={includeCodeDiffs} onChange={setIncludeCodeDiffs} />
                  {/* Thinking text */}
                  <ToggleRow id="export-thinking" label="Thinking text" checked={includeThinking} onChange={setIncludeThinking} />
                  {/* Raw runtime traces — always excluded */}
                  <ToggleRow id="export-raw" label="Raw runtime traces" checked={false} locked disabled muted />
                </div>
              </div>

              {/* ── Redaction section ── */}
              <div className="mb-3">
                <h3 className="text-[11px] font-semibold tracking-wide text-theme-primary uppercase mb-1">
                  Redaction
                </h3>
                <div className="rounded-md border border-app px-3 py-1.5">
                  <ToggleRow
                    id="redact-paths"
                    label="Redact local filesystem paths"
                    checked={redactPaths}
                    onChange={setRedactPaths}
                  />
                  <ToggleRow
                    id="redact-identity"
                    label="Redact user identity"
                    checked={redactIdentity}
                    onChange={setRedactIdentity}
                  />
                  <ToggleRow
                    id="redact-secrets"
                    label="Redact secrets / tokens"
                    checked={redactSecrets}
                    onChange={setRedactSecrets}
                  />
                </div>
              </div>

              {/* ── Sensitive-data warning ── */}
              <div className="mb-3 flex items-start gap-2 rounded-md border border-yellow-400/30 bg-yellow-50/60 px-3 py-2.5 text-[11px] text-yellow-800">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div>
                  <strong>Sensitive data warning:</strong> Logs, traces, tool outputs, and artifacts
                  may contain repository content, local file paths, API credentials, or proprietary
                  data. Review the redaction options above before sharing this file.
                </div>
              </div>

              {/* ── No-hosted-link notice ── */}
              <div className="mb-1 rounded-md border border-app px-3 py-2 text-[11px] text-theme-muted">
                Result is a downloaded file. No hosted share link is created.
              </div>
            </>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-app px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={downloading}
            className="inline-flex h-8 items-center justify-center rounded-md border border-app bg-app px-3 text-[12px] font-medium text-theme-secondary transition-colors hover:border-app-strong hover:bg-app-muted hover:text-theme-primary disabled:opacity-35"
          >
            Cancel
          </button>
          {options && !error && (
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloading || Boolean(sizeLimitError)}
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
            >
              {downloading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {downloading ? 'Downloading…' : 'Download'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

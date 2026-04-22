/**
 * ArtifactViewer — type-aware renderer for a single artifact.
 *
 * Renders:
 *   - markdown  → through the project's renderMarkdown (code blocks, links, …)
 *   - json      → pretty-printed, monospace, collapsible
 *   - csv       → table with header row, horizontal scroll for wide sheets
 *   - code      → monospace pre with language hint chip
 *   - text      → monospace pre
 *   - binary    → download-only link with metadata
 *
 * Content is fetched from the public /api/artifacts/:id/content URL so the
 * viewer stays auth-independent — same URL agents can embed in markdown.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  X as XIcon, Download, Copy, ExternalLink, Trash2,
  FileText, FileJson, FileSpreadsheet, Code2, File, Database,
} from 'lucide-react';
import { artifacts as artifactsApi, type ArtifactDoc } from '../../services/api';
import { renderMarkdown } from '../chat/ChatMessageList';

export interface ArtifactViewerProps {
  artifact: ArtifactDoc;
  onClose?: () => void;
  onDelete?: () => void;
}

export default function ArtifactViewer({ artifact, onClose, onDelete }: ArtifactViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const url = artifactsApi.contentUrl(artifact.artifactId);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(url)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        if (artifact.contentType === 'binary') return ''; // don't load binary content
        return r.text();
      })
      .then(text => { if (!cancelled) setContent(text); })
      .catch(err => { if (!cancelled) setError((err as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [url, artifact.contentType]);

  async function handleCopy() {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* ignore */ }
  }

  const Icon = iconForType(artifact.contentType);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 px-4 py-2.5 border-b border-border/20 bg-surface-100/30">
        <div className="flex items-center gap-2.5 mb-1">
          <Icon className={`w-4 h-4 shrink-0 ${colorForType(artifact.contentType)}`} />
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-mono text-theme-primary truncate">
              {artifact.relativePath}
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-[10px] font-mono text-theme-subtle">
              <span className="uppercase">{artifact.contentType}</span>
              {artifact.language && (
                <>
                  <span>·</span>
                  <span>{artifact.language}</span>
                </>
              )}
              <span>·</span>
              <span>{formatSize(artifact.sizeBytes)}</span>
              {artifact.createdByAgent && (
                <>
                  <span>·</span>
                  <span className="truncate">by {artifact.createdByAgent}</span>
                </>
              )}
            </div>
          </div>
          <div className="shrink-0 flex items-center gap-1">
            <button
              onClick={handleCopy}
              disabled={!content || artifact.contentType === 'binary'}
              title="Copy content"
              className="p-1.5 rounded-md hover:bg-surface-200/60 text-theme-muted hover:text-theme-secondary transition-colors disabled:opacity-30"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              title="Open in new tab"
              className="p-1.5 rounded-md hover:bg-surface-200/60 text-theme-muted hover:text-theme-secondary transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
            <a
              href={url}
              download={artifact.filename}
              title="Download"
              className="p-1.5 rounded-md hover:bg-surface-200/60 text-theme-muted hover:text-theme-secondary transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
            </a>
            {onDelete && (
              <button
                onClick={onDelete}
                title="Delete artifact"
                className="p-1.5 rounded-md hover:bg-accent-red/10 text-theme-muted hover:text-accent-red transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
            {onClose && (
              <button
                onClick={onClose}
                title="Close viewer"
                className="p-1.5 rounded-md hover:bg-surface-200/60 text-theme-muted hover:text-theme-secondary transition-colors"
              >
                <XIcon className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
        {artifact.description && (
          <div className="text-[11px] text-theme-muted font-body italic">
            {artifact.description}
          </div>
        )}
        {copied && (
          <div className="text-[10px] font-mono text-accent-green mt-1">Copied ✓</div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto">
        {loading && (
          <div className="p-6 text-xs text-theme-muted font-mono">Loading…</div>
        )}
        {error && (
          <div className="p-6 text-xs text-accent-red font-mono">Failed to load: {error}</div>
        )}
        {!loading && !error && (
          <div className="p-4">
            {artifact.contentType === 'markdown' && (
              <div className="prose prose-sm prose-invert max-w-none">
                {renderMarkdown(content ?? '') as React.ReactNode}
              </div>
            )}
            {artifact.contentType === 'json' && (
              <JsonViewer text={content ?? ''} />
            )}
            {artifact.contentType === 'csv' && (
              <CsvTable text={content ?? ''} />
            )}
            {artifact.contentType === 'code' && (
              <pre className="text-[12px] font-mono text-theme-primary whitespace-pre-wrap break-words leading-relaxed bg-surface-100/40 p-3 rounded border border-border/20">
                {content}
              </pre>
            )}
            {artifact.contentType === 'text' && (
              <pre className="text-[12px] font-body text-theme-secondary whitespace-pre-wrap break-words leading-relaxed">
                {content}
              </pre>
            )}
            {artifact.contentType === 'binary' && (
              <BinaryPreview url={url} filename={artifact.filename} size={artifact.sizeBytes} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── JSON ───────────────────────────────────────────────────────────────

function JsonViewer({ text }: { text: string }) {
  const formatted = useMemo(() => {
    try { return JSON.stringify(JSON.parse(text), null, 2); }
    catch { return text; }
  }, [text]);
  return (
    <pre className="text-[12px] font-mono text-theme-primary whitespace-pre-wrap break-words leading-relaxed bg-[rgb(var(--color-editor-background))] p-3 rounded border border-border/20">
      {formatted}
    </pre>
  );
}

// ── CSV ────────────────────────────────────────────────────────────────

/**
 * Parse CSV — handles quoted values, escaped quotes ("" → "), and
 * multi-line fields. Good enough for the 99% case; agents producing
 * exotic dialects can emit JSON instead.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else {
        field += c;
      }
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

function CsvTable({ text }: { text: string }) {
  const rows = useMemo(() => parseCsv(text), [text]);
  if (rows.length === 0) {
    return <div className="text-xs text-theme-muted italic">Empty CSV</div>;
  }
  const [header, ...body] = rows;
  return (
    <div className="overflow-x-auto rounded-md border border-border/30">
      <table className="min-w-full text-[11px] font-mono">
        <thead className="bg-surface-200/40 border-b border-border/30 sticky top-0">
          <tr>
            {header.map((h, i) => (
              <th key={i} className="px-3 py-1.5 text-left font-label uppercase tracking-wider text-theme-muted whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i} className="border-b border-border/10 last:border-b-0 hover:bg-surface-200/20">
              {header.map((_, j) => (
                <td key={j} className="px-3 py-1.5 text-theme-secondary align-top whitespace-pre-wrap break-words max-w-[280px]">
                  {r[j] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="px-3 py-1.5 text-[10px] font-mono text-theme-subtle bg-surface-100/40 border-t border-border/20">
        {body.length} row{body.length === 1 ? '' : 's'} · {header.length} column{header.length === 1 ? '' : 's'}
      </div>
    </div>
  );
}

// ── Binary ─────────────────────────────────────────────────────────────

function BinaryPreview({ url, filename, size }: { url: string; filename: string; size: number }) {
  // Image preview for png/jpg/gif/svg/webp — the route serves the right
  // Content-Type, so the browser handles decoding.
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext);
  if (isImage) {
    return (
      <div className="flex flex-col items-center gap-2">
        <img
          src={url}
          alt={filename}
          className="max-w-full max-h-[70vh] rounded border border-border/30 bg-surface-100/30"
        />
        <div className="text-[10px] font-mono text-theme-subtle">{filename} · {formatSize(size)}</div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 p-4 rounded-md border border-border/30 bg-surface-100/40">
      <Database className="w-6 h-6 text-theme-muted shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-mono text-theme-primary truncate">{filename}</div>
        <div className="text-[10px] font-mono text-theme-subtle">{formatSize(size)} · binary — click download to save</div>
      </div>
      <a
        href={url}
        download={filename}
        className="px-3 py-1.5 rounded-md bg-accent-blue text-white text-xs font-body hover:opacity-90 flex items-center gap-1.5"
      >
        <Download className="w-3 h-3" /> Download
      </a>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

function iconForType(t: ArtifactDoc['contentType']) {
  switch (t) {
    case 'markdown': return FileText;
    case 'json':     return FileJson;
    case 'csv':      return FileSpreadsheet;
    case 'code':     return Code2;
    case 'binary':   return Database;
    case 'text':
    default:         return File;
  }
}

function colorForType(t: ArtifactDoc['contentType']): string {
  switch (t) {
    case 'markdown': return 'text-accent-blue';
    case 'json':     return 'text-accent-yellow';
    case 'csv':      return 'text-accent-green';
    case 'code':     return 'text-accent-purple';
    case 'binary':   return 'text-theme-muted';
    case 'text':
    default:         return 'text-theme-secondary';
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

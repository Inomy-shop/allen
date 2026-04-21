import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare, X as XIcon, AlertCircle } from 'lucide-react';
import { renderMarkdown } from '../chat/ChatMessageList';

interface Field {
  name: string;
  /** Core types: text (textarea), boolean, select, number, string.
   *  Structured: json, yaml, code, markdown — render as larger monospace editors. */
  type: string;
  label?: string;
  required?: boolean;
  options?: string[];
  default?: any;
  placeholder?: string;
  /** Optional description shown under the label. */
  help?: string;
  /** For code fields — a hint about syntax (e.g. 'sql', 'python'). Purely UX. */
  language?: string;
}

interface Props {
  node: string;
  /** Short question / intro from the agent. */
  prompt: string;
  fields: Field[];
  /** Optional reviewable content from the agent — the artifact the user is
   *  being asked to review (PRD draft, JSON output, code snippet, etc.).
   *  Rendered in a left pane when present; fields move to the right pane. */
  reviewContent?: string;
  /** How to render the review content: markdown (default), json, code, text. */
  reviewContentType?: 'markdown' | 'json' | 'code' | 'text';
  /** Language hint for code-type review content. */
  reviewLanguage?: string;
  onSubmit: (data: Record<string, unknown>) => void;
  onCancel: () => void;
}

/**
 * Overhauled human-in-the-loop dialog. Supports:
 *   - Reviewable content panel alongside the form (left = content, right = fields)
 *   - Structured field types: json / yaml / code / markdown — larger editors
 *     with monospace + JSON validation when applicable
 *   - Portal-rendered so ancestor `backdrop-filter` can't trap it
 *   - Escape to close; lock body scroll while open
 */
export default function HumanInputDialog({
  node, prompt, fields,
  reviewContent, reviewContentType = 'markdown', reviewLanguage,
  onSubmit, onCancel,
}: Props) {
  const [values, setValues] = useState<Record<string, any>>(() => {
    const initial: Record<string, any> = {};
    for (const f of fields) {
      if (f.type === 'boolean') initial[f.name] = f.default ?? false;
      else if (f.type === 'select') initial[f.name] = f.default ?? f.options?.[0] ?? '';
      else initial[f.name] = f.default ?? '';
    }
    return initial;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Lock body scroll + Escape to close
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);

  function validateField(f: Field, val: unknown): string | null {
    if (f.required && (val === '' || val === null || val === undefined)) return 'required';
    if (f.type === 'json' && typeof val === 'string' && val.trim()) {
      try { JSON.parse(val); } catch (e) { return `Invalid JSON: ${(e as Error).message}`; }
    }
    return null;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    for (const f of fields) {
      const err = validateField(f, values[f.name]);
      if (err) errs[f.name] = err;
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    // For JSON fields, parse back to an object so the backend receives
    // structured data, not the raw string.
    const final: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = values[f.name];
      if (f.type === 'json' && typeof raw === 'string' && raw.trim()) {
        try { final[f.name] = JSON.parse(raw); } catch { final[f.name] = raw; }
      } else if (f.type === 'number' && typeof raw === 'string' && raw !== '') {
        final[f.name] = Number(raw);
      } else {
        final[f.name] = raw;
      }
    }
    onSubmit(final);
  }

  const hasReview = !!reviewContent && reviewContent.trim().length > 0;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-start justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto"
      onClick={onCancel}
    >
      <div
        className={`bg-surface-50 border border-border/40 rounded-lg shadow-2xl w-full mt-[4vh] max-h-[92vh] flex flex-col overflow-hidden ${
          hasReview ? 'max-w-6xl' : 'max-w-lg'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border/20 shrink-0">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-accent-yellow" />
            <div>
              <h2 className="font-heading text-sm text-theme-primary tracking-wider">Input Required</h2>
              <p className="text-[11px] text-theme-muted font-mono">node · {node}</p>
            </div>
          </div>
          <button
            onClick={onCancel}
            className="p-1 rounded-md hover:bg-surface-200/60 text-theme-muted hover:text-theme-secondary transition-colors"
            title="Close (does not submit or clear the pending request)"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        {prompt && (
          <div className="px-5 py-3 border-b border-border/20 bg-accent-yellow/5 shrink-0">
            <p className="text-sm text-theme-secondary font-body whitespace-pre-wrap">{prompt}</p>
          </div>
        )}

        {/* Two-column layout when review content is present. */}
        <div className={`flex-1 min-h-0 overflow-hidden ${hasReview ? 'grid grid-cols-[1fr_1fr] divide-x divide-border/20' : ''}`}>
          {hasReview && (
            <div className="overflow-auto p-5 bg-surface-100/40">
              <div className="text-[10px] font-label uppercase tracking-[0.15em] text-theme-muted mb-2">
                Content for review
              </div>
              {reviewContentType === 'markdown' ? (
                <div className="prose prose-sm prose-invert max-w-none">
                  <div dangerouslySetInnerHTML={{ __html: String(renderMarkdown(reviewContent!) ?? '') }} />
                </div>
              ) : reviewContentType === 'json' ? (
                <pre className="text-[11px] font-mono text-theme-secondary bg-surface-200/30 rounded p-2 whitespace-pre-wrap break-all">
                  {tryFormatJSON(reviewContent!)}
                </pre>
              ) : reviewContentType === 'code' ? (
                <pre className="text-[11px] font-mono text-theme-secondary bg-surface-200/30 rounded p-2 whitespace-pre-wrap break-all">
                  {reviewLanguage && <div className="text-[9px] text-theme-subtle mb-1 uppercase">{reviewLanguage}</div>}
                  {reviewContent}
                </pre>
              ) : (
                <pre className="text-[11px] font-body text-theme-secondary whitespace-pre-wrap break-words">
                  {reviewContent}
                </pre>
              )}
            </div>
          )}

          <form onSubmit={handleSubmit} className="overflow-auto p-5 flex flex-col gap-4">
            {fields.length === 0 && (
              <div className="text-[11px] text-theme-muted italic">(no fields — click Submit to continue)</div>
            )}
            {fields.map((field) => (
              <div key={field.name}>
                <label className="block text-[11px] font-label uppercase tracking-[0.1em] text-theme-muted mb-1">
                  {field.label ?? field.name}
                  {field.required && <span className="text-red-400 ml-0.5">*</span>}
                </label>
                {field.help && (
                  <div className="text-[10px] text-theme-subtle font-body mb-1.5">{field.help}</div>
                )}

                {field.type === 'boolean' ? (
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!values[field.name]}
                      onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.checked }))}
                      className="w-4 h-4 rounded bg-surface-200 border-border/40 text-accent-blue focus:ring-accent-blue"
                    />
                    <span className="text-sm text-theme-secondary">Yes</span>
                  </label>
                ) : field.type === 'select' ? (
                  <select
                    value={values[field.name]}
                    onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
                    className="w-full px-2.5 py-1.5 rounded-md border border-border/40 bg-surface-100/60 text-theme-primary text-sm focus:outline-none focus:border-accent-blue/60"
                  >
                    {field.options?.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                  </select>
                ) : field.type === 'json' || field.type === 'yaml' || field.type === 'code' || field.type === 'markdown' ? (
                  <textarea
                    value={values[field.name]}
                    onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
                    placeholder={field.placeholder ?? (field.type === 'json' ? '{}' : '')}
                    className="w-full px-2.5 py-1.5 rounded-md border border-border/40 bg-surface-100/60 text-theme-primary text-[11px] font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60 min-h-[140px] resize-vertical"
                    required={field.required}
                    spellCheck={false}
                  />
                ) : field.type === 'text' ? (
                  <textarea
                    value={values[field.name]}
                    onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
                    placeholder={field.placeholder}
                    className="w-full px-2.5 py-1.5 rounded-md border border-border/40 bg-surface-100/60 text-theme-primary text-sm font-body focus:outline-none focus:border-accent-blue/60 min-h-[80px] resize-vertical"
                    required={field.required}
                  />
                ) : (
                  <input
                    type={field.type === 'number' ? 'number' : 'text'}
                    value={values[field.name]}
                    onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
                    placeholder={field.placeholder}
                    className="w-full px-2.5 py-1.5 rounded-md border border-border/40 bg-surface-100/60 text-theme-primary text-sm font-body focus:outline-none focus:border-accent-blue/60"
                    required={field.required}
                  />
                )}
                {errors[field.name] && (
                  <div className="text-[10px] text-red-400 font-mono mt-1 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" /> {errors[field.name]}
                  </div>
                )}
              </div>
            ))}

            <div className="flex justify-end gap-2 pt-2 border-t border-border/20 mt-auto">
              <button
                type="button"
                onClick={onCancel}
                className="px-3 py-1.5 rounded-md border border-border/40 text-theme-secondary hover:bg-surface-200/60 text-sm font-body transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-3 py-1.5 rounded-md bg-accent-blue text-white hover:opacity-90 text-sm font-body transition-opacity"
              >
                Submit
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function tryFormatJSON(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

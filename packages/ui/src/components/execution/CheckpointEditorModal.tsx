import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Loader2, X as XIcon } from 'lucide-react';
import { executions as api } from '../../services/api';

interface Props {
  executionId: string;
  checkpointId: string;
  initialState: Record<string, unknown>;
  afterNode: string;
  locked?: boolean;           // true when execution is running / waiting
  lockedReason?: string;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * JSON editor modal for a single checkpoint's state. Validates JSON on every
 * keystroke; save is disabled unless the input parses cleanly. Rendered via
 * Portal so ancestor backdrop-blur doesn't trap `position: fixed`.
 */
export default function CheckpointEditorModal({
  executionId,
  checkpointId,
  initialState,
  afterNode,
  locked = false,
  lockedReason,
  onClose,
  onSaved,
}: Props) {
  const initialText = useMemo(() => JSON.stringify(initialState, null, 2), [initialState]);
  const [text, setText] = useState(initialText);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Live parse feedback
  useEffect(() => {
    try {
      JSON.parse(text);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [text]);

  // Lock body scroll while open + Escape closes
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const dirty = text !== initialText;
  const canSave = !saving && !error && dirty && !locked;

  async function handleSave() {
    setSaveError(null);
    setSaving(true);
    try {
      const state = JSON.parse(text) as Record<string, unknown>;
      await api.checkpoints.update(executionId, checkpointId, { state });
      onSaved();
      onClose();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-start justify-center z-[9999] p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-surface-50 border border-app rounded-lg w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl mt-[5vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-app">
          <div className="min-w-0">
            <h3 className="font-heading text-sm text-theme-primary tracking-wider">
              Edit saved state
            </h3>
            <p className="text-[11px] text-theme-muted font-mono truncate">
              after node · {afterNode}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-app-muted text-theme-muted hover:text-theme-secondary transition-colors"
            title="Close editor"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        {locked && (
          <div className="px-5 py-3 bg-amber-500/10 border-b border-amber-500/30 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-accent-yellow shrink-0 mt-0.5" />
            <div className="text-xs text-amber-300 font-body">
              <div className="font-semibold mb-0.5">Edits are disabled</div>
              <div>{lockedReason ?? 'Execution is active.'}</div>
            </div>
          </div>
        )}

        <div className="px-5 py-3 border-b border-app bg-red-500/5">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-accent-red shrink-0 mt-0.5" />
            <div className="text-[11px] text-theme-muted font-body">
              Editing a checkpoint's state directly changes what downstream nodes will see if you
              resume from this point. Missing keys that a node expects will cause it to fail. No
              schema validation is performed. You are responsible for correctness.
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-hidden flex flex-col">
          <label className="block overline px-5 pt-3 mb-1">
            state (JSON)
          </label>
          <textarea
            className="flex-1 mx-5 mb-3 px-3 py-2 rounded-md border border-app bg-app-card text-theme-primary text-xs font-mono focus:outline-none focus:border-accent-blue/60 resize-none min-h-[280px]"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={locked}
          />

          <div className="px-5 pb-2 min-h-[20px]">
            {error ? (
              <div className="text-[11px] text-accent-red font-mono">✗ {error}</div>
            ) : dirty ? (
              <div className="text-[11px] text-accent-green font-mono">✓ JSON valid</div>
            ) : (
              <div className="text-[11px] text-theme-subtle font-mono">no changes</div>
            )}
          </div>

          {saveError && (
            <div className="px-5 pb-2 text-[11px] text-accent-red font-mono">{saveError}</div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-app bg-app-muted/50">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md border border-app text-theme-secondary hover:bg-app-muted text-sm font-body transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="px-3 py-1.5 rounded-md bg-accent-blue text-white hover:opacity-90 disabled:opacity-40 text-sm font-body flex items-center gap-1.5 transition-opacity"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

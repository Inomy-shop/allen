import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare, X as XIcon } from 'lucide-react';
import { useResizable } from '../../hooks/useResizable';

export interface WorkflowFeedbackEntry {
  id: string;
  content: string;
  targetNodes?: string[];
  createdAt: string;
  createdBy?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  entries: WorkflowFeedbackEntry[];
  canAppend: boolean;
  agentNodeNames: string[];
  feedbackText: string;
  targetNodes: string[];
  busy: boolean;
  error: string | null;
  onTextChange: (value: string) => void;
  onTargetNodesChange: (value: string[]) => void;
  onSubmit: () => void;
}

export default function WorkflowFeedbackDrawer({
  open,
  onClose,
  entries,
  canAppend,
  agentNodeNames,
  feedbackText,
  targetNodes,
  busy,
  error,
  onTextChange,
  onTargetNodesChange,
  onSubmit,
}: Props) {
  const { size: drawerWidth, handleMouseDown: drawerResizeStart } = useResizable({
    direction: 'horizontal',
    initialSize: 560,
    minSize: 380,
    maxSize: 1200,
    side: 'end',
  });

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999]">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-in fade-in duration-150"
        onClick={onClose}
      />
      <aside
        className="absolute top-0 right-0 h-full bg-surface-50 border-l border-app shadow-2xl flex flex-col animate-in slide-in-from-right duration-200"
        style={{ width: `min(${drawerWidth}px, calc(100vw - 40px))` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="absolute top-0 left-0 bottom-0 w-2 cursor-col-resize z-10 group"
          onMouseDown={drawerResizeStart}
          title="Drag to resize"
        >
          <div className="absolute left-1/2 -translate-x-1/2 top-0 bottom-0 w-px bg-transparent group-hover:bg-accent-blue/60 transition-colors" />
        </div>

        <div className="flex items-center justify-between px-5 py-3.5 border-b border-app shrink-0">
          <div>
            <h3 className="text-[14px] font-medium text-theme-primary tracking-tight">Feedback</h3>
            <p className="text-[11px] text-theme-muted font-mono">
              {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-app-muted text-theme-muted hover:text-theme-secondary transition-colors"
            title="Close"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-4">
          {canAppend && (
            <div className="border border-app bg-app-card rounded-lg p-3 space-y-3">
              <textarea
                value={feedbackText}
                onChange={(e) => onTextChange(e.target.value)}
                rows={5}
                className="w-full bg-surface border border-app rounded-md px-3 py-2 text-xs text-theme-primary placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue resize-y"
                placeholder="Add corrective feedback for the next checkpoint rerun..."
              />

              {agentNodeNames.length > 0 && (
                <div className="border border-app rounded-md bg-surface max-h-44 overflow-y-auto p-2">
                  <label className="flex items-center gap-2 text-[11px] font-mono text-theme-secondary py-1">
                    <input
                      type="checkbox"
                      checked={targetNodes.length === 0}
                      onChange={() => onTargetNodesChange([])}
                      className="accent-accent-blue"
                    />
                    All agent nodes
                  </label>
                  {agentNodeNames.map((nodeName) => (
                    <label
                      key={nodeName}
                      className="flex items-center gap-2 text-[11px] font-mono text-theme-secondary py-1"
                    >
                      <input
                        type="checkbox"
                        checked={targetNodes.includes(nodeName)}
                        onChange={() => {
                          onTargetNodesChange(
                            targetNodes.includes(nodeName)
                              ? targetNodes.filter((n) => n !== nodeName)
                              : [...targetNodes, nodeName],
                          );
                        }}
                        className="accent-accent-blue"
                      />
                      <span className="truncate" title={nodeName}>{nodeName}</span>
                    </label>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-between gap-3">
                {error ? (
                  <div className="text-[11px] font-mono text-accent-red">{error}</div>
                ) : (
                  <div className="text-[11px] font-mono text-theme-subtle">
                    {targetNodes.length === 0 ? 'Applies to all agent nodes' : `${targetNodes.length} selected`}
                  </div>
                )}
                <button
                  onClick={onSubmit}
                  disabled={busy || !feedbackText.trim()}
                  className="btn-primary text-xs shrink-0 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
                  title="Append feedback to this workflow run"
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                  {busy ? 'Adding...' : 'Add Feedback'}
                </button>
              </div>
            </div>
          )}

          {entries.length === 0 ? (
            <div className="border border-dashed border-app rounded-lg p-6 text-center">
              <MessageSquare className="w-5 h-5 mx-auto text-theme-subtle mb-1.5" />
              <div className="text-xs text-theme-muted font-body">No feedback added yet.</div>
            </div>
          ) : (
            <div className="space-y-2">
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className="text-[11px] font-body text-theme-secondary bg-app-card border border-app rounded-lg px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2 text-[10px] font-mono text-theme-subtle mb-1">
                    <span>{new Date(entry.createdAt).toLocaleString()}</span>
                    <span className="truncate">
                      {entry.targetNodes && entry.targetNodes.length > 0
                        ? `Nodes: ${entry.targetNodes.join(', ')}`
                        : 'All agent nodes'}
                    </span>
                  </div>
                  <div className="whitespace-pre-wrap break-words">{entry.content}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

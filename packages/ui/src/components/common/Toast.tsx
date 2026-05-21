/**
 * Lightweight toast notification system.
 *
 * Usage:
 *   import { ToastContainer, useToast } from './Toast';
 *
 *   // In your root layout:
 *   <ToastContainer />
 *
 *   // In any component:
 *   const toast = useToast();
 *   toast.success('Scan started');
 *   toast.error('Something went wrong');
 *   toast.info('Processing...');
 */

import { useState, useCallback, useEffect, createContext, useContext } from 'react';
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 0;

const ICON = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
};

const STYLE = {
  success: 'border-accent-green/40 bg-accent-green/10 text-accent-green',
  error: 'border-accent-red/40 bg-accent-red/10 text-accent-red',
  info: 'border-accent-blue/40 bg-accent-blue/10 text-accent-blue',
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const Icon = ICON[toast.type];

  useEffect(() => {
    const t = setTimeout(onDismiss, toast.type === 'error' ? 6000 : 3500);
    return () => clearTimeout(t);
  }, [onDismiss, toast.type]);

  return (
    <div className={`flex items-center gap-2.5 px-4 py-2.5 rounded-lg border shadow-lg backdrop-blur-sm animate-in fade-in slide-in-from-top-2 duration-200 ${STYLE[toast.type]}`}>
      <Icon className="w-4 h-4 shrink-0" />
      <span className="text-xs font-body flex-1">{toast.message}</span>
      <button onClick={onDismiss} className="shrink-0 opacity-60 hover:opacity-100 transition-opacity">
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((type: ToastType, message: string) => {
    setToasts(prev => [...prev, { id: ++nextId, type, message }]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const ctx: ToastContextValue = {
    success: (msg) => push('success', msg),
    error: (msg) => push('error', msg),
    info: (msg) => push('info', msg),
  };

  return (
    <ToastContext.Provider value={ctx}>
      {children}
      {/* Toast container — fixed top-right */}
      {toasts.length > 0 && (
        <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
          {toasts.map(t => (
            <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}

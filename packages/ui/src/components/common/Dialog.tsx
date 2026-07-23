import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import Button from './Button';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  icon?: ReactNode;
  closeLabel?: string;
  dismissible?: boolean;
  className?: string;
}

export default function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  icon,
  closeLabel = 'Close dialog',
  dismissible = true,
  className = '',
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = 'hidden';
    const focusFrame = requestAnimationFrame(() => {
      const initialTarget = dialogRef.current?.querySelector<HTMLElement>(
        '[autofocus], button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled)',
      );
      (initialTarget ?? dialogRef.current)?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (dismissible && event.key === 'Escape') onClose();
      if (event.key !== 'Tab' || !dialogRef.current) return;

      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [dismissible, onClose, open]);

  if (!open) return null;

  return createPortal(
    <div
      className="dialog-scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`dialog ${className}`.trim()}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <div className="dialog-header">
          {icon && <div className="dialog-icon" aria-hidden="true">{icon}</div>}
          <div className="dialog-heading">
            <h2 id={titleId}>{title}</h2>
            {description && <div id={descriptionId} className="dialog-description">{description}</div>}
          </div>
          {dismissible && (
            <Button variant="ghost" size="icon" aria-label={closeLabel} onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
        {children && <div className="dialog-body">{children}</div>}
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

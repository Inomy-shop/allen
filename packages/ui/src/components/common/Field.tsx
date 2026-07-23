import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';

interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

export function Field({ label, hint, error, required, htmlFor, children, className = '' }: FieldProps) {
  return (
    <div className={`field ${className}`.trim()}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
        {required && <span className="field-required" aria-hidden="true"> *</span>}
      </label>
      {children}
      {(error || hint) && (
        <div className={error ? 'field-message field-message-error' : 'field-message'}>
          {error ?? hint}
        </div>
      )}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className = '', ...props },
  ref,
) {
  return <input ref={ref} className={`input ${className}`.trim()} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className = '', ...props },
  ref,
) {
  return <textarea ref={ref} className={`input textarea ${className}`.trim()} {...props} />;
});

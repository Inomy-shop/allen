import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'ink';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
  ink: 'btn-ink',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'btn-sm',
  md: '',
  lg: 'btn-lg',
  icon: 'btn-icon',
};

export default function Button({
  variant = 'secondary',
  size = 'md',
  leadingIcon,
  trailingIcon,
  className = '',
  type = 'button',
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={`btn ${variantClasses[variant]} ${sizeClasses[size]} ${className}`.trim()}
    >
      {leadingIcon && <span className="btn-icon-slot" aria-hidden="true">{leadingIcon}</span>}
      {children}
      {trailingIcon && <span className="btn-icon-slot" aria-hidden="true">{trailingIcon}</span>}
    </button>
  );
}

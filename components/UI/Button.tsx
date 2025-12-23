import { ReactNode, ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger' | 'success';
  fullWidth?: boolean;
  icon?: ReactNode;
}

/**
 * Button Component
 * Reusable button with consistent styling
 */
export default function Button({
  children,
  variant = 'primary',
  fullWidth = false,
  icon,
  disabled,
  ...props
}: ButtonProps) {
  const variantColors = {
    primary: {
      bg: '#667eea',
      bgHover: '#5a67d8',
      border: '#667eea',
    },
    secondary: {
      bg: 'white',
      bgHover: '#f9fafb',
      border: '#e5e7eb',
    },
    danger: {
      bg: '#ef4444',
      bgHover: '#dc2626',
      border: '#ef4444',
    },
    success: {
      bg: '#22c55e',
      bgHover: '#16a34a',
      border: '#22c55e',
    },
  };

  const colors = variantColors[variant];
  const isPrimary = variant === 'primary' || variant === 'danger' || variant === 'success';

  return (
    <button className="button" disabled={disabled} {...props}>
      <style jsx>{`
        .button {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          padding: 12px 20px;
          background: ${colors.bg};
          color: ${isPrimary ? 'white' : '#111827'};
          border: 2px solid ${colors.border};
          border-radius: 12px;
          font-size: 16px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
          width: ${fullWidth ? '100%' : 'auto'};
          font-family: inherit;
        }

        .button:hover:not(:disabled) {
          background: ${colors.bgHover};
          transform: translateY(-2px);
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }

        .button:active:not(:disabled) {
          transform: translateY(0);
        }

        .button:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .icon {
          font-size: 20px;
          display: flex;
          align-items: center;
        }
      `}</style>
      {icon && <span className="icon">{icon}</span>}
      {children}
    </button>
  );
}

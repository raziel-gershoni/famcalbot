import { ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'stat' | 'gradient';
  hoverable?: boolean;
}

/**
 * Card Component
 * Reusable card container with consistent styling
 */
export default function Card({
  children,
  onClick,
  variant = 'default',
  hoverable = false,
}: CardProps) {
  const isClickable = onClick !== undefined || hoverable;

  const getCardStyle = () => {
    switch (variant) {
      case 'stat':
        return {
          background: 'white',
          border: '2px solid #e5e7eb',
          textAlign: 'center' as const,
        };
      case 'gradient':
        return {
          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          border: 'none',
          color: 'white',
        };
      default:
        return {
          background: 'white',
          border: '2px solid #e5e7eb',
        };
    }
  };

  const style = getCardStyle();

  return (
    <div className="card" onClick={onClick} role={isClickable ? 'button' : undefined}>
      <style jsx>{`
        .card {
          background: ${style.background};
          border: ${style.border || '2px solid #e5e7eb'};
          ${style.color ? `color: ${style.color};` : ''}
          border-radius: 12px;
          padding: 20px;
          transition: all 0.2s;
          cursor: ${isClickable ? 'pointer' : 'default'};
          ${style.textAlign ? `text-align: ${style.textAlign};` : ''}
        }

        .card:hover {
          ${isClickable
            ? `
          border-color: #667eea;
          background: ${variant === 'default' ? '#f9fafb' : style.background};
          transform: translateY(-2px);
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          `
            : ''}
        }
      `}</style>
      {children}
    </div>
  );
}

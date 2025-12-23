interface StatusMessageProps {
  type: 'success' | 'error' | 'warning' | 'info';
  message: string;
  onDismiss?: () => void;
}

/**
 * StatusMessage Component
 * Displays success, error, warning, or info messages
 */
export default function StatusMessage({
  type,
  message,
  onDismiss,
}: StatusMessageProps) {
  const getTypeStyle = () => {
    switch (type) {
      case 'success':
        return {
          bg: '#d1fae5',
          border: '#10b981',
          color: '#065f46',
          icon: '✓',
        };
      case 'error':
        return {
          bg: '#fee2e2',
          border: '#ef4444',
          color: '#991b1b',
          icon: '✗',
        };
      case 'warning':
        return {
          bg: '#fef3c7',
          border: '#f59e0b',
          color: '#92400e',
          icon: '⚠',
        };
      case 'info':
        return {
          bg: '#dbeafe',
          border: '#3b82f6',
          color: '#1e40af',
          icon: 'ℹ',
        };
    }
  };

  const style = getTypeStyle();

  return (
    <div className="status-message" role="alert">
      <style jsx>{`
        .status-message {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px;
          background: ${style.bg};
          border: 2px solid ${style.border};
          border-radius: 12px;
          color: ${style.color};
          margin-bottom: 20px;
        }

        .message-content {
          display: flex;
          align-items: center;
          gap: 12px;
          flex: 1;
        }

        .icon {
          font-size: 20px;
          font-weight: bold;
          flex-shrink: 0;
        }

        .message-text {
          font-size: 15px;
          font-weight: 500;
        }

        .dismiss-button {
          background: transparent;
          border: none;
          color: ${style.color};
          font-size: 20px;
          cursor: pointer;
          padding: 0 4px;
          line-height: 1;
          opacity: 0.7;
          transition: opacity 0.2s;
        }

        .dismiss-button:hover {
          opacity: 1;
        }
      `}</style>

      <div className="message-content">
        <span className="icon">{style.icon}</span>
        <span className="message-text">{message}</span>
      </div>

      {onDismiss && (
        <button
          className="dismiss-button"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          ×
        </button>
      )}
    </div>
  );
}

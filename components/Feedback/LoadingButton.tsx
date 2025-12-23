'use client';

import { useState, ReactNode } from 'react';

interface LoadingButtonProps {
  children: ReactNode;
  onClick: () => Promise<void>;
  icon?: string;
  variant?: 'primary' | 'secondary' | 'danger' | 'success';
  loadingText?: string;
  successText?: string;
  errorText?: string;
  onSuccess?: () => void;
  onError?: (error: Error) => void;
}

type ButtonState = 'idle' | 'loading' | 'success' | 'error';

/**
 * LoadingButton Component
 * Button with automatic loading, success, and error state management
 */
export default function LoadingButton({
  children,
  onClick,
  icon,
  variant = 'secondary',
  loadingText = 'Loading...',
  successText = '✓ Success!',
  errorText = '✗ Error',
  onSuccess,
  onError,
}: LoadingButtonProps) {
  const [state, setState] = useState<ButtonState>('idle');

  const handleClick = async () => {
    setState('loading');

    try {
      await onClick();
      setState('success');
      onSuccess?.();

      // Reset to idle after showing success
      setTimeout(() => {
        setState('idle');
      }, 2000);
    } catch (error) {
      setState('error');
      onError?.(error as Error);

      // Reset to idle after showing error
      setTimeout(() => {
        setState('idle');
      }, 2000);
    }
  };

  const getButtonContent = () => {
    switch (state) {
      case 'loading':
        return (
          <>
            <span className="spinner">⏳</span>
            {loadingText}
          </>
        );
      case 'success':
        return successText;
      case 'error':
        return errorText;
      default:
        return (
          <>
            {icon && <span className="icon">{icon}</span>}
            {children}
          </>
        );
    }
  };

  const getButtonStyle = () => {
    const baseVariants = {
      primary: { bg: '#667eea', hover: '#5a67d8', border: '#667eea', color: 'white', opacity: 1 },
      secondary: { bg: 'white', hover: '#f9fafb', border: '#e5e7eb', color: '#111827', opacity: 1 },
      danger: { bg: '#ef4444', hover: '#dc2626', border: '#ef4444', color: 'white', opacity: 1 },
      success: { bg: '#22c55e', hover: '#16a34a', border: '#22c55e', color: 'white', opacity: 1 },
    };

    if (state === 'success') {
      return { ...baseVariants.success, opacity: 1 };
    }

    if (state === 'error') {
      return { ...baseVariants.danger, opacity: 1 };
    }

    if (state === 'loading') {
      return { ...baseVariants[variant], opacity: 0.6 };
    }

    return baseVariants[variant];
  };

  const buttonStyle = getButtonStyle();

  return (
    <button
      onClick={handleClick}
      disabled={state === 'loading' || state === 'success' || state === 'error'}
      className="loading-button"
    >
      <style jsx>{`
        .loading-button {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          padding: 16px 20px;
          background: ${buttonStyle.bg};
          color: ${buttonStyle.color};
          border: 2px solid ${buttonStyle.border};
          border-radius: 12px;
          font-size: 16px;
          font-weight: 500;
          cursor: ${state === 'idle' ? 'pointer' : 'not-allowed'};
          transition: all 0.2s;
          width: 100%;
          font-family: inherit;
          opacity: ${buttonStyle.opacity};
        }

        .loading-button:hover:not(:disabled) {
          background: ${buttonStyle.hover};
          transform: translateY(-2px);
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }

        .loading-button:active:not(:disabled) {
          transform: translateY(0);
        }

        .icon,
        .spinner {
          font-size: 20px;
          display: flex;
          align-items: center;
        }

        @keyframes spin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }

        .spinner {
          animation: spin 1s linear infinite;
        }
      `}</style>
      {getButtonContent()}
    </button>
  );
}

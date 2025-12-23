import { ReactNode } from 'react';

interface FormGroupProps {
  label: string;
  children: ReactNode;
  required?: boolean;
  error?: string;
  helperText?: string;
}

/**
 * FormGroup Component
 * Wrapper for form inputs with label, error, and helper text
 */
export default function FormGroup({
  label,
  children,
  required = false,
  error,
  helperText,
}: FormGroupProps) {
  return (
    <div className="form-group">
      <style jsx>{`
        .form-group {
          margin-bottom: 20px;
        }

        .label {
          display: block;
          font-size: 14px;
          font-weight: 600;
          color: #374151;
          margin-bottom: 8px;
        }

        .required {
          color: #ef4444;
          margin-left: 4px;
        }

        .helper-text {
          font-size: 12px;
          color: #6b7280;
          margin-top: 6px;
        }

        .error {
          font-size: 12px;
          color: #ef4444;
          margin-top: 6px;
          font-weight: 500;
        }

        :global(.form-group input),
        :global(.form-group select),
        :global(.form-group textarea) {
          width: 100%;
          padding: 12px 16px;
          font-size: 16px;
          border: 2px solid ${error ? '#ef4444' : '#e5e7eb'};
          border-radius: 8px;
          font-family: inherit;
          transition: border-color 0.2s;
        }

        :global(.form-group input:focus),
        :global(.form-group select:focus),
        :global(.form-group textarea:focus) {
          outline: none;
          border-color: ${error ? '#ef4444' : '#667eea'};
        }
      `}</style>

      <label className="label">
        {label}
        {required && <span className="required">*</span>}
      </label>

      {children}

      {error && <div className="error">{error}</div>}
      {!error && helperText && <div className="helper-text">{helperText}</div>}
    </div>
  );
}

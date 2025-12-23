interface CalendarCheckboxProps {
  id: string;
  name: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  description?: string;
}

/**
 * CalendarCheckbox Component
 * Checkbox for selecting calendars
 */
export default function CalendarCheckbox({
  id,
  name,
  checked,
  onChange,
  disabled = false,
  description,
}: CalendarCheckboxProps) {
  return (
    <label className="calendar-checkbox" htmlFor={id}>
      <style jsx>{`
        .calendar-checkbox {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          padding: 16px;
          border: 2px solid ${checked ? '#667eea' : '#e5e7eb'};
          border-radius: 12px;
          cursor: pointer;
          transition: all 0.2s;
          background: ${checked ? '#f0f4ff' : 'white'};
        }

        .calendar-checkbox:hover {
          border-color: #667eea;
          background: #f9fafb;
        }

        .checkbox-input {
          width: 20px;
          height: 20px;
          cursor: pointer;
          accent-color: #667eea;
          flex-shrink: 0;
          margin-top: 2px;
        }

        .checkbox-content {
          flex: 1;
        }

        .checkbox-name {
          font-size: 16px;
          font-weight: 500;
          color: #111827;
          margin-bottom: 4px;
        }

        .checkbox-description {
          font-size: 14px;
          color: #6b7280;
        }

        .calendar-checkbox.disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
      `}</style>

      <input
        type="checkbox"
        id={id}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="checkbox-input"
      />

      <div className="checkbox-content">
        <div className="checkbox-name">{name}</div>
        {description && <div className="checkbox-description">{description}</div>}
      </div>
    </label>
  );
}

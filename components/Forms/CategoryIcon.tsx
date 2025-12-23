'use client';

import { CalendarLabel } from '@/src/types';

interface CategoryIconProps {
  label: CalendarLabel;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}

const LABEL_CONFIG: Record<CalendarLabel, {
  icon: string;
  activeColor: string;
  inactiveColor: string;
  name: string;
}> = {
  primary: {
    icon: '🔵',
    activeColor: '#3b82f6',
    inactiveColor: '#d1d5db',
    name: 'Primary'
  },
  yours: {
    icon: '💼',
    activeColor: '#8b5cf6',
    inactiveColor: '#d1d5db',
    name: 'Yours'
  },
  spouse: {
    icon: '💑',
    activeColor: '#ec4899',
    inactiveColor: '#d1d5db',
    name: 'Spouse'
  },
  kids: {
    icon: '👶',
    activeColor: '#f59e0b',
    inactiveColor: '#d1d5db',
    name: 'Kids'
  },
  birthdays: {
    icon: '🎂',
    activeColor: '#10b981',
    inactiveColor: '#d1d5db',
    name: 'Birthdays'
  }
};

export default function CategoryIcon({ label, active, onClick, disabled = false }: CategoryIconProps) {
  const config = LABEL_CONFIG[label];

  return (
    <>
      <style jsx>{`
        .category-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 48px;
          height: 48px;
          border-radius: 8px;
          cursor: ${disabled ? 'not-allowed' : 'pointer'};
          transition: all 0.2s;
          font-size: 24px;
          border: 2px solid;
          background: ${active ? `${config.activeColor}15` : 'transparent'};
          border-color: ${active ? config.activeColor : config.inactiveColor};
          opacity: ${disabled ? 0.5 : 1};
          filter: ${active ? 'none' : 'grayscale(100%)'};
        }

        .category-icon:hover:not(:disabled) {
          transform: ${disabled ? 'none' : 'scale(1.05)'};
          box-shadow: ${disabled ? 'none' : `0 2px 8px ${config.activeColor}30`};
        }

        .category-icon:active:not(:disabled) {
          transform: ${disabled ? 'none' : 'scale(0.95)'};
        }
      `}</style>

      <button
        className="category-icon"
        onClick={onClick}
        disabled={disabled}
        type="button"
        title={config.name}
        aria-label={`${config.name} ${active ? '(active)' : ''}`}
      >
        {config.icon}
      </button>
    </>
  );
}

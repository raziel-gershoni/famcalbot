'use client';

import { CalendarLabel } from '@/src/types';
import { Star, Briefcase, Heart, Users, Cake } from 'lucide-react';

interface CategoryIconProps {
  label: CalendarLabel;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}

const LABEL_CONFIG: Record<CalendarLabel, {
  Icon: typeof Star;
  color: string;
  name: string;
}> = {
  primary: {
    Icon: Star,
    color: '#3b82f6',
    name: 'Primary'
  },
  yours: {
    Icon: Briefcase,
    color: '#8b5cf6',
    name: 'Yours'
  },
  spouse: {
    Icon: Heart,
    color: '#ec4899',
    name: 'Spouse'
  },
  kids: {
    Icon: Users,
    color: '#f59e0b',
    name: 'Kids'
  },
  birthdays: {
    Icon: Cake,
    color: '#10b981',
    name: 'Birthdays'
  }
};

export default function CategoryIcon({ label, active, onClick, disabled = false }: CategoryIconProps) {
  const config = LABEL_CONFIG[label];
  const Icon = config.Icon;

  return (
    <button
      className="category-icon"
      onClick={onClick}
      disabled={disabled}
      type="button"
      title={config.name}
      aria-label={`${config.name} ${active ? '(active)' : ''}`}
    >
      <Icon
        className="icon"
        size={18}
        fill={active ? config.color : 'none'}
        strokeWidth={active ? 0 : 2}
      />
      <style jsx>{`
        .category-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          border-radius: 6px;
          cursor: ${disabled ? 'not-allowed' : 'pointer'};
          transition: all 0.2s;
          border: 1px solid;
          background: ${active ? `${config.color}15` : 'transparent'};
          border-color: ${active ? config.color : '#d1d5db'};
          opacity: ${disabled ? 0.5 : 1};
          padding: 3px;
        }

        .category-icon :global(.icon) {
          stroke: ${active ? config.color : '#9ca3af'};
        }

        .category-icon:hover:not(:disabled) {
          transform: ${disabled ? 'none' : 'scale(1.1)'};
          box-shadow: ${disabled ? 'none' : `0 1px 4px ${config.color}30`};
        }

        .category-icon:active:not(:disabled) {
          transform: ${disabled ? 'none' : 'scale(0.95)'};
        }
      `}</style>
    </button>
  );
}

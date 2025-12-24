'use client';

import { CalendarLabel } from '@/src/types';
// Import icons directly to avoid loading entire barrel file during build
import StarIcon from '@heroicons/react/24/outline/StarIcon';
import BriefcaseIcon from '@heroicons/react/24/outline/BriefcaseIcon';
import HeartIcon from '@heroicons/react/24/outline/HeartIcon';
import UserGroupIcon from '@heroicons/react/24/outline/UserGroupIcon';
import CakeIcon from '@heroicons/react/24/outline/CakeIcon';

import StarSolid from '@heroicons/react/24/solid/StarIcon';
import BriefcaseSolid from '@heroicons/react/24/solid/BriefcaseIcon';
import HeartSolid from '@heroicons/react/24/solid/HeartIcon';
import UserGroupSolid from '@heroicons/react/24/solid/UserGroupIcon';
import CakeSolid from '@heroicons/react/24/solid/CakeIcon';

interface CategoryIconProps {
  label: CalendarLabel;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}

const LABEL_CONFIG: Record<CalendarLabel, {
  IconOutline: typeof StarIcon;
  IconSolid: typeof StarSolid;
  color: string;
  name: string;
}> = {
  primary: {
    IconOutline: StarIcon,
    IconSolid: StarSolid,
    color: '#3b82f6',
    name: 'Primary'
  },
  yours: {
    IconOutline: BriefcaseIcon,
    IconSolid: BriefcaseSolid,
    color: '#8b5cf6',
    name: 'Yours'
  },
  spouse: {
    IconOutline: HeartIcon,
    IconSolid: HeartSolid,
    color: '#ec4899',
    name: 'Spouse'
  },
  kids: {
    IconOutline: UserGroupIcon,
    IconSolid: UserGroupSolid,
    color: '#f59e0b',
    name: 'Kids'
  },
  birthdays: {
    IconOutline: CakeIcon,
    IconSolid: CakeSolid,
    color: '#10b981',
    name: 'Birthdays'
  }
};

export default function CategoryIcon({ label, active, onClick, disabled = false }: CategoryIconProps) {
  const config = LABEL_CONFIG[label];
  const Icon = active ? config.IconSolid : config.IconOutline;

  return (
    <button
      className="category-icon"
      onClick={onClick}
      disabled={disabled}
      type="button"
      title={config.name}
      aria-label={`${config.name} ${active ? '(active)' : ''}`}
    >
      <Icon className="icon" />
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
          width: 18px;
          height: 18px;
          color: ${active ? config.color : '#9ca3af'};
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

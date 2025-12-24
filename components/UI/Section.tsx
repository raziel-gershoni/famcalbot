import { ReactNode } from 'react';

interface SectionProps {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  icon?: string | ReactNode;
}

/**
 * Section Component
 * Organizes content into titled sections
 */
export default function Section({
  title,
  subtitle,
  children,
  icon,
}: SectionProps) {
  return (
    <section className="section">
      <style jsx>{`
        .section {
          margin-bottom: 30px;
        }

        .section-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
        }

        .section-title {
          font-size: 18px;
          font-weight: 600;
          color: #111827;
          margin: 0;
        }

        .section-icon {
          font-size: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .section-subtitle {
          font-size: 14px;
          color: #6b7280;
          margin: 0 0 12px 0;
        }

        .section-content {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
      `}</style>

      {(title || icon) && (
        <div className="section-header">
          {icon && <span className="section-icon">{icon}</span>}
          {title && <h2 className="section-title">{title}</h2>}
        </div>
      )}

      {subtitle && <p className="section-subtitle">{subtitle}</p>}

      <div className="section-content">{children}</div>
    </section>
  );
}

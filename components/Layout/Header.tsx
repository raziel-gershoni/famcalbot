import { Crown, Settings, ArrowLeft } from 'lucide-react';

interface HeaderProps {
  title: string;
  userName?: string;
  onSettingsClick?: () => void;
  onAdminClick?: () => void;
  onBackClick?: () => void;
  backgroundColor?: string;
  isAdmin?: boolean;
}

/**
 * Header Component
 * Common header for all webapp pages
 */
export default function Header({
  title,
  userName,
  onSettingsClick,
  onAdminClick,
  onBackClick,
  backgroundColor = '#667eea',
  isAdmin = false,
}: HeaderProps) {
  const bgGradient = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';

  return (
    <header style={{ background: bgGradient }}>
      <style jsx>{`
        header {
          color: white;
          padding: 20px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .left-section {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        h1 {
          font-size: 24px;
          font-weight: 600;
          margin: 0;
        }

        .back-button {
          background: rgba(255, 255, 255, 0.2);
          border: none;
          color: white;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.2s;
        }

        .back-button:hover {
          background: rgba(255, 255, 255, 0.3);
        }

        .user-info {
          display: flex;
          align-items: center;
          gap: 12px;
          font-size: 16px;
        }

        .admin-badge {
          background: rgba(255, 255, 255, 0.3);
          padding: 6px 12px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 1px;
        }

        .settings-icon {
          background: rgba(255, 255, 255, 0.2);
          border: none;
          color: white;
          font-size: 24px;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.2s;
        }

        .settings-icon:hover {
          background: rgba(255, 255, 255, 0.3);
        }
      `}</style>

      <div className="left-section">
        {onBackClick && (
          <button
            className="back-button"
            onClick={onBackClick}
            aria-label="Go Back"
          >
            <ArrowLeft size={20} color="white" />
          </button>
        )}
        <h1>{title}</h1>
      </div>

      <div className="user-info">
        {isAdmin && <div className="admin-badge">ADMIN</div>}
        {userName && <span>{userName}</span>}
        {isAdmin && onAdminClick && (
          <button
            className="settings-icon"
            onClick={onAdminClick}
            aria-label="Admin Panel"
          >
            <Crown size={20} color="white" />
          </button>
        )}
        {onSettingsClick && (
          <button
            className="settings-icon"
            onClick={onSettingsClick}
            aria-label="Settings"
          >
            <Settings size={20} color="white" />
          </button>
        )}
      </div>
    </header>
  );
}

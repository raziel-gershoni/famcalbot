'use client';

import { useEffect } from 'react';
import { RefreshCw, KeyRound } from 'lucide-react';

interface RefreshTokenClientProps {
  oauthUrl: string;
}

export default function RefreshTokenClient({ oauthUrl }: RefreshTokenClientProps) {
  useEffect(() => {
    // Initialize Telegram WebApp if available
    if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;
      tg.expand();
      tg.MainButton.setText('Connect Google Calendar');
      tg.MainButton.onClick(() => {
        // Open in external browser to avoid Google's disallowed_useragent error
        tg.openLink(oauthUrl);
      });
      tg.MainButton.show();
    }
  }, [oauthUrl]);

  return (
    <>
      <style jsx global>{`
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        body {
          font-family: 'Rubik', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 0;
          padding: 20px;
        }
      `}</style>

      <style jsx>{`
        .container {
          background: white;
          padding: 50px 40px;
          border-radius: 20px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          max-width: 450px;
          text-align: center;
          animation: slideUp 0.5s ease-out;
        }

        @keyframes slideUp {
          from {
            opacity: 0;
            transform: translateY(30px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .icon-wrapper {
          width: 80px;
          height: 80px;
          margin: 0 auto 30px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          animation: scaleIn 0.6s ease-out 0.2s both;
        }

        @keyframes scaleIn {
          from {
            transform: scale(0);
          }
          to {
            transform: scale(1);
          }
        }

        h2 {
          margin: 0 0 15px 0;
          color: #1f2937;
          font-size: 28px;
          font-weight: 600;
        }

        .subtitle {
          color: #6b7280;
          font-size: 16px;
          line-height: 1.6;
          margin-bottom: 30px;
        }

        .steps {
          text-align: left;
          background: #f3f4f6;
          padding: 20px;
          border-radius: 12px;
          margin-bottom: 30px;
        }

        .steps strong {
          color: #374151;
          font-size: 15px;
        }

        .steps ol {
          margin: 12px 0 0 0;
          padding-left: 20px;
        }

        .steps li {
          margin-bottom: 8px;
          color: #4b5563;
          font-size: 14px;
          line-height: 1.5;
        }

        .steps li:last-child {
          margin-bottom: 0;
        }

        .btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          width: 100%;
          padding: 16px 24px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          text-decoration: none;
          border: none;
          border-radius: 12px;
          font-size: 16px;
          font-weight: 600;
          cursor: pointer;
          transition: transform 0.2s, box-shadow 0.2s;
          box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }

        .btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 16px rgba(102, 126, 234, 0.5);
        }

        .btn:active {
          transform: translateY(0);
        }
      `}</style>

      <div className="container">
        <div className="icon-wrapper">
          <RefreshCw size={48} color="white" />
        </div>

        <h2>Refresh Calendar Access</h2>
        <p className="subtitle">
          Your Google Calendar access has expired. Let&apos;s refresh it!
        </p>

        <div className="steps">
          <strong>What will happen:</strong>
          <ol>
            <li>You&apos;ll log in to Google</li>
            <li>Grant calendar access</li>
            <li>Your bot will work again!</li>
          </ol>
        </div>

        <button
          onClick={() => {
            if (window.Telegram?.WebApp) {
              window.Telegram.WebApp.openLink(oauthUrl);
            } else {
              window.open(oauthUrl, '_blank');
            }
          }}
          className="btn"
        >
          <KeyRound size={20} />
          Connect Google Calendar
        </button>
      </div>

      <script
        dangerouslySetInnerHTML={{
          __html: `https://telegram.org/js/telegram-web-app.js`,
        }}
      />
    </>
  );
}

'use client';

import { useEffect } from 'react';

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
        window.location.href = oauthUrl;
      });
      tg.MainButton.show();
    }
  }, [oauthUrl]);

  return (
    <>
      <style jsx>{`
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 0;
          padding: 20px;
        }
        .container {
          background: white;
          padding: 40px;
          border-radius: 15px;
          box-shadow: 0 10px 40px rgba(0,0,0,0.3);
          max-width: 400px;
          text-align: center;
        }
        .icon {
          font-size: 64px;
          margin-bottom: 20px;
        }
        h2 {
          margin: 0 0 20px 0;
          color: #333;
        }
        p {
          color: #666;
          line-height: 1.6;
          margin-bottom: 30px;
        }
        .btn {
          display: inline-block;
          padding: 15px 30px;
          background: #667eea;
          color: white;
          text-decoration: none;
          border-radius: 8px;
          font-size: 16px;
          font-weight: 600;
          transition: background 0.3s;
        }
        .btn:hover {
          background: #5a67d8;
        }
        .steps {
          text-align: left;
          background: #f9fafb;
          padding: 20px;
          border-radius: 8px;
          margin-bottom: 30px;
        }
        .steps ol {
          margin: 0;
          padding-left: 20px;
        }
        .steps li {
          margin-bottom: 10px;
          color: #555;
        }
      `}</style>

      <div className="container">
        <div className="icon">🔄</div>
        <h2>Refresh Calendar Access</h2>
        <p>Your Google Calendar access has expired. Let&apos;s refresh it!</p>

        <div className="steps">
          <strong>What will happen:</strong>
          <ol>
            <li>You&apos;ll log in to Google</li>
            <li>Grant calendar access</li>
            <li>Your bot will work again!</li>
          </ol>
        </div>

        <a href={oauthUrl} className="btn">
          🔐 Connect Google Calendar
        </a>
      </div>

      <script
        dangerouslySetInnerHTML={{
          __html: `https://telegram.org/js/telegram-web-app.js`,
        }}
      />
    </>
  );
}

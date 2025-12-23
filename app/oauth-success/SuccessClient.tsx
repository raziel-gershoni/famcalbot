'use client';

import { useEffect } from 'react';

interface SuccessClientProps {
  userName: string;
  botUsername: string;
}

export default function SuccessClient({ userName, botUsername }: SuccessClientProps) {
  useEffect(() => {
    // Initialize Telegram WebApp
    if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;
      tg.expand();
      tg.ready();
    }
  }, []);

  const runSummary = (timeframe: 'today' | 'tmrw') => {
    if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;
      const command = timeframe === 'today' ? '/summary' : '/summary tmrw';

      // Use Telegram deep link to return to chat with command
      const deepLink = `https://t.me/${botUsername}?text=${encodeURIComponent(command)}`;

      // Open the link
      tg.openLink(deepLink);

      // Small delay before closing to ensure link opens
      setTimeout(() => tg.close(), 500);
    }
  };

  const closeWindow = () => {
    if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
      window.Telegram.WebApp.close();
    }
  };

  return (
    <html>
      <head>
        <title>✅ Calendars Saved</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script src="https://telegram.org/js/telegram-web-app.js"></script>
        <style>{`
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
            max-width: 500px;
            width: 100%;
          }
          .success-box {
            background: white;
            padding: 40px;
            border-radius: 15px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            text-align: center;
          }
          .icon {
            font-size: 64px;
            margin-bottom: 20px;
            animation: bounce 1s;
          }
          @keyframes bounce {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-20px); }
          }
          h1 {
            color: #22c55e;
            margin: 0 0 10px 0;
          }
          p {
            color: #666;
            line-height: 1.6;
          }
          .user-info {
            background: #f9fafb;
            padding: 15px;
            border-radius: 8px;
            margin: 20px 0;
          }
          .actions {
            margin: 30px 0;
            display: flex;
            flex-direction: column;
            gap: 10px;
          }
          .btn {
            padding: 15px 30px;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
          }
          .btn-primary {
            background: #667eea;
            color: white;
          }
          .btn-primary:hover {
            background: #5a67d8;
          }
          .btn-secondary {
            background: #f3f4f6;
            color: #374151;
          }
          .btn-secondary:hover {
            background: #e5e7eb;
          }
          .note {
            color: #6b7280;
            font-size: 14px;
            margin-top: 20px;
          }
        `}</style>
      </head>
      <body>
        <div className="container">
          <div className="success-box">
            <div className="icon">✅</div>
            <h1>Calendars Saved!</h1>
            <div className="user-info">
              <strong>{userName}</strong><br />
              Your calendar settings have been updated successfully
            </div>

            <div className="actions">
              <p><strong>Get your calendar summary:</strong></p>
              <button onClick={() => runSummary('today')} className="btn btn-primary">
                📅 Today&apos;s Summary
              </button>
              <button onClick={() => runSummary('tmrw')} className="btn btn-primary">
                📆 Tomorrow&apos;s Summary
              </button>
              <button onClick={closeWindow} className="btn btn-secondary">
                ← Back to Chat
              </button>
            </div>

            <p className="note">Tap a button to continue</p>
          </div>
        </div>
      </body>
    </html>
  );
}

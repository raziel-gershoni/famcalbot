'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, ArrowRight } from 'lucide-react';

interface OAuthCompleteClientProps {
  userId?: string;
  locale: string;
  botUsername: string;
}

export default function OAuthCompleteClient({ userId, locale, botUsername }: OAuthCompleteClientProps) {
  const [countdown, setCountdown] = useState(3);

  useEffect(() => {
    // Countdown timer
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          // Auto-redirect to Telegram
          redirectToTelegram();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  const selectCalendarsUrl = userId
    ? `/${locale}/select-calendars?user_id=${userId}`
    : `/${locale}/select-calendars`;

  const redirectToTelegram = () => {
    // Redirect to select calendars page to continue setup
    window.location.href = selectCalendarsUrl;
  };

  return (
    <html lang={locale}>
      <head>
        <title>Google Calendar Connected</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>{`
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
            padding: 20px;
          }
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
          .success-icon {
            width: 80px;
            height: 80px;
            margin: 0 auto 30px;
            background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
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
          h1 {
            color: #1f2937;
            font-size: 28px;
            font-weight: 600;
            margin-bottom: 15px;
          }
          .subtitle {
            color: #6b7280;
            font-size: 16px;
            margin-bottom: 30px;
            line-height: 1.6;
          }
          .countdown {
            background: #f3f4f6;
            padding: 20px;
            border-radius: 12px;
            margin-bottom: 25px;
          }
          .countdown-text {
            color: #4b5563;
            font-size: 14px;
            margin-bottom: 8px;
          }
          .countdown-number {
            font-size: 36px;
            font-weight: 700;
            color: #667eea;
            font-feature-settings: 'tnum';
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
          .secondary-link {
            display: block;
            margin-top: 15px;
            color: #667eea;
            text-decoration: none;
            font-size: 14px;
            font-weight: 500;
          }
          .secondary-link:hover {
            text-decoration: underline;
          }
          .divider {
            margin: 25px 0;
            color: #9ca3af;
            font-size: 13px;
          }
        `}</style>
      </head>
      <body>
        <div className="container">
          <div className="success-icon">
            <CheckCircle2 size={48} color="white" />
          </div>

          <h1>Successfully Connected! 🎉</h1>
          <p className="subtitle">
            Your Google Calendar is now connected to FamCalBot.
          </p>

          {countdown > 0 && (
            <div className="countdown">
              <div className="countdown-text">Continuing in</div>
              <div className="countdown-number">{countdown}</div>
            </div>
          )}

          <button onClick={redirectToTelegram} className="btn">
            Continue to Select Calendars
            <ArrowRight size={20} />
          </button>
        </div>
      </body>
    </html>
  );
}

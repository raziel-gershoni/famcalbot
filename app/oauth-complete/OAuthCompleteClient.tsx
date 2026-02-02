'use client';

import { CheckCircle2, ArrowRight } from 'lucide-react';

interface Translations {
  title: string;
  subtitle: string;
  button: string;
}

interface OAuthCompleteClientProps {
  locale: string;
  botUsername: string;
  translations: Translations;
}

export default function OAuthCompleteClient({ locale, botUsername, translations: t }: OAuthCompleteClientProps) {
  const isRTL = locale === 'he';

  const redirectToTelegram = () => {
    // Deep link to open Telegram bot
    window.location.href = `https://t.me/${botUsername}`;
  };

  return (
    <html lang={locale} dir={isRTL ? 'rtl' : 'ltr'}>
      <head>
        <title>{t.title}</title>
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
      </head>
      <body>
        <div className="container">
          <div className="success-icon">
            <CheckCircle2 size={48} color="white" />
          </div>

          <h1>{t.title}</h1>
          <p className="subtitle">{t.subtitle}</p>

          <button onClick={redirectToTelegram} className="btn">
            {t.button}
            <ArrowRight size={20} style={isRTL ? { transform: 'scaleX(-1)' } : undefined} />
          </button>
        </div>
      </body>
    </html>
  );
}

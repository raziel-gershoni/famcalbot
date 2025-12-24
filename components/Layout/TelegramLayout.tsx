'use client';

import { useEffect } from 'react';

interface TelegramLayoutProps {
  children: React.ReactNode;
  headerColor?: string;
  backgroundColor?: string;
}

/**
 * TelegramLayout Component
 * Wraps content with Telegram WebApp initialization and styling
 */
export default function TelegramLayout({
  children,
  headerColor = '#667eea',
  backgroundColor = '#ffffff',
}: TelegramLayoutProps) {
  useEffect(() => {
    // Initialize Telegram WebApp
    if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;
      tg.expand();
      tg.ready();
      tg.setHeaderColor(headerColor);
      tg.setBackgroundColor(backgroundColor);
    }
  }, [headerColor, backgroundColor]);

  return (
    <div className="telegram-webapp">
      <style jsx global>{`
        @import url('https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600;700&display=swap');

        .telegram-webapp {
          min-height: 100vh;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }

        body {
          margin: 0;
          padding: 0;
          font-family: 'Rubik', -apple-system, BlinkMacSystemFont, 'Segoe UI',
            'Roboto', 'Helvetica Neue', Arial, sans-serif;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }

        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
      `}</style>
      {children}
    </div>
  );
}
// Type declarations for Telegram WebApp are now in /src/types/telegram-webapp.d.ts

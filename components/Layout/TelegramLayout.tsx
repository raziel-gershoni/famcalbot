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
      <style jsx>{`
        .telegram-webapp {
          min-height: 100vh;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }

        :global(body) {
          margin: 0;
          padding: 0;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto',
            'Helvetica', 'Arial', sans-serif;
        }

        :global(*) {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
      `}</style>
      {children}
    </div>
  );
}

// Type declaration for Telegram WebApp
declare global {
  interface Window {
    Telegram?: {
      WebApp: {
        ready: () => void;
        expand: () => void;
        close: () => void;
        setHeaderColor: (color: string) => void;
        setBackgroundColor: (color: string) => void;
        openLink: (url: string) => void;
      };
    };
  }
}

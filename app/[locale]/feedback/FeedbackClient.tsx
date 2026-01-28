'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { TelegramLayout } from '@/components/Layout';
import { MessageSquare, ArrowLeft, Loader2, CheckCircle2 } from 'lucide-react';

interface FeedbackClientProps {
  userId: number;
  locale: string;
}

export default function FeedbackClient({ userId, locale }: FeedbackClientProps) {
  const t = useTranslations('dashboard');
  const router = useRouter();

  const [feedbackText, setFeedbackText] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;
      tg.expand();
      tg.ready();
      tg.setHeaderColor('#667eea');
      tg.setBackgroundColor('#ffffff');
    }
  }, []);

  const handleBack = () => {
    router.push(`/${locale}/dashboard?user_id=${userId}`);
  };

  const handleSubmit = async () => {
    if (!feedbackText.trim() || status === 'submitting') return;

    const trimmedText = feedbackText.trim();

    // Client-side validation
    if (trimmedText.length < 10) {
      setErrorMessage(t('feedback.tooShort'));
      return;
    }
    if (trimmedText.length > 1000) {
      setErrorMessage(t('feedback.tooLong'));
      return;
    }

    setStatus('submitting');
    setErrorMessage(null);

    try {
      const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;

      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: trimmedText,
          initData,
        }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setStatus('success');
        setFeedbackText('');
      } else {
        setStatus('error');
        // Map error codes to translation keys
        if (data.error === 'rateLimit') {
          setErrorMessage(t('feedback.rateLimit'));
        } else if (data.error === 'tooShort') {
          setErrorMessage(t('feedback.tooShort'));
        } else if (data.error === 'tooLong') {
          setErrorMessage(t('feedback.tooLong'));
        } else {
          setErrorMessage(t('feedback.error'));
        }
      }
    } catch (error) {
      console.error('Feedback submission error:', error);
      setStatus('error');
      setErrorMessage(t('feedback.error'));
    }
  };

  if (status === 'success') {
    return (
      <TelegramLayout>
        <style jsx>{`
          .success-container {
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 20px;
            background: white;
          }
          .success-icon {
            margin-bottom: 20px;
          }
          .success-title {
            font-size: 24px;
            font-weight: 600;
            color: #22c55e;
            margin: 0 0 12px 0;
            text-align: center;
          }
          .success-message {
            font-size: 16px;
            color: #6b7280;
            text-align: center;
            margin: 0 0 32px 0;
          }
          .back-btn {
            padding: 14px 28px;
            background: #667eea;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.2s;
          }
          .back-btn:hover {
            background: #5a67d8;
          }
        `}</style>
        <div className="success-container">
          <div className="success-icon">
            <CheckCircle2 size={64} color="#22c55e" />
          </div>
          <h1 className="success-title">{t('feedback.success')}</h1>
          <p className="success-message">{t('feedback.successDesc') || 'Your feedback helps us improve!'}</p>
          <button className="back-btn" onClick={handleBack}>
            {t('feedback.backToDashboard') || 'Back to Dashboard'}
          </button>
        </div>
      </TelegramLayout>
    );
  }

  return (
    <TelegramLayout>
      <style jsx>{`
        .container {
          max-width: 600px;
          margin: 0 auto;
          background: white;
          min-height: 100vh;
        }

        header {
          background: #667eea;
          color: white;
          padding: 16px 20px;
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .back-button {
          background: none;
          border: none;
          color: white;
          cursor: pointer;
          padding: 8px;
          margin: -8px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 8px;
          transition: background 0.2s;
        }

        .back-button:hover {
          background: rgba(255, 255, 255, 0.1);
        }

        .header-content {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        header h1 {
          font-size: 20px;
          font-weight: 600;
          margin: 0;
        }

        .content {
          padding: 20px;
        }

        .description {
          color: #6b7280;
          font-size: 14px;
          margin: 0 0 20px 0;
          line-height: 1.5;
        }

        .feedback-textarea {
          width: 100%;
          min-height: 200px;
          padding: 16px;
          border: 2px solid #e5e7eb;
          border-radius: 12px;
          font-size: 16px;
          font-family: inherit;
          resize: vertical;
          transition: border-color 0.2s;
          line-height: 1.5;
        }

        .feedback-textarea:focus {
          outline: none;
          border-color: #667eea;
        }

        .feedback-textarea:disabled {
          background: #f9fafb;
          cursor: not-allowed;
        }

        .feedback-textarea.error {
          border-color: #ef4444;
        }

        .char-count {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-top: 8px;
          font-size: 13px;
          color: #9ca3af;
        }

        .char-count.warning {
          color: #f59e0b;
        }

        .char-count.error {
          color: #ef4444;
        }

        .error-message {
          background: #fee2e2;
          color: #991b1b;
          padding: 12px 16px;
          border-radius: 8px;
          font-size: 14px;
          margin-top: 16px;
        }

        .submit-btn {
          width: 100%;
          padding: 16px;
          background: #667eea;
          color: white;
          border: none;
          border-radius: 12px;
          font-size: 16px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
          margin-top: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }

        .submit-btn:hover:not(:disabled) {
          background: #5a67d8;
          transform: translateY(-1px);
        }

        .submit-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        .spinner {
          animation: spin 1s linear infinite;
        }
      `}</style>

      <div className="container">
        <header>
          <button className="back-button" onClick={handleBack} aria-label="Back">
            <ArrowLeft size={24} />
          </button>
          <div className="header-content">
            <MessageSquare size={24} />
            <h1>{t('feedback.pageTitle') || t('feedback.title')}</h1>
          </div>
        </header>

        <div className="content">
          <p className="description">
            {t('feedback.placeholder')}
          </p>

          <textarea
            className={`feedback-textarea ${errorMessage ? 'error' : ''}`}
            placeholder={t('feedback.placeholder')}
            value={feedbackText}
            onChange={(e) => {
              setFeedbackText(e.target.value);
              setErrorMessage(null);
              if (status === 'error') setStatus('idle');
            }}
            maxLength={1000}
            disabled={status === 'submitting'}
          />

          <div className={`char-count ${feedbackText.length > 950 ? 'warning' : ''} ${feedbackText.length >= 1000 ? 'error' : ''}`}>
            <span>{feedbackText.length < 10 && feedbackText.length > 0 ? `${10 - feedbackText.length} more characters needed` : ''}</span>
            <span>{feedbackText.length}/1000</span>
          </div>

          {errorMessage && (
            <div className="error-message">
              {errorMessage}
            </div>
          )}

          <button
            className="submit-btn"
            onClick={handleSubmit}
            disabled={status === 'submitting' || !feedbackText.trim() || feedbackText.trim().length < 10}
          >
            {status === 'submitting' ? (
              <>
                <Loader2 size={20} className="spinner" />
                {t('feedback.sending')}
              </>
            ) : (
              t('feedback.submit')
            )}
          </button>
        </div>
      </div>
    </TelegramLayout>
  );
}

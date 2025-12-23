'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

interface SettingsClientProps {
  userId: number;
  currentSettings: {
    language: string;
    location: string;
    messagingPlatform: string;
  };
}

type FormState = 'idle' | 'saving' | 'success' | 'error';

export default function SettingsClient({ userId, currentSettings }: SettingsClientProps) {
  const t = useTranslations('settings');
  const router = useRouter();
  const [formState, setFormState] = useState<FormState>('idle');
  const [language, setLanguage] = useState(currentSettings.language);
  const [location, setLocation] = useState(currentSettings.location);
  const [messagingPlatform, setMessagingPlatform] = useState(currentSettings.messagingPlatform);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;
      tg.expand();
      tg.ready();
      tg.setHeaderColor('#667eea');
      tg.setBackgroundColor('#ffffff');
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormState('saving');

    try {
      const response = await fetch(`/api/settings?user_id=${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language,
          location,
          messagingPlatform
        })
      });

      if (!response.ok) {
        throw new Error('Failed to save settings');
      }

      setFormState('success');

      // Map language to locale
      const locale = language === 'Hebrew' ? 'he' : 'en';

      // Auto-redirect after 2 seconds
      setTimeout(() => {
        router.push(`/${locale}/dashboard?user_id=${userId}`);
      }, 2000);

    } catch (error) {
      console.error('Error saving settings:', error);
      setFormState('error');

      // Reset after 3 seconds
      setTimeout(() => {
        setFormState('idle');
      }, 3000);
    }
  };

  const handleCancel = () => {
    // Map current language to locale
    const locale = language === 'Hebrew' ? 'he' : 'en';
    router.push(`/${locale}/dashboard?user_id=${userId}`);
  };

  if (formState === 'success') {
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
          .success-box {
            background: white;
            padding: 40px;
            border-radius: 15px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            text-align: center;
            max-width: 400px;
          }
          .icon {
            font-size: 64px;
            margin-bottom: 20px;
          }
          h1 { color: #22c55e; margin: 0 0 10px 0; }
          p { color: #666; }
        `}</style>
        <div className="success-box">
          <div className="icon">✅</div>
          <h1>{t('actions.saved')}</h1>
          <p>{t('successMessage')}</p>
        </div>
      </>
    );
  }

  return (
    <>
      <style jsx>{`
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }

        .container {
          max-width: 600px;
          margin: 0 auto;
          background: white;
          min-height: 100vh;
        }

        header {
          background: #667eea;
          color: white;
          padding: 20px;
        }

        header h1 {
          font-size: 24px;
          font-weight: 600;
        }

        .content {
          padding: 20px;
        }

        .form-group {
          margin-bottom: 24px;
        }

        label {
          display: block;
          font-weight: 600;
          color: #374151;
          margin-bottom: 8px;
          font-size: 14px;
        }

        input,
        select {
          width: 100%;
          padding: 12px;
          border: 2px solid #e5e7eb;
          border-radius: 8px;
          font-size: 16px;
          transition: border-color 0.2s;
        }

        input:focus,
        select:focus {
          outline: none;
          border-color: #667eea;
        }

        .help-text {
          font-size: 13px;
          color: #6b7280;
          margin-top: 4px;
        }

        .btn {
          width: 100%;
          padding: 15px;
          background: #667eea;
          color: white;
          border: none;
          border-radius: 8px;
          font-size: 16px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.2s;
          margin-top: 8px;
        }

        .btn:hover:not(:disabled) {
          background: #5a67d8;
        }

        .btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .btn-secondary {
          background: #f3f4f6;
          color: #374151;
        }

        .btn-secondary:hover:not(:disabled) {
          background: #e5e7eb;
        }

        .btn-error {
          background: #ef4444;
        }
      `}</style>

      <div className="container">
        <header>
          <h1>{t('title')}</h1>
        </header>

        <div className="content">
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label htmlFor="language">{t('preferences.language')}</label>
              <select
                name="language"
                id="language"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                disabled={formState !== 'idle'}
              >
                <option value="Hebrew">עברית (Hebrew)</option>
                <option value="English">English</option>
              </select>
              <p className="help-text">{t('languageHelp')}</p>
            </div>

            <div className="form-group">
              <label htmlFor="location">{t('personal.location')}</label>
              <input
                type="text"
                name="location"
                id="location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder={t('personal.locationPlaceholder')}
                disabled={formState !== 'idle'}
              />
              <p className="help-text">{t('locationHelp')}</p>
            </div>

            <div className="form-group">
              <label htmlFor="messagingPlatform">{t('platformLabel')}</label>
              <select
                name="messagingPlatform"
                id="messagingPlatform"
                value={messagingPlatform}
                onChange={(e) => setMessagingPlatform(e.target.value)}
                disabled={formState !== 'idle'}
              >
                <option value="telegram">Telegram</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="all">{t('platformBoth')}</option>
              </select>
              <p className="help-text">{t('platformHelp')}</p>
            </div>

            <button
              type="submit"
              className={`btn ${formState === 'error' ? 'btn-error' : ''}`}
              disabled={formState !== 'idle'}
            >
              {formState === 'saving' && t('actions.saving')}
              {formState === 'error' && t('actions.error')}
              {formState === 'idle' && t('actions.save')}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleCancel}
              disabled={formState !== 'idle'}
            >
              {t('cancelButton')}
            </button>
          </form>
        </div>
      </div>
    </>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { TelegramLayout } from '@/components/Layout';
import { CheckCircle2, Settings, MapPin, Loader2 } from 'lucide-react';

interface SettingsClientProps {
  userId: number;
  currentSettings: {
    language: string;
    location: string;
    messagingPlatform: string;
    culture: string;
    textSummaryEnabled: boolean;
    voiceSummaryEnabled: boolean;
    weatherEnabled: boolean;
    includeLookaheadInTomorrow: boolean;
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
  const [culture, setCulture] = useState(currentSettings.culture);
  const [textSummaryEnabled, setTextSummaryEnabled] = useState(currentSettings.textSummaryEnabled);
  const [voiceSummaryEnabled, setVoiceSummaryEnabled] = useState(currentSettings.voiceSummaryEnabled);
  const [weatherEnabled, setWeatherEnabled] = useState(currentSettings.weatherEnabled);
  const [includeLookaheadInTomorrow, setIncludeLookaheadInTomorrow] = useState(currentSettings.includeLookaheadInTomorrow);
  const [locationLoading, setLocationLoading] = useState(false);
  const [detectedLocation, setDetectedLocation] = useState<string | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [locationValidating, setLocationValidating] = useState(false);

  // Valid location types for weather (cities, towns, regions, etc.)
  const VALID_LOCATION_TYPES = [
    'city', 'town', 'village', 'municipality', 'county', 'state',
    'country', 'suburb', 'hamlet', 'locality', 'region', 'province',
    'district', 'neighbourhood', 'borough', 'quarter'
  ];

  // Validate location by attempting to geocode it
  const validateLocation = async (loc: string): Promise<boolean> => {
    if (!loc.trim()) {
      setLocationError(null);
      return true; // Empty is allowed
    }

    setLocationValidating(true);
    setLocationError(null);

    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(loc)}&format=json&limit=1&addressdetails=1`,
        {
          headers: {
            'User-Agent': 'FamCalBot/1.0'
          }
        }
      );

      if (!response.ok) {
        setLocationError(t('locationValidationError'));
        return false;
      }

      const data = await response.json();

      if (Array.isArray(data) && data.length > 0) {
        const result = data[0];
        // Check if it's a valid location type (not a building, ridge, etc.)
        if (VALID_LOCATION_TYPES.includes(result.addresstype)) {
          setLocationError(null);
          return true;
        }
        // Fallback: accept if importance is high enough (major places)
        if (result.importance > 0.4) {
          setLocationError(null);
          return true;
        }
        setLocationError(t('locationInvalid'));
        return false;
      } else {
        setLocationError(t('locationInvalid'));
        return false;
      }
    } catch (error) {
      setLocationError(t('locationValidationError'));
      return false;
    } finally {
      setLocationValidating(false);
    }
  };

  // Validate on blur
  const handleLocationBlur = () => {
    if (location.trim()) {
      validateLocation(location);
    }
  };

  // Get current location using browser geolocation + reverse geocoding
  const handleGetLocation = async () => {
    if (!navigator.geolocation) {
      alert('Geolocation is not supported by your browser');
      return;
    }

    setLocationLoading(true);
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: false,
          timeout: 10000,
          maximumAge: 300000 // 5 minutes cache
        });
      });

      const { latitude, longitude } = position.coords;

      // Reverse geocode using Nominatim (free, no API key needed)
      // Force English output for geocoding compatibility
      const response = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json&zoom=10&accept-language=en`
      );
      const data = await response.json();

      // Extract city and country
      const city = data.address?.city || data.address?.town || data.address?.village || data.address?.municipality;
      const country = data.address?.country;

      let locationString = '';
      if (city && country) {
        locationString = `${city}, ${country}`;
      } else if (data.display_name) {
        // Fallback to display name, but shorten it
        const parts = data.display_name.split(',');
        locationString = parts.slice(0, 2).join(',').trim();
      }

      if (locationString) {
        setDetectedLocation(locationString);
      } else {
        alert('Could not determine your location. Please enter it manually.');
      }
    } catch (error) {
      console.error('Error getting location:', error);
      alert('Could not get your location. Please enter it manually.');
    } finally {
      setLocationLoading(false);
    }
  };

  const handleAcceptLocation = () => {
    if (detectedLocation) {
      setLocation(detectedLocation);
      setLocationError(null); // Clear any previous error - detected location is valid
    }
    setDetectedLocation(null);
  };

  const handleDeclineLocation = () => {
    setDetectedLocation(null);
  };

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

    // Validate location before saving
    if (location.trim()) {
      const isValid = await validateLocation(location);
      if (!isValid) {
        return; // Don't save if location is invalid
      }
    }

    setFormState('saving');

    try {
      // Get Telegram Web App initData for authentication
      const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;

      const response = await fetch(`/api/settings?user_id=${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language,
          location,
          messagingPlatform,
          culture,
          textSummaryEnabled,
          voiceSummaryEnabled,
          weatherEnabled,
          includeLookaheadInTomorrow,
          initData
        })
      });

      if (!response.ok) {
        throw new Error('Failed to save settings');
      }

      setFormState('success');

      // Auto-redirect after 2 seconds (language is already locale code)
      setTimeout(() => {
        router.push(`/${language}/dashboard?user_id=${userId}`);
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
    // language is already locale code ('he', 'en', 'ru')
    router.push(`/${language}/dashboard?user_id=${userId}`);
  };

  if (formState === 'success') {
    return (
      <TelegramLayout>
        <style jsx>{`
          .success-container {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
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
        <div className="success-container">
          <div className="success-box">
            <div className="icon"><CheckCircle2 size={64} color="#22c55e" /></div>
            <h1>{t('actions.saved')}</h1>
            <p>{t('successMessage')}</p>
          </div>
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

        .error-text {
          font-size: 13px;
          color: #ef4444;
          margin-top: 4px;
        }

        .validating-text {
          font-size: 13px;
          color: #6b7280;
          margin-top: 4px;
          display: flex;
          align-items: center;
        }

        .input-error {
          border-color: #ef4444 !important;
        }

        .input-error:focus {
          border-color: #ef4444 !important;
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

        .location-row {
          display: flex;
          gap: 8px;
        }

        .location-row input {
          flex: 1;
        }

        .location-btn {
          padding: 12px;
          background: #f3f4f6;
          border: 2px solid #e5e7eb;
          border-radius: 8px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s;
          flex-shrink: 0;
        }

        .location-btn:hover:not(:disabled) {
          background: #e5e7eb;
          border-color: #667eea;
        }

        .location-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .location-btn svg {
          color: #667eea;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        .spinning {
          animation: spin 1s linear infinite;
        }

        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          padding: 20px;
        }

        .modal {
          background: white;
          border-radius: 12px;
          padding: 24px;
          max-width: 320px;
          width: 100%;
          text-align: center;
          box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
        }

        .modal-icon {
          margin-bottom: 16px;
          color: #667eea;
        }

        .modal-title {
          font-size: 18px;
          font-weight: 600;
          color: #374151;
          margin: 0 0 8px 0;
        }

        .modal-location {
          font-size: 16px;
          color: #667eea;
          font-weight: 500;
          margin: 0 0 20px 0;
          padding: 12px;
          background: #f3f4f6;
          border-radius: 8px;
        }

        .modal-buttons {
          display: flex;
          gap: 12px;
        }

        .modal-btn {
          flex: 1;
          padding: 12px;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          border: none;
          transition: all 0.2s;
        }

        .modal-btn-accept {
          background: #667eea;
          color: white;
        }

        .modal-btn-accept:hover {
          background: #5a67d8;
        }

        .modal-btn-decline {
          background: #f3f4f6;
          color: #374151;
        }

        .modal-btn-decline:hover {
          background: #e5e7eb;
        }

        .toggle-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 0;
          border-bottom: 1px solid #e5e7eb;
        }

        .toggle-row:last-child {
          border-bottom: none;
        }

        .toggle-info {
          flex: 1;
        }

        .toggle-label {
          font-weight: 600;
          color: #374151;
          font-size: 14px;
          margin: 0 0 4px 0;
        }

        .toggle-description {
          font-size: 13px;
          color: #6b7280;
          margin: 0;
        }

        .toggle-switch {
          position: relative;
          width: 50px;
          height: 26px;
          background: #d1d5db;
          border-radius: 13px;
          cursor: pointer;
          transition: background 0.2s;
          flex-shrink: 0;
          margin-left: 16px;
        }

        .toggle-switch.checked {
          background: #667eea;
        }

        .toggle-switch.disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .toggle-slider {
          position: absolute;
          top: 3px;
          left: 3px;
          width: 20px;
          height: 20px;
          background: white;
          border-radius: 50%;
          transition: transform 0.2s;
          box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        }

        .toggle-switch.checked .toggle-slider {
          transform: translateX(24px);
        }

        .section-title {
          font-size: 16px;
          font-weight: 600;
          color: #374151;
          margin: 24px 0 8px 0;
          padding-bottom: 8px;
          border-bottom: 2px solid #667eea;
        }
      `}</style>

      <div className="container">
        <header>
          <h1><Settings size={24} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 8 }} />{t('title')}</h1>
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
                <option value="he">עברית (Hebrew)</option>
                <option value="en">English</option>
                <option value="ru">Русский (Russian)</option>
              </select>
              <p className="help-text">{t('languageHelp')}</p>
            </div>

            <div className="form-group">
              <label htmlFor="location">{t('personal.location')}</label>
              <div className="location-row">
                <input
                  type="text"
                  name="location"
                  id="location"
                  value={location}
                  onChange={(e) => {
                    setLocation(e.target.value);
                    setLocationError(null); // Clear error on change
                  }}
                  onBlur={handleLocationBlur}
                  placeholder={t('personal.locationPlaceholder')}
                  disabled={formState !== 'idle' || locationLoading}
                  className={locationError ? 'input-error' : ''}
                />
                <button
                  type="button"
                  className="location-btn"
                  onClick={handleGetLocation}
                  disabled={formState !== 'idle' || locationLoading}
                  title={t('useCurrentLocation')}
                >
                  {locationLoading ? (
                    <Loader2 size={20} className="spinning" />
                  ) : (
                    <MapPin size={20} />
                  )}
                </button>
              </div>
              {locationValidating && (
                <p className="validating-text">
                  <Loader2 size={14} className="spinning" style={{ display: 'inline', marginRight: 4 }} />
                  {t('locationValidating')}
                </p>
              )}
              {locationError && <p className="error-text">{locationError}</p>}
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

            <div className="form-group">
              <label htmlFor="culture">{t('cultureLabel')}</label>
              <select
                name="culture"
                id="culture"
                value={culture}
                onChange={(e) => setCulture(e.target.value)}
                disabled={formState !== 'idle'}
              >
                <option value="default">{t('cultureDefault')}</option>
                <option value="jewish">{t('cultureJewish')}</option>
              </select>
              <p className="help-text">{t('cultureHelp')}</p>
            </div>

            <h3 className="section-title">{t('summaryPreferences')}</h3>

            <div className="toggle-row">
              <div className="toggle-info">
                <p className="toggle-label">{t('textSummary')}</p>
                <p className="toggle-description">{t('textSummaryDescription')}</p>
              </div>
              <div
                className={`toggle-switch ${textSummaryEnabled ? 'checked' : ''} ${formState !== 'idle' ? 'disabled' : ''}`}
                onClick={() => formState === 'idle' && setTextSummaryEnabled(!textSummaryEnabled)}
                role="switch"
                aria-checked={textSummaryEnabled}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    formState === 'idle' && setTextSummaryEnabled(!textSummaryEnabled);
                  }
                }}
              >
                <div className="toggle-slider" />
              </div>
            </div>

            <div className="toggle-row">
              <div className="toggle-info">
                <p className="toggle-label">{t('voiceSummary')}</p>
                <p className="toggle-description">{t('voiceSummaryDescription')}</p>
              </div>
              <div
                className={`toggle-switch ${voiceSummaryEnabled ? 'checked' : ''} ${formState !== 'idle' ? 'disabled' : ''}`}
                onClick={() => formState === 'idle' && setVoiceSummaryEnabled(!voiceSummaryEnabled)}
                role="switch"
                aria-checked={voiceSummaryEnabled}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    formState === 'idle' && setVoiceSummaryEnabled(!voiceSummaryEnabled);
                  }
                }}
              >
                <div className="toggle-slider" />
              </div>
            </div>

            <div className="toggle-row">
              <div className="toggle-info">
                <p className="toggle-label">{t('weatherSummary')}</p>
                <p className="toggle-description">{t('weatherSummaryDescription')}</p>
              </div>
              <div
                className={`toggle-switch ${weatherEnabled ? 'checked' : ''} ${formState !== 'idle' ? 'disabled' : ''}`}
                onClick={() => formState === 'idle' && setWeatherEnabled(!weatherEnabled)}
                role="switch"
                aria-checked={weatherEnabled}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    formState === 'idle' && setWeatherEnabled(!weatherEnabled);
                  }
                }}
              >
                <div className="toggle-slider" />
              </div>
            </div>

            <div className="toggle-row">
              <div className="toggle-info">
                <p className="toggle-label">{t('weekLookahead')}</p>
                <p className="toggle-description">{t('weekLookaheadDescription')}</p>
              </div>
              <div
                className={`toggle-switch ${includeLookaheadInTomorrow ? 'checked' : ''} ${formState !== 'idle' ? 'disabled' : ''}`}
                onClick={() => formState === 'idle' && setIncludeLookaheadInTomorrow(!includeLookaheadInTomorrow)}
                role="switch"
                aria-checked={includeLookaheadInTomorrow}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    formState === 'idle' && setIncludeLookaheadInTomorrow(!includeLookaheadInTomorrow);
                  }
                }}
              >
                <div className="toggle-slider" />
              </div>
            </div>

            <button
              type="submit"
              className={`btn ${formState === 'error' ? 'btn-error' : ''}`}
              disabled={formState !== 'idle' || locationValidating || !!locationError}
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

      {/* Location confirmation modal */}
      {detectedLocation && (
        <div className="modal-overlay" onClick={handleDeclineLocation}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-icon">
              <MapPin size={48} />
            </div>
            <h2 className="modal-title">{t('locationDetected')}</h2>
            <p className="modal-location">{detectedLocation}</p>
            <div className="modal-buttons">
              <button
                type="button"
                className="modal-btn modal-btn-decline"
                onClick={handleDeclineLocation}
              >
                {t('locationDecline')}
              </button>
              <button
                type="button"
                className="modal-btn modal-btn-accept"
                onClick={handleAcceptLocation}
              >
                {t('locationAccept')}
              </button>
            </div>
          </div>
        </div>
      )}
    </TelegramLayout>
  );
}

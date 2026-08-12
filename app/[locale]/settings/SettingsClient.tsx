'use client';

import { useEffect, useState, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { TelegramLayout } from '@/components/Layout';
import { CheckCircle2, Settings, MapPin, Loader2, ArrowLeft, Check } from 'lucide-react';
import { VOICE_OPTIONS, VOICE_STYLES } from '@/src/config/voice-options';

interface SubscriptionInfo {
  effectivePlan: string;
  textSummariesUsed: number;
  textSummariesLimit: number; // -1 means unlimited
  voiceSummariesUsed: number;
  voiceSummariesLimit: number; // -1 means unlimited
  remindersAllowed: boolean;
  isTrialing: boolean;
}

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
    lookaheadAlways7Days: boolean;
    preferredMorningHour: number;
    preferredEveningHour: number;
    dailySummaryDays: number[];
    tomorrowSummaryDays: number[];
    remindersEnabled: boolean;
    defaultReminderMinutes: number | null;
    pickupRemindersEnabled: boolean;
    voiceInputEnabled: boolean;
    voicePreference: string;
    voiceStyle: string;
  };
  remindersGloballyEnabled: boolean;
  subscriptionInfo: SubscriptionInfo;
}

type FormState = 'idle' | 'saving' | 'success' | 'error';

export default function SettingsClient({ userId, currentSettings, remindersGloballyEnabled, subscriptionInfo }: SettingsClientProps) {
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
  const [lookaheadAlways7Days, setLookaheadAlways7Days] = useState(currentSettings.lookaheadAlways7Days);
  const [preferredMorningHour, setPreferredMorningHour] = useState(currentSettings.preferredMorningHour);
  const [preferredEveningHour, setPreferredEveningHour] = useState(currentSettings.preferredEveningHour);
  const [dailySummaryDays, setDailySummaryDays] = useState<number[]>(currentSettings.dailySummaryDays);
  const [tomorrowSummaryDays, setTomorrowSummaryDays] = useState<number[]>(currentSettings.tomorrowSummaryDays);
  const [remindersEnabled, setRemindersEnabled] = useState(currentSettings.remindersEnabled);
  const [defaultReminderMinutes, setDefaultReminderMinutes] = useState(currentSettings.defaultReminderMinutes ?? 15);
  const [pickupRemindersEnabled, setPickupRemindersEnabled] = useState(currentSettings.pickupRemindersEnabled);
  const [voiceInputEnabled, setVoiceInputEnabled] = useState(currentSettings.voiceInputEnabled);
  const [voicePreference, setVoicePreference] = useState(currentSettings.voicePreference);
  const [voiceStyle, setVoiceStyle] = useState(currentSettings.voiceStyle);
  const [locationLoading, setLocationLoading] = useState(false);
  const [detectedLocation, setDetectedLocation] = useState<string | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [locationValidating, setLocationValidating] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const isDirty =
    language !== currentSettings.language ||
    location !== currentSettings.location ||
    messagingPlatform !== currentSettings.messagingPlatform ||
    culture !== currentSettings.culture ||
    textSummaryEnabled !== currentSettings.textSummaryEnabled ||
    voiceSummaryEnabled !== currentSettings.voiceSummaryEnabled ||
    weatherEnabled !== currentSettings.weatherEnabled ||
    includeLookaheadInTomorrow !== currentSettings.includeLookaheadInTomorrow ||
    lookaheadAlways7Days !== currentSettings.lookaheadAlways7Days ||
    preferredMorningHour !== currentSettings.preferredMorningHour ||
    preferredEveningHour !== currentSettings.preferredEveningHour ||
    JSON.stringify([...dailySummaryDays].sort()) !== JSON.stringify([...currentSettings.dailySummaryDays].sort()) ||
    JSON.stringify([...tomorrowSummaryDays].sort()) !== JSON.stringify([...currentSettings.tomorrowSummaryDays].sort()) ||
    remindersEnabled !== currentSettings.remindersEnabled ||
    defaultReminderMinutes !== (currentSettings.defaultReminderMinutes ?? 15) ||
    pickupRemindersEnabled !== currentSettings.pickupRemindersEnabled ||
    voiceInputEnabled !== currentSettings.voiceInputEnabled ||
    voicePreference !== currentSettings.voicePreference ||
    voiceStyle !== currentSettings.voiceStyle;

  // Granularity accepted for weather: anything from a country down to a suburb.
  // Nominatim's place_rank is the reliable dial here (country 4, state 8,
  // state_district 10, city 16, suburb 19, road 26, building 30) — addresstype is an
  // open-ended vocabulary, so an allowlist of it alone always leaves gaps.
  const MAX_LOCATION_PLACE_RANK = 20;

  // Kept as an extra accept-path for named types that rank below the cutoff.
  const VALID_LOCATION_TYPES = [
    'city', 'town', 'village', 'municipality', 'county', 'state', 'state_district',
    'country', 'suburb', 'hamlet', 'locality', 'region', 'province',
    'district', 'neighbourhood', 'borough', 'quarter'
  ];

  // Build a city-level name from a Nominatim `address` object. Shared by the
  // geolocation button and by save-time normalization so both store the same shape.
  const buildPlaceName = (addr: Record<string, string> | undefined): string => {
    const place =
      addr?.city || addr?.town || addr?.village || addr?.municipality ||
      addr?.county || addr?.state_district || addr?.state;
    const country = addr?.country;
    if (place && country) return `${place}, ${country}`;
    return place || '';
  };

  // Validate a location, and collapse over-specific matches to the city containing
  // them. Returns the value that should actually be stored — callers must use it
  // rather than the `location` state, which React has not updated yet.
  const validateLocation = async (loc: string): Promise<{ valid: boolean; normalized: string }> => {
    const trimmed = loc.trim();

    if (!trimmed) {
      setLocationError(null);
      return { valid: true, normalized: '' }; // Empty is allowed
    }

    setLocationValidating(true);
    setLocationError(null);

    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(trimmed)}&format=json&limit=1&addressdetails=1`,
        {
          headers: {
            'User-Agent': 'FamCalBot/1.0',
            // Match the reverse-geocode call: names we may store must come back in
            // English, or a collapsed address lands in the DB in the local script.
            'Accept-Language': 'en'
          }
        }
      );

      if (!response.ok) {
        setLocationError(t('locationValidationError'));
        return { valid: false, normalized: trimmed };
      }

      const data = await response.json();

      if (Array.isArray(data) && data.length > 0) {
        const result = data[0];
        setLocationError(null);

        // Anything geocodeLocation() can resolve is acceptable — this gate must never
        // be stricter than the weather pipeline that consumes the value. It decides
        // only whether to keep the string as typed. Deliberately not keyed on
        // `importance`: that measures fame, not granularity, so it would let a
        // well-known building ("1600 Pennsylvania Ave NW") through uncollapsed.
        const isCityLevel =
          result.place_rank <= MAX_LOCATION_PLACE_RANK ||
          VALID_LOCATION_TYPES.includes(result.addresstype);

        if (isCityLevel) {
          return { valid: true, normalized: trimmed };
        }

        // Over-specific match (a street address or a single building): keep it, but
        // store the city that contains it. Weather is grid-based, so the precision
        // buys nothing, and there is no reason to persist a house number.
        const collapsed = buildPlaceName(result.address);
        return { valid: true, normalized: collapsed || trimmed };
      } else {
        setLocationError(t('locationInvalid'));
        return { valid: false, normalized: trimmed };
      }
    } catch (error) {
      setLocationError(t('locationValidationError'));
      return { valid: false, normalized: trimmed };
    } finally {
      setLocationValidating(false);
    }
  };

  // Validate on blur, showing the user the value that will actually be saved
  const handleLocationBlur = async () => {
    if (!location.trim()) return;

    const { valid, normalized } = await validateLocation(location);
    if (valid && normalized && normalized !== location) {
      setLocation(normalized);
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
      // zoom controls the *bottom* of the returned hierarchy, so a higher zoom only
      // ever adds narrower fields to `address`. zoom=14 is deep enough that city/town
      // is populated even in sparsely mapped areas (zoom=10 stops at the subdistrict
      // and omits it entirely), while staying above road level, where `name` ignores
      // accept-language, and building level, where `name` is often empty.
      // English output keeps the result forward-geocodable.
      const response = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json&zoom=14&accept-language=en`
      );
      const data = await response.json();

      // Always read `address`, never `name`/`display_name`: those hold whatever object
      // happened to match the zoom (a suburb, a road, an unnamed building), while
      // `address` reliably carries the containing city/town on upward.
      let locationString = buildPlaceName(data.address);

      if (!locationString && data.display_name) {
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

    // Validate location before saving. setLocation() below will not have taken effect
    // by the time we POST, so send the returned value rather than the state.
    let locationToSave = location;
    if (location.trim()) {
      const { valid, normalized } = await validateLocation(location);
      if (!valid) {
        return; // Don't save if location is invalid
      }
      if (normalized !== location) {
        locationToSave = normalized;
        setLocation(normalized);
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
          location: locationToSave,
          messagingPlatform,
          culture,
          textSummaryEnabled,
          voiceSummaryEnabled,
          weatherEnabled,
          includeLookaheadInTomorrow,
          lookaheadAlways7Days,
          preferredMorningHour,
          preferredEveningHour,
          dailySummaryDays,
          tomorrowSummaryDays,
          remindersEnabled,
          defaultReminderMinutes: remindersEnabled ? defaultReminderMinutes : null,
          pickupRemindersEnabled,
          voiceInputEnabled,
          voicePreference,
          voiceStyle,
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

        .settings-header {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 16px 20px;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .settings-header h1 {
          font-size: 20px;
          font-weight: 600;
          margin: 0;
        }

        .header-action-btn {
          width: 40px;
          height: 40px;
          border-radius: 50%;
          border: none;
          background: rgba(255, 255, 255, 0.2);
          color: white;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.2s;
        }

        .header-action-btn:hover:not(:disabled) {
          background: rgba(255, 255, 255, 0.3);
        }

        .header-action-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .header-action-btn.dirty {
          background: white;
          color: #764ba2;
        }

        .header-action-btn.dirty:hover:not(:disabled) {
          background: rgba(255, 255, 255, 0.9);
        }

        .header-action-btn.muted {
          opacity: 0.5;
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

        .usage-badge {
          display: inline-block;
          font-size: 12px;
          color: #6b7280;
          background: #f3f4f6;
          padding: 2px 8px;
          border-radius: 10px;
          margin-top: 4px;
        }

        .usage-badge span[dir="ltr"] {
          unicode-bidi: embed;
        }

        .pro-badge {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          color: #9333ea;
          margin-top: 4px;
        }

        .pro-badge a {
          color: #667eea;
          text-decoration: underline;
          cursor: pointer;
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

        .day-picker {
          display: flex;
          gap: 6px;
          margin-top: 8px;
          justify-content: space-between;
        }

        .day-btn {
          width: 40px;
          height: 40px;
          border-radius: 50%;
          border: 2px solid #e5e7eb;
          background: white;
          color: #6b7280;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          -webkit-tap-highlight-color: transparent;
        }

        .day-btn.active {
          background: #667eea;
          border-color: #667eea;
          color: white;
        }

        .day-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
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
        <div className="settings-header">
          <button
            type="button"
            className={`header-action-btn${isDirty ? ' muted' : ''}`}
            onClick={handleCancel}
            disabled={formState === 'saving'}
          >
            <ArrowLeft size={20} />
          </button>
          <h1>{t('title')}</h1>
          <button
            type="button"
            className={`header-action-btn${isDirty ? ' dirty' : ''}`}
            onClick={() => formRef.current?.requestSubmit()}
            disabled={formState !== 'idle' || locationValidating || !!locationError}
          >
            {formState === 'saving' ? <Loader2 size={20} className="spinning" /> : <Check size={20} />}
          </button>
        </div>

        <div className="content">
          <form ref={formRef} onSubmit={handleSubmit}>
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
                onChange={(e) => {
                  const newCulture = e.target.value;
                  setCulture(newCulture);
                  if (newCulture === 'jewish') {
                    setDailySummaryDays([0, 1, 2, 3, 4, 5]);
                    setTomorrowSummaryDays([0, 1, 2, 3, 4, 6]);
                  } else {
                    setDailySummaryDays([0, 1, 2, 3, 4, 5, 6]);
                    setTomorrowSummaryDays([0, 1, 2, 3, 4, 5, 6]);
                  }
                }}
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
                {subscriptionInfo.textSummariesLimit > 0 && (
                  <div className="usage-badge">
                    <span dir="ltr">{subscriptionInfo.textSummariesUsed} / {subscriptionInfo.textSummariesLimit}</span>{' '}
                    {t('usageCounterSuffix')}
                  </div>
                )}
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
                {subscriptionInfo.voiceSummariesLimit > 0 && (
                  <div className="usage-badge">
                    <span dir="ltr">{subscriptionInfo.voiceSummariesUsed} / {subscriptionInfo.voiceSummariesLimit}</span>{' '}
                    {t('usageCounterSuffix')}
                  </div>
                )}
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

            {voiceSummaryEnabled && (<>
              <div className="form-group" style={{ marginTop: '4px', marginBottom: '16px' }}>
                <label htmlFor="voicePreference">{t('voicePreference')}</label>
                <select
                  name="voicePreference"
                  id="voicePreference"
                  value={voicePreference}
                  onChange={(e) => setVoicePreference(e.target.value)}
                  disabled={formState !== 'idle'}
                >
                  {(VOICE_OPTIONS[language] || VOICE_OPTIONS['en']).map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <p className="help-text">{t('voicePreferenceDescription')}</p>
              </div>

              <div className="form-group" style={{ marginTop: '4px', marginBottom: '16px' }}>
                <label htmlFor="voiceStyle">{t('voiceStyle')}</label>
                <select
                  name="voiceStyle"
                  id="voiceStyle"
                  value={voiceStyle}
                  onChange={(e) => setVoiceStyle(e.target.value)}
                  disabled={formState !== 'idle'}
                >
                  {VOICE_STYLES.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label[language as keyof typeof opt.label] || opt.label.en}
                    </option>
                  ))}
                </select>
                <p className="help-text">{t('voiceStyleDescription')}</p>
              </div>
            </>)}

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

            <div className="toggle-row">
              <div className="toggle-info">
                <p className="toggle-label">{t('lookaheadAlways7Days')}</p>
                <p className="toggle-description">{t('lookaheadAlways7DaysDescription')}</p>
              </div>
              <div
                className={`toggle-switch ${lookaheadAlways7Days ? 'checked' : ''} ${formState !== 'idle' ? 'disabled' : ''}`}
                onClick={() => formState === 'idle' && setLookaheadAlways7Days(!lookaheadAlways7Days)}
                role="switch"
                aria-checked={lookaheadAlways7Days}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    formState === 'idle' && setLookaheadAlways7Days(!lookaheadAlways7Days);
                  }
                }}
              >
                <div className="toggle-slider" />
              </div>
            </div>

            <div className="toggle-row">
              <div className="toggle-info">
                <p className="toggle-label">{t('voiceInput')}</p>
                <p className="toggle-description">{t('voiceInputDescription')}</p>
              </div>
              <div
                className={`toggle-switch ${voiceInputEnabled ? 'checked' : ''} ${formState !== 'idle' ? 'disabled' : ''}`}
                onClick={() => formState === 'idle' && setVoiceInputEnabled(!voiceInputEnabled)}
                role="switch"
                aria-checked={voiceInputEnabled}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    formState === 'idle' && setVoiceInputEnabled(!voiceInputEnabled);
                  }
                }}
              >
                <div className="toggle-slider" />
              </div>
            </div>

            <h3 className="section-title">{t('summaryDeliveryTime')}</h3>

            <div className="form-group" style={{ marginTop: '16px' }}>
              <label htmlFor="preferredMorningHour">{t('morningHour')}</label>
              <select
                name="preferredMorningHour"
                id="preferredMorningHour"
                value={preferredMorningHour}
                onChange={(e) => setPreferredMorningHour(parseInt(e.target.value))}
                disabled={formState !== 'idle'}
              >
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{String(i).padStart(2, '0')}{t('hourSuffix')}</option>
                ))}
              </select>
              <p className="help-text">{t('morningHourDescription')}</p>
              <div className="day-picker">
                {[0, 1, 2, 3, 4, 5, 6].map(day => (
                  <button
                    key={day}
                    type="button"
                    className={`day-btn ${dailySummaryDays.includes(day) ? 'active' : ''}`}
                    onClick={() => {
                      if (formState !== 'idle') return;
                      if (dailySummaryDays.includes(day)) {
                        if (dailySummaryDays.length <= 1) return;
                        setDailySummaryDays(dailySummaryDays.filter(d => d !== day));
                      } else {
                        setDailySummaryDays([...dailySummaryDays, day].sort());
                      }
                    }}
                    disabled={formState !== 'idle'}
                    aria-pressed={dailySummaryDays.includes(day)}
                  >
                    {t(`days.d${day}`)}
                  </button>
                ))}
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="preferredEveningHour">{t('eveningHour')}</label>
              <select
                name="preferredEveningHour"
                id="preferredEveningHour"
                value={preferredEveningHour}
                onChange={(e) => setPreferredEveningHour(parseInt(e.target.value))}
                disabled={formState !== 'idle'}
              >
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{String(i).padStart(2, '0')}{t('hourSuffix')}</option>
                ))}
              </select>
              <p className="help-text">{t('eveningHourDescription')}</p>
              <div className="day-picker">
                {[0, 1, 2, 3, 4, 5, 6].map(day => (
                  <button
                    key={day}
                    type="button"
                    className={`day-btn ${tomorrowSummaryDays.includes(day) ? 'active' : ''}`}
                    onClick={() => {
                      if (formState !== 'idle') return;
                      if (tomorrowSummaryDays.includes(day)) {
                        if (tomorrowSummaryDays.length <= 1) return;
                        setTomorrowSummaryDays(tomorrowSummaryDays.filter(d => d !== day));
                      } else {
                        setTomorrowSummaryDays([...tomorrowSummaryDays, day].sort());
                      }
                    }}
                    disabled={formState !== 'idle'}
                    aria-pressed={tomorrowSummaryDays.includes(day)}
                  >
                    {t(`days.d${day}`)}
                  </button>
                ))}
              </div>
            </div>

            {currentSettings.messagingPlatform !== 'whatsapp' && (<>
            <h3 className="section-title">{t('remindersSection')}</h3>

            <div className="toggle-row">
              <div className="toggle-info">
                <p className="toggle-label">{t('remindersEnabled')}</p>
                <p className="toggle-description">
                  {!remindersGloballyEnabled
                    ? t('remindersBetaDescription')
                    : !subscriptionInfo.remindersAllowed
                      ? t('remindersEnabledDescription')
                      : t('remindersEnabledDescription')
                  }
                </p>
                {remindersGloballyEnabled && !subscriptionInfo.remindersAllowed && (
                  <div className="pro-badge">
                    <span>{t('remindersProRequired')}</span>
                    <a href={`/${currentSettings.language}/subscription?user_id=${userId}`}>{t('upgradeLink')}</a>
                  </div>
                )}
              </div>
              <div
                className={`toggle-switch ${remindersEnabled && remindersGloballyEnabled && subscriptionInfo.remindersAllowed ? 'checked' : ''} ${formState !== 'idle' || !remindersGloballyEnabled || !subscriptionInfo.remindersAllowed ? 'disabled' : ''}`}
                onClick={() => formState === 'idle' && remindersGloballyEnabled && subscriptionInfo.remindersAllowed && setRemindersEnabled(!remindersEnabled)}
                role="switch"
                aria-checked={remindersEnabled && remindersGloballyEnabled && subscriptionInfo.remindersAllowed}
                tabIndex={remindersGloballyEnabled && subscriptionInfo.remindersAllowed ? 0 : -1}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && remindersGloballyEnabled && subscriptionInfo.remindersAllowed) {
                    e.preventDefault();
                    formState === 'idle' && setRemindersEnabled(!remindersEnabled);
                  }
                }}
              >
                <div className="toggle-slider" />
              </div>
            </div>

            {remindersEnabled && remindersGloballyEnabled && subscriptionInfo.remindersAllowed && (
              <>
                <div className="form-group" style={{ marginTop: '16px' }}>
                  <label htmlFor="defaultReminderMinutes">{t('defaultReminderMinutes')}</label>
                  <select
                    name="defaultReminderMinutes"
                    id="defaultReminderMinutes"
                    value={defaultReminderMinutes}
                    onChange={(e) => setDefaultReminderMinutes(parseInt(e.target.value))}
                    disabled={formState !== 'idle'}
                  >
                    <option value="5">5 {t('minutes')}</option>
                    <option value="10">10 {t('minutes')}</option>
                    <option value="15">15 {t('minutes')}</option>
                    <option value="30">30 {t('minutes')}</option>
                    <option value="60">60 {t('minutes')}</option>
                  </select>
                  <p className="help-text">{t('defaultReminderMinutesHelp')}</p>
                </div>

                <div className="toggle-row">
                  <div className="toggle-info">
                    <p className="toggle-label">{t('pickupRemindersEnabled')}</p>
                    <p className="toggle-description">{t('pickupRemindersDescription')}</p>
                  </div>
                  <div
                    className={`toggle-switch ${pickupRemindersEnabled ? 'checked' : ''} ${formState !== 'idle' ? 'disabled' : ''}`}
                    onClick={() => formState === 'idle' && setPickupRemindersEnabled(!pickupRemindersEnabled)}
                    role="switch"
                    aria-checked={pickupRemindersEnabled}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        formState === 'idle' && setPickupRemindersEnabled(!pickupRemindersEnabled);
                      }
                    }}
                  >
                    <div className="toggle-slider" />
                  </div>
                </div>
              </>
            )}
            </>)}

          </form>

          <p style={{
            textAlign: 'center',
            fontSize: '12px',
            color: '#9ca3af',
            marginTop: '16px',
            padding: '0 16px',
          }}>
            🔒 {t('privacyNote')}
          </p>
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

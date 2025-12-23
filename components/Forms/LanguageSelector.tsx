interface LanguageSelectorProps {
  value: string;
  onChange: (language: string) => void;
  disabled?: boolean;
}

/**
 * LanguageSelector Component
 * Dropdown for selecting user language
 */
export default function LanguageSelector({
  value,
  onChange,
  disabled = false,
}: LanguageSelectorProps) {
  const languages = [
    { code: 'en', name: 'English', flag: '🇬🇧' },
    { code: 'he', name: 'עברית', flag: '🇮🇱' },
  ];

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="language-selector"
    >
      <style jsx>{`
        .language-selector {
          width: 100%;
          padding: 12px 16px;
          font-size: 16px;
          border: 2px solid #e5e7eb;
          border-radius: 8px;
          background: white;
          cursor: pointer;
          transition: border-color 0.2s;
        }

        .language-selector:focus {
          outline: none;
          border-color: #667eea;
        }

        .language-selector:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .language-selector option {
          padding: 8px;
        }
      `}</style>

      {languages.map((lang) => (
        <option key={lang.code} value={lang.code}>
          {lang.flag} {lang.name}
        </option>
      ))}
    </select>
  );
}

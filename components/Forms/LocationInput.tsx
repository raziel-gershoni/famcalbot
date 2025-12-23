interface LocationInputProps {
  value: string;
  onChange: (location: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * LocationInput Component
 * Input field for entering user location
 */
export default function LocationInput({
  value,
  onChange,
  disabled = false,
  placeholder = 'Enter your location (e.g., Tel Aviv)',
}: LocationInputProps) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      placeholder={placeholder}
      className="location-input"
    />
  );
}

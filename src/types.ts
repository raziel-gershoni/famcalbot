export interface UserConfig {
  telegramId: number;
  whatsappPhone?: string;  // WhatsApp phone number in E.164 format (e.g., "+972501234567")
  messagingPlatform?: 'telegram' | 'whatsapp' | 'all';  // Where to send automated messages (default: telegram)
  name: string;
  hebrewName: string;  // User's name in Hebrew for accurate Claude output
  gender: 'male' | 'female';  // User's gender for Hebrew grammar
  spouseName: string;  // Spouse's name for personalization
  spouseHebrewName: string;  // Spouse's name in Hebrew
  spouseGender: 'male' | 'female';  // Spouse's gender for Hebrew grammar
  location: string;  // User's location for weather (e.g., "Harish, Israel")
  language?: string;  // User's preferred language for weather reports (e.g., "Hebrew", "English"). If not set, weather will be in English.
  calendars: string[];  // Google Calendar IDs to fetch events from
  googleRefreshToken: string;
  primaryCalendar: string;  // User's main personal calendar ID
  ownCalendars: string[];  // All calendars belonging to this user (personal + work)
  spouseCalendars: string[];  // Spouse's calendar IDs
}

export interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  calendarName: string;
  calendarId: string;
}

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface WeatherData {
  location: string;  // "Harish, Israel"
  current: {
    temperature: number;
    feelsLike: number;
    humidity: number;
    weatherCode: number;
    windSpeed: number;
    uvIndex: number;
  };
  today: {
    tempMax: number;
    tempMin: number;
    precipitationProbability: number;
    weatherCode: number;
    sunrise: string;
    sunset: string;
    uvIndexMax: number;
  };
  tomorrow?: {
    tempMax: number;
    tempMin: number;
    precipitationProbability: number;
    weatherCode: number;
    sunrise: string;
    sunset: string;
    uvIndexMax: number;
  };
  hourly?: {
    time: string[];
    temperature: number[];
    precipitation_probability: number[];
    precipitation: number[];
    weatherCode: number[];
    windSpeed: number[];
  };
  daily?: Array<{
    date: string;
    tempMax: number;
    tempMin: number;
    precipitationProbability: number;
    weatherCode: number;
    sunrise: string;
    sunset: string;
    uvIndexMax: number;
  }>;
  summary?: string;  // AI-generated summary
}

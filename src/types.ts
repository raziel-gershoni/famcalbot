export interface UserConfig {
  telegramId: number;
  name: string;
  hebrewName: string;  // User's name in Hebrew for accurate Claude output
  gender: 'male' | 'female';  // User's gender for Hebrew grammar
  spouseName: string;  // Spouse's name for personalization
  spouseHebrewName: string;  // Spouse's name in Hebrew
  spouseGender: 'male' | 'female';  // Spouse's gender for Hebrew grammar
  location: string;  // User's location for weather (e.g., "Harish, Israel")
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
  };
  today: {
    tempMax: number;
    tempMin: number;
    precipitationProbability: number;
    weatherCode: number;
  };
  tomorrow?: {
    tempMax: number;
    tempMin: number;
    precipitationProbability: number;
    weatherCode: number;
  };
  hourly?: {
    time: string[];
    precipitation_probability: number[];
    precipitation: number[];
  };
  daily?: Array<{
    date: string;
    tempMax: number;
    tempMin: number;
    precipitationProbability: number;
    weatherCode: number;
  }>;
  summary?: string;  // AI-generated summary
}

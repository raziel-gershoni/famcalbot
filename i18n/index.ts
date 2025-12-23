// Re-export locales for easy importing
export const locales = ['en', 'he'] as const;
export type Locale = (typeof locales)[number];

'use client';

// The app's screen root and its theme scope (spec 2026-10-19 §4; plan F1).
//
// - AppScreen is a whole screen: the root carries .ch-app (the tokens, ./theme.ts) and
//   .ch-screen (the frame and the page paint, ./screen.ts) with data-theme, dir and lang,
//   and renders both style sheets before its children. A screen's own class (the home's
//   .ch-home) goes in `className`; its own style sheets are its first children, after the two.
// - Telegram's BackButton has one owner per screen, and it is this one: it shows exactly
//   while `onBack` is set, and a tap calls the latest `onBack`. Nothing below a screen calls
//   useTelegramBackButton. The Telegram header and background take the theme's bg_color
//   (a grouped screen, ground="grouped": its secondary_bg_color in a light theme).
// - AppScope is the zero-height scope a sheet brings into a page that is not a screen
//   (Settings' time picker): the tokens, the scheme the device is in and the page's
//   direction, with no frame, no page paint, no BackButton and no change to Telegram's colours.
// - useAppScheme() gives a part of either the scheme the root renders ('light' | 'dark').
//
// Client-safe: nothing here reaches a server module.

import { createContext, useContext, type ReactNode, type Ref } from 'react';
import { useLocale } from 'next-intl';
import { useColorScheme, useTelegramBackButton, useTelegramTheme } from '@/src/lib/telegram-ui';
import { APP_SCREEN_CSS } from './screen';
import { APP_THEME_CSS } from './theme';

type Scheme = 'light' | 'dark';

const SchemeContext = createContext<Scheme>('light');

/** The scheme of the nearest AppScreen or AppScope ('light' outside one). */
export function useAppScheme(): Scheme {
  return useContext(SchemeContext);
}

const noop = () => {};

/** The page's direction: Hebrew reads right to left. */
const dirOf = (locale: string) => (locale === 'he' ? 'rtl' : 'ltr');

export interface AppScreenProps {
  /** The screen's own class beside ch-app and ch-screen (the home's ch-home). */
  className?: string;
  /** 'grouped': cards on the secondary ground (Settings), painted and handed to Telegram's header as such. Default 'plain'. */
  ground?: 'plain' | 'grouped';
  /** The BackButton shows while this is set, and a tap calls it. Null or absent: no BackButton. */
  onBack?: (() => void) | null;
  /** The root element, for a screen that sets a custom property on it. */
  rootRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}

export function AppScreen({ className, ground = 'plain', onBack, rootRef, children }: AppScreenProps) {
  const locale = useLocale();
  const scheme = useTelegramTheme(ground);
  useTelegramBackButton(onBack != null, onBack ?? noop);
  const classes = ['ch-app', 'ch-screen', ground === 'grouped' ? 'ch-grouped' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <SchemeContext value={scheme}>
      <div ref={rootRef} className={classes} data-theme={scheme} dir={dirOf(locale)} lang={locale}>
        <style>{APP_THEME_CSS}</style>
        <style>{APP_SCREEN_CSS}</style>
        {children}
      </div>
    </SchemeContext>
  );
}

export function AppScope({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const scheme = useColorScheme();
  return (
    <SchemeContext value={scheme}>
      <div className="ch-app ch-standalone" data-theme={scheme} dir={dirOf(locale)} lang={locale}>
        <style>{APP_THEME_CSS}</style>
        {children}
      </div>
    </SchemeContext>
  );
}

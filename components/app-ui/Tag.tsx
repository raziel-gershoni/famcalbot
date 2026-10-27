'use client';

// A small tag beside a title (spec 2026-10-19 §4; W1b): "Current", "Trial", "Early access". The accent on
// its soft ground; the text comes in already translated. .ch-tag is in ./screen.ts.
//
// - A status that needs a different voice takes a tone (plan A): 'danger' is the danger colour on its soft ground
//   (Suspended), 'muted' the hint colour on the section ground (Overrides, a source). The default is the accent.
//
// Client-safe: no import beyond React.

import type { ReactNode } from 'react';

export type TagTone = 'accent' | 'danger' | 'muted';

export function Tag({ children, tone = 'accent' }: { children: ReactNode; tone?: TagTone }) {
  return <span className={tone === 'accent' ? 'ch-tag' : `ch-tag ch-tag-${tone}`}>{children}</span>;
}

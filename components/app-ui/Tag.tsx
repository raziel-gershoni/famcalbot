'use client';

// A small tag beside a title (spec 2026-10-19 §4; W1b): "Current", "Trial", "Early access". The accent on
// its soft ground; the text comes in already translated. .ch-tag is in ./screen.ts.
//
// Client-safe: no import beyond React.

import type { ReactNode } from 'react';

export function Tag({ children }: { children: ReactNode }) {
  return <span className="ch-tag">{children}</span>;
}

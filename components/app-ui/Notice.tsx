'use client';

// A notice on a card (spec 2026-10-19 §4; W1a): a line of text on the section colour, with one
// optional action under it. 'info' is a status the reader hears when it appears; 'error' is an
// alert in the danger colour; `live={false}` is static text that is there from the start (the plan
// screen's terms before paying), with no role. The text is already translated; the action's label too.
//
// Client-safe: no import beyond React.

import type { ReactNode } from 'react';

export interface NoticeProps {
  tone?: 'info' | 'error';
  /** False for static text the page opens with: no live region (an error stays an alert). */
  live?: boolean;
  children: ReactNode;
  /** One button under the text (a link to the plans). */
  action?: { label: string; onClick: () => void };
}

export function Notice({ tone = 'info', live = true, children, action }: NoticeProps) {
  return (
    <div className={tone === 'error' ? 'ch-notice ch-notice-error' : 'ch-notice'} role={tone === 'error' ? 'alert' : live ? 'status' : undefined}>
      <p className="ch-notice-text">{children}</p>
      {action ? (
        <button type="button" className="ch-notice-action" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

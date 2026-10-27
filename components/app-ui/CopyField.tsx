'use client';

// The copy-link field (W3; plan docs/superpowers/plans/2026-10-27-app-ui-W3-partner-invite.md): a read-only text field
// with the link, always left to right (a URL in a Hebrew page), and a 44 px button that copies it. Its CSS is
// FORM_CSS's (.ch-copy-field*), which the screen renders; it sits on a FormCard.
//
// - A tap writes the value to the clipboard, then says "Copied" for 2 seconds: the button's name, the check mark and a
//   status a screen reader announces (the label comes in already translated).
// - `disabled` is for a moment when the link is about to change (a request is replacing it): the button is disabled and
//   copies nothing. A screen that replaces the link gives the field a `key` of the link, so a new link starts without "Copied".
// - Where the clipboard is not there to use (an old WebView, a refusal) it never says Copied: it logs why and selects the
//   field's text, so a long press copies it. It never throws.
//
// Client-safe: no import beyond React and the icons; the labels come in already translated.

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

/** How long the button says Copied. */
const COPIED_MS = 2000;

export interface CopyFieldProps {
  /** The field's accessible name. */
  label: string;
  value: string;
  /** The button's name. */
  copyLabel: string;
  /** The button's name, and the status, for the moment after a copy. */
  copiedLabel: string;
  /** The button is disabled: nothing is copied. */
  disabled?: boolean;
}

export function CopyField({ label, value, copyLabel, copiedLabel, disabled }: CopyFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const selectText = () => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.select();
    // iOS ignores select() on its own
    el.setSelectionRange(0, el.value.length);
  };

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('navigator.clipboard is not available');
      await navigator.clipboard.writeText(value);
    } catch (error) {
      console.warn('[copy] clipboard unavailable:', error);
      selectText();
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <div className="ch-copy-field">
      <input ref={input} className="ch-copy-field-input" readOnly dir="ltr" aria-label={label} value={value} />
      <button type="button" className="ch-icon-btn ch-copy-field-btn" aria-label={copied ? copiedLabel : copyLabel} disabled={disabled} onClick={copy}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </button>
      <span className="ch-visually-hidden" role="status">
        {copied ? copiedLabel : ''}
      </span>
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { Check, CircleAlert, Copy, Download } from 'lucide-react';
import { APP_TOKENS } from '@/components/app-ui/tokens';

// The share page's two client parts (spec 2026-10-28-public-website §3.3): a Copy button (Copied, or for a moment that
// it couldn't copy), and the QR codes with their downloads. The words come in already translated. A QR code is dark on light in both themes (a scanner needs it):
// the app's light text and page colours.

/** How long the button says Copied, or that it couldn't copy. */
const COPIED_MS = 2000;
const FAILED_MS = 4000;

type CopyState = 'idle' | 'copied' | 'failed';

export function CopyButton({ text, copyLabel, copiedLabel, failedLabel }: { text: string; copyLabel: string; copiedLabel: string; failedLabel: string }) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const show = (next: CopyState, ms: number) => {
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), ms);
  };
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('navigator.clipboard is not available');
      await navigator.clipboard.writeText(text);
    } catch (error) {
      // Nothing was copied: the button says so for a moment, and the text stays on the page to select by hand
      console.warn('[share] could not copy:', error);
      show('failed', FAILED_MS);
      return;
    }
    show('copied', COPIED_MS);
  };
  const Icon = state === 'copied' ? Check : state === 'failed' ? CircleAlert : Copy;
  return (
    <button type="button" className="site-copy" onClick={copy}>
      <Icon aria-hidden="true" focusable="false" />
      <span aria-live="polite">{state === 'copied' ? copiedLabel : state === 'failed' ? failedLabel : copyLabel}</span>
    </button>
  );
}

export interface QrCode {
  label: string;
  value: string;
  filename: string;
}

export function QrCodes({ codes, downloadLabel }: { codes: QrCode[]; downloadLabel: string }) {
  const boxes = useRef<(HTMLDivElement | null)[]>([]);
  const download = (i: number, filename: string) => {
    const canvas = boxes.current[i]?.querySelector('canvas');
    if (!canvas) {
      console.warn('[share] no QR canvas to download for', filename);
      return;
    }
    const link = document.createElement('a');
    link.download = filename;
    link.href = canvas.toDataURL('image/png');
    link.click();
  };
  return (
    <ul className="site-qrs">
      {codes.map((code, i) => (
        <li key={code.filename} className="site-qr">
          <h3 className="site-qr-label">{code.label}</h3>
          <div
            className="site-qr-code"
            ref={(el) => {
              boxes.current[i] = el;
            }}
          >
            <QRCodeCanvas value={code.value} size={160} bgColor={APP_TOKENS.light.bg} fgColor={APP_TOKENS.light.text} level="H" marginSize={1} />
          </div>
          <button type="button" className="site-copy" onClick={() => download(i, code.filename)}>
            <Download aria-hidden="true" focusable="false" />
            <span>{downloadLabel}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

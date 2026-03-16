'use client';

import { useState, useRef, useCallback } from 'react';
import { QRCodeCanvas } from 'qrcode.react';

export function CopyButton({ text, copiedLabel }: { text: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="shrink-0 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white transition-all hover:bg-brand-primary-dark active:scale-95"
    >
      {copied ? copiedLabel : 'Copy'}
    </button>
  );
}

export function QRSection({
  botUrl,
  downloadLabel,
}: {
  botUrl: string;
  downloadLabel: string;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);

  const handleDownload = useCallback(() => {
    const canvas = canvasRef.current?.querySelector('canvas');
    if (!canvas) return;
    const url = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = 'famcal-qr-code.png';
    link.href = url;
    link.click();
  }, []);

  return (
    <div className="flex flex-col items-center gap-6">
      <div ref={canvasRef} className="rounded-2xl bg-white p-6 shadow-lg">
        <QRCodeCanvas
          value={botUrl}
          size={220}
          bgColor="#ffffff"
          fgColor="#1a1a2e"
          level="H"
          marginSize={1}
        />
      </div>
      <button
        onClick={handleDownload}
        className="rounded-lg bg-brand-primary px-6 py-3 text-sm font-semibold text-white transition-all hover:bg-brand-primary-dark active:scale-95"
      >
        {downloadLabel}
      </button>
    </div>
  );
}

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
  waUrl,
  siteUrl,
  downloadLabel,
  labelTelegram,
  labelWhatsapp,
  labelWebsite,
}: {
  botUrl: string;
  waUrl: string;
  siteUrl: string;
  downloadLabel: string;
  labelTelegram: string;
  labelWhatsapp: string;
  labelWebsite: string;
}) {
  const telegramRef = useRef<HTMLDivElement>(null);
  const whatsappRef = useRef<HTMLDivElement>(null);
  const websiteRef = useRef<HTMLDivElement>(null);

  const handleDownload = useCallback((ref: React.RefObject<HTMLDivElement | null>, filename: string) => {
    const canvas = ref.current?.querySelector('canvas');
    if (!canvas) return;
    const url = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = filename;
    link.href = url;
    link.click();
  }, []);

  const qrCodes = [
    { label: labelTelegram, value: botUrl, ref: telegramRef, filename: 'famcal-qr-telegram.png' },
    { label: labelWhatsapp, value: waUrl, ref: whatsappRef, filename: 'famcal-qr-whatsapp.png' },
    { label: labelWebsite, value: siteUrl, ref: websiteRef, filename: 'famcal-qr-website.png' },
  ];

  return (
    <div className="grid grid-cols-1 gap-8 sm:grid-cols-3">
      {qrCodes.map(({ label, value, ref, filename }) => (
        <div key={label} className="flex flex-col items-center gap-4">
          <span className="text-sm font-semibold text-text-primary">{label}</span>
          <div ref={ref} className="rounded-2xl bg-white p-4 shadow-lg">
            <QRCodeCanvas
              value={value}
              size={160}
              bgColor="#ffffff"
              fgColor="#1a1a2e"
              level="H"
              marginSize={1}
            />
          </div>
          <button
            onClick={() => handleDownload(ref, filename)}
            className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-brand-primary-dark active:scale-95"
          >
            {downloadLabel}
          </button>
        </div>
      ))}
    </div>
  );
}

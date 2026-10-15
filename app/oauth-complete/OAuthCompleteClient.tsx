'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import { CheckCircle2, ArrowRight } from 'lucide-react';

interface Translations {
  title: string;
  subtitle: string;
  /** {name} is the owner's first name */
  owner: string;
  ownerUnnamed: string;
  telegramButton: string;
  whatsappButton: string;
  /** The prefilled WhatsApp message; {code} is gc_<pendingId> */
  whatsappText: string;
  /** Under the WhatsApp button: nothing is connected until that message is sent */
  whatsappHint: string;
  incompleteTitle: string;
  incompleteBody: string;
}

interface OAuthCompleteClientProps {
  locale: string;
  botUsername: string;
  waNumber: string;
  translations: Translations;
}

/** What the OAuth callback put in the fragment: #p=<pendingId>&n=<first name>&b=tg,wa */
export interface FinishParams {
  pendingId: string;
  ownerName: string;
  telegram: boolean;
  whatsapp: boolean;
}

const PENDING_ID = /^[A-Za-z0-9_-]{32}$/;

export function parseFinishFragment(hash: string): FinishParams | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const pendingId = params.get('p') ?? '';
  if (!PENDING_ID.test(pendingId)) return null;
  const buttons = (params.get('b') ?? '').split(',');
  return { pendingId, ownerName: params.get('n') ?? '', telegram: buttons.includes('tg'), whatsapp: buttons.includes('wa') };
}

/**
 * The claim links: the bot's /start gc_<id>, and a WhatsApp message that contains gc_<id>.
 * A button shows only when the owner has that channel and it is configured.
 */
export function finishLinks(
  params: FinishParams,
  botUsername: string,
  waNumber: string,
  waText: string,
): { telegram?: string; whatsapp?: string } {
  const code = `gc_${params.pendingId}`;
  return {
    ...(params.telegram && botUsername ? { telegram: `https://t.me/${botUsername}?start=${code}` } : {}),
    ...(params.whatsapp && waNumber
      ? { whatsapp: `https://wa.me/${waNumber}?text=${encodeURIComponent(waText.replace('{code}', code))}` }
      : {}),
  };
}

/** The claim buttons. WhatsApp only prefills the message, so its button says to send it. */
export function FinishButtons({ links, translations: t, arrow }: {
  links: { telegram?: string; whatsapp?: string };
  translations: Translations;
  arrow: ReactNode;
}) {
  return (
    <>
      {links.telegram && (
        <a href={links.telegram} className="btn">
          {t.telegramButton}
          {arrow}
        </a>
      )}
      {links.whatsapp && (
        <>
          <a href={links.whatsapp} className="btn">
            {t.whatsappButton}
            {arrow}
          </a>
          <p className="hint">{t.whatsappHint}</p>
        </>
      )}
    </>
  );
}

const subscribeToHash = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};

export default function OAuthCompleteClient({ locale, botUsername, waNumber, translations: t }: OAuthCompleteClientProps) {
  const isRTL = locale === 'he';
  // The fragment exists only in the browser; the server render has none (null)
  const hash = useSyncExternalStore(subscribeToHash, () => window.location.hash, () => null);
  const params = hash === null ? null : parseFinishFragment(hash);
  const links = params ? finishLinks(params, botUsername, waNumber, t.whatsappText) : {};
  const incomplete = hash !== null && !links.telegram && !links.whatsapp;
  const arrow = <ArrowRight size={20} style={isRTL ? { transform: 'scaleX(-1)' } : undefined} />;

  return (
    <html lang={locale} dir={isRTL ? 'rtl' : 'ltr'}>
      <head>
        <title>{t.title}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>{`
          * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
          }
          body {
            font-family: 'Rubik', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }
          .container {
            background: white;
            padding: 50px 40px;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 450px;
            text-align: center;
            animation: slideUp 0.5s ease-out;
          }
          @keyframes slideUp {
            from {
              opacity: 0;
              transform: translateY(30px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
          .success-icon {
            width: 80px;
            height: 80px;
            margin: 0 auto 30px;
            background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            animation: scaleIn 0.6s ease-out 0.2s both;
          }
          @keyframes scaleIn {
            from {
              transform: scale(0);
            }
            to {
              transform: scale(1);
            }
          }
          h1 {
            color: #1f2937;
            font-size: 28px;
            font-weight: 600;
            margin-bottom: 15px;
          }
          .subtitle {
            color: #6b7280;
            font-size: 16px;
            margin-bottom: 30px;
            line-height: 1.6;
          }
          .btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            width: 100%;
            padding: 16px 24px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-decoration: none;
            border: none;
            border-radius: 12px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
          }
          .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 16px rgba(102, 126, 234, 0.5);
          }
          .btn:active {
            transform: translateY(0);
          }
          .btn + .btn {
            margin-top: 12px;
          }
          .hint {
            color: #6b7280;
            font-size: 14px;
            margin-top: 10px;
            line-height: 1.5;
          }
          .owner {
            color: #374151;
            font-size: 15px;
            margin-bottom: 30px;
            line-height: 1.6;
          }
        `}</style>
      </head>
      <body>
        <div className="container">
          {incomplete ? (
            <>
              <h1>{t.incompleteTitle}</h1>
              <p className="subtitle">{t.incompleteBody}</p>
            </>
          ) : params && (
            <>
              <div className="success-icon">
                <CheckCircle2 size={48} color="white" />
              </div>

              <h1>{t.title}</h1>
              <p className="subtitle">{t.subtitle}</p>
              <p className="owner">
                {params.ownerName ? t.owner.replace('{name}', () => params.ownerName) : t.ownerUnnamed}
              </p>

              <FinishButtons links={links} translations={t} arrow={arrow} />
            </>
          )}
        </div>
      </body>
    </html>
  );
}

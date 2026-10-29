import { CalendarDays, Clock, Folder, Play } from 'lucide-react';
import type { AbstractIntlMessages } from 'next-intl';
import { pickMessages } from '@/src/site/messages';
import { botWords } from '@/src/site/bot-words';
import type { SampleWeek } from '@/src/site/sample-week';
import { DemoAgenda } from './DemoAgenda';

// The hero's one moment (spec 2026-10-28-public-website §3.2.1, §5.3): a voice note becomes the bot's confirm card,
// then the event on the calendar home. Built from the app's live parts with the sample family, in the visitor's
// language and theme:
// - the voice note, as the chat shows one (decorative: its name is landing.demo.voiceNote);
// - the bot's confirm card in the bot's own words (bot.voice.*), laid out as showEventConfirmation sends it: the
//   title, the event, the date, the time (24 h), the calendar, "From:" and the transcription, then Create and
//   Cancel, then Time and Day (no Cal: the sample family has no Google calendar);
// - the calendar home's real Agenda in a phone frame (DemoAgenda), the new event marked.
// The site's style sheet plays it once (the card, the Create tap, the new row), and not at all under reduced motion.

type Translate = ((key: string, values?: Record<string, string | number>) => string) & { raw: (key: string) => unknown };

const INTL: Record<string, string> = { en: 'en-US', he: 'he-IL', ru: 'ru-RU' };

/** The card's date and time lines as formatEventDateTime writes them (src/services/voice/confirmations.ts). */
function cardWhen(start: string, end: string, locale: string, tz: string) {
  const intl = INTL[locale] ?? INTL.en;
  const time = (iso: string) => new Date(iso).toLocaleTimeString(intl, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
  return {
    date: new Date(start).toLocaleDateString(intl, { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz }),
    time: `${time(start)} - ${time(end)}`,
  };
}

/** The words of the calendar home the Agenda's rows read. */
const AGENDA_KEYS = ['agenda', 'row', 'person', 'hebrewMonthGenitive'];

export function HeroDemo({ t, locale, week, messages }: { t: Translate; locale: string; week: SampleWeek; messages: Record<string, unknown> }) {
  // The bot's strings carry Telegram's HTML (and {name}-style slots, not ICU): read raw, then the words alone
  const bot = (key: string) => botWords(String(t.raw(key)));
  const when = cardWhen(week.dentist.start, week.dentist.end, locale, week.agenda.tz);
  const calendarHome = pickMessages(messages.calendarHome as Record<string, unknown>, AGENDA_KEYS) as AbstractIntlMessages;
  return (
    <figure className="site-demo" aria-label={t('landing.demo.label')}>
      <div className="site-demo-chat">
        <div className="site-bubble site-bubble-out site-voice" role="img" aria-label={t('landing.demo.voiceNote')}>
          <span className="site-voice-play" aria-hidden="true">
            <Play focusable="false" />
          </span>
          <span className="site-voice-wave" aria-hidden="true">
            {Array.from({ length: 22 }, (_, i) => (
              <span key={i} />
            ))}
          </span>
          <span className="site-voice-time" dir="ltr" aria-hidden="true">
            0:04
          </span>
        </div>
        <div className="site-demo-card">
          <div className="site-bubble site-bubble-in site-card">
            <p className="site-card-title">{bot('bot.voice.confirmTitle')}</p>
            <p className="site-card-event">{t('landing.sample.events.dentist')}</p>
            <p className="site-card-line">
              <CalendarDays className="site-card-icon" aria-hidden="true" focusable="false" />
              {when.date}
            </p>
            <p className="site-card-line">
              <Clock className="site-card-icon" aria-hidden="true" focusable="false" />
              <span dir="ltr">{when.time}</span>
            </p>
            <p className="site-card-line">
              <Folder className="site-card-icon" aria-hidden="true" focusable="false" />
              {week.dentist.calendar}
            </p>
            <p className="site-card-from">
              {bot('bot.voice.from')} &quot;{t('landing.sample.voiceNote')}&quot;
            </p>
          </div>
          <div className="site-keys" aria-hidden="true">
            <span className="site-key site-key-create">{bot('bot.voice.createButton')}</span>
            <span className="site-key">{bot('bot.voice.cancelButton')}</span>
            <span className="site-key">{bot('bot.voice.fixTime')}</span>
            <span className="site-key">{bot('bot.voice.fixDay')}</span>
          </div>
        </div>
      </div>
      <div className="site-phone" role="img" aria-label={t('landing.demo.calendarFrame')}>
        <div className="site-phone-screen" inert aria-hidden="true">
          <DemoAgenda agenda={week.agenda} locale={locale} messages={{ calendarHome }} />
        </div>
      </div>
    </figure>
  );
}

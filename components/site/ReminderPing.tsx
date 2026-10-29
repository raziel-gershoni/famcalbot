import { AlarmClock } from 'lucide-react';
import { botWords } from '@/src/site/bot-words';

// A reminder's Telegram ping (spec 2026-10-28-public-website §5.3), as buildPingText and buildPingKeyboard send it
// (src/services/native-reminders/ping.ts): the title, "for both of you", then Done on its own row and the three
// snoozes under it, in the bot's own words. A picture of the ping: its buttons do nothing (aria-hidden).

type Translate = ((key: string) => string) & { raw: (key: string) => unknown };

export function ReminderPing({ t }: { t: Translate }) {
  // The bot's strings carry Telegram's HTML: read raw, then the words alone
  const bot = (key: string) => botWords(String(t.raw(key)));
  return (
    <figure className="site-ping">
      <div className="site-ping-message">
        <div className="site-bubble site-bubble-in">
          <p className="site-ping-title">
            <AlarmClock className="site-card-icon" aria-hidden="true" focusable="false" />
            {t('landing.sample.reminder')}
          </p>
          <p className="site-ping-for">{bot('bot.nativeReminders.ping.forBoth')}</p>
        </div>
        <div className="site-keys site-keys-ping" aria-hidden="true">
          <span className="site-key site-key-wide">{bot('bot.nativeReminders.buttons.done')}</span>
          <span className="site-key">{bot('bot.nativeReminders.buttons.snooze15')}</span>
          <span className="site-key">{bot('bot.nativeReminders.buttons.snooze60')}</span>
          <span className="site-key">{bot('bot.nativeReminders.buttons.snoozeTomorrow')}</span>
        </div>
      </div>
      <figcaption className="site-ping-caption">{t('landing.demo.pingCaption')}</figcaption>
    </figure>
  );
}

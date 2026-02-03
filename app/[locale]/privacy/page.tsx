import { getTranslations } from 'next-intl/server';
import { Metadata } from 'next';
import Link from 'next/link';

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const titles: Record<string, string> = {
    en: 'Privacy Policy - FamCal',
    he: 'מדיניות פרטיות - FamCal',
    ru: 'Политика конфиденциальности - FamCal',
  };

  return {
    title: titles[locale] || titles.en,
  };
}

export default async function PrivacyPage({ params }: Props) {
  const { locale } = await params;

  const content: Record<string, {
    title: string;
    lastUpdated: string;
    sections: { heading: string; content: string | string[] }[];
    backToHome: string;
  }> = {
    en: {
      title: 'Privacy Policy',
      lastUpdated: 'Last updated: February 2026',
      backToHome: 'Back to Home',
      sections: [
        {
          heading: 'Introduction',
          content: 'FamCal ("we", "our", or "us") is a Telegram bot that helps families manage their Google Calendar schedules. This Privacy Policy explains how we collect, use, and protect your information when you use our service.',
        },
        {
          heading: 'Information We Collect',
          content: [
            'Telegram User Information: Your Telegram user ID and display name to identify your account.',
            'Google Calendar Data: We access your Google Calendar through OAuth 2.0 to read your events and, if you grant permission, create or modify events. We store an OAuth refresh token to maintain access.',
            'User Preferences: Your language preference, location (for weather and timezone), calendar display settings, and notification preferences.',
            'Usage Data: We track feature usage (such as summaries requested) to enforce plan limits and improve our service.',
            'Feedback: Any feedback you voluntarily submit through the bot.',
          ],
        },
        {
          heading: 'How We Use Your Information',
          content: [
            'To provide daily and on-demand calendar summaries via text and voice.',
            'To create, edit, or delete calendar events when you request it.',
            'To send you reminders about upcoming events (if enabled).',
            'To personalize your experience based on your preferences.',
            'To enforce subscription plan limits.',
            'To improve our service and fix issues.',
          ],
        },
        {
          heading: 'Google Calendar Data',
          content: 'We access your Google Calendar using the calendar.readonly and calendar.events scopes. We only read calendar data to generate summaries and only write to your calendar when you explicitly request event creation, modification, or deletion. We do not share your calendar data with third parties. Calendar data is processed in real-time and is not permanently stored on our servers beyond the OAuth refresh token needed to maintain access.',
        },
        {
          heading: 'Data Storage and Security',
          content: 'Your data is stored securely in a PostgreSQL database hosted on Neon. OAuth tokens are stored encrypted. We use industry-standard security practices to protect your information. We do not sell your data to third parties.',
        },
        {
          heading: 'Data Retention',
          content: 'We retain your account data as long as you use the service. You can request deletion of your data at any time by contacting us. When you disconnect your Google Calendar or delete your account, we delete your OAuth tokens and associated data.',
        },
        {
          heading: 'Third-Party Services',
          content: [
            'Google Calendar API: To access and manage your calendar events.',
            'Telegram Bot API: To communicate with you through Telegram.',
            'OpenAI API: To generate natural language summaries and process voice commands.',
            'OpenWeatherMap: To provide weather information in your summaries.',
          ],
        },
        {
          heading: 'Your Rights',
          content: [
            'Access: You can request a copy of your data.',
            'Correction: You can update your information through the bot settings.',
            'Deletion: You can request deletion of your account and data.',
            'Revoke Access: You can revoke Google Calendar access at any time through your Google Account settings.',
          ],
        },
        {
          heading: 'Children\'s Privacy',
          content: 'Our service is not intended for children under 13. We do not knowingly collect information from children under 13.',
        },
        {
          heading: 'Changes to This Policy',
          content: 'We may update this Privacy Policy from time to time. We will notify users of significant changes through the bot.',
        },
        {
          heading: 'Contact Us',
          content: 'If you have questions about this Privacy Policy or your data, please contact us through the Telegram bot using the /feedback command.',
        },
      ],
    },
    he: {
      title: 'מדיניות פרטיות',
      lastUpdated: 'עודכן לאחרונה: פברואר 2026',
      backToHome: 'חזרה לדף הבית',
      sections: [
        {
          heading: 'מבוא',
          content: 'FamCal ("אנחנו" או "שלנו") הוא בוט טלגרם שעוזר למשפחות לנהל את לוחות השנה שלהם ב-Google Calendar. מדיניות פרטיות זו מסבירה כיצד אנו אוספים, משתמשים ומגנים על המידע שלך כאשר אתה משתמש בשירות שלנו.',
        },
        {
          heading: 'מידע שאנו אוספים',
          content: [
            'מידע מטלגרם: מזהה המשתמש שלך בטלגרם ושם התצוגה לזיהוי החשבון.',
            'נתוני Google Calendar: אנו ניגשים ליומן Google שלך באמצעות OAuth 2.0 כדי לקרוא אירועים, ואם תאשר, ליצור או לערוך אירועים. אנו שומרים אסימון OAuth לשמירת הגישה.',
            'העדפות משתמש: שפה, מיקום (למזג אוויר ואזור זמן), הגדרות תצוגת יומן והעדפות התראות.',
            'נתוני שימוש: אנו עוקבים אחר שימוש בתכונות (כמו סיכומים שהתבקשו) לאכיפת מגבלות תוכנית ושיפור השירות.',
            'משוב: כל משוב שתשלח מרצונך דרך הבוט.',
          ],
        },
        {
          heading: 'כיצד אנו משתמשים במידע',
          content: [
            'לספק סיכומי יומן יומיים ולפי דרישה בטקסט ובקול.',
            'ליצור, לערוך או למחוק אירועים ביומן כאשר אתה מבקש.',
            'לשלוח לך תזכורות על אירועים קרובים (אם מופעל).',
            'להתאים אישית את החוויה שלך לפי ההעדפות שלך.',
            'לאכוף מגבלות תוכנית מנוי.',
            'לשפר את השירות ולתקן בעיות.',
          ],
        },
        {
          heading: 'נתוני Google Calendar',
          content: 'אנו ניגשים ליומן Google שלך באמצעות הרשאות calendar.readonly ו-calendar.events. אנו קוראים נתוני יומן רק כדי ליצור סיכומים וכותבים ליומן רק כאשר אתה מבקש במפורש יצירה, עריכה או מחיקה של אירועים. אנו לא משתפים את נתוני היומן שלך עם צדדים שלישיים. נתוני היומן מעובדים בזמן אמת ואינם נשמרים באופן קבוע בשרתים שלנו מעבר לאסימון OAuth הנדרש לשמירת הגישה.',
        },
        {
          heading: 'אחסון נתונים ואבטחה',
          content: 'הנתונים שלך מאוחסנים בצורה מאובטחת במסד נתונים PostgreSQL המתארח ב-Neon. אסימוני OAuth מאוחסנים מוצפנים. אנו משתמשים בשיטות אבטחה מקובלות בתעשייה להגנה על המידע שלך. אנו לא מוכרים את הנתונים שלך לצדדים שלישיים.',
        },
        {
          heading: 'שמירת נתונים',
          content: 'אנו שומרים את נתוני החשבון שלך כל עוד אתה משתמש בשירות. תוכל לבקש מחיקת הנתונים שלך בכל עת על ידי פנייה אלינו. כאשר אתה מנתק את יומן Google או מוחק את חשבונך, אנו מוחקים את אסימוני OAuth והנתונים הקשורים.',
        },
        {
          heading: 'שירותי צד שלישי',
          content: [
            'Google Calendar API: לגישה וניהול אירועי היומן שלך.',
            'Telegram Bot API: לתקשורת איתך דרך טלגרם.',
            'OpenAI API: ליצירת סיכומים בשפה טבעית ועיבוד פקודות קוליות.',
            'OpenWeatherMap: לספק מידע על מזג האוויר בסיכומים שלך.',
          ],
        },
        {
          heading: 'הזכויות שלך',
          content: [
            'גישה: תוכל לבקש עותק של הנתונים שלך.',
            'תיקון: תוכל לעדכן את המידע שלך דרך הגדרות הבוט.',
            'מחיקה: תוכל לבקש מחיקת החשבון והנתונים שלך.',
            'ביטול גישה: תוכל לבטל את גישת יומן Google בכל עת דרך הגדרות חשבון Google שלך.',
          ],
        },
        {
          heading: 'פרטיות ילדים',
          content: 'השירות שלנו אינו מיועד לילדים מתחת לגיל 13. אנו לא אוספים ביודעין מידע מילדים מתחת לגיל 13.',
        },
        {
          heading: 'שינויים במדיניות זו',
          content: 'אנו עשויים לעדכן מדיניות פרטיות זו מעת לעת. נודיע למשתמשים על שינויים משמעותיים דרך הבוט.',
        },
        {
          heading: 'צור קשר',
          content: 'אם יש לך שאלות לגבי מדיניות פרטיות זו או הנתונים שלך, אנא צור קשר דרך בוט הטלגרם באמצעות פקודת /feedback.',
        },
      ],
    },
    ru: {
      title: 'Политика конфиденциальности',
      lastUpdated: 'Последнее обновление: февраль 2026',
      backToHome: 'На главную',
      sections: [
        {
          heading: 'Введение',
          content: 'FamCal ("мы" или "наш") — это Telegram-бот, который помогает семьям управлять расписанием в Google Calendar. Настоящая Политика конфиденциальности объясняет, как мы собираем, используем и защищаем вашу информацию при использовании нашего сервиса.',
        },
        {
          heading: 'Информация, которую мы собираем',
          content: [
            'Информация из Telegram: Ваш идентификатор пользователя Telegram и отображаемое имя для идентификации аккаунта.',
            'Данные Google Calendar: Мы получаем доступ к вашему Google Calendar через OAuth 2.0 для чтения событий и, с вашего разрешения, создания или редактирования событий. Мы храним токен OAuth для поддержания доступа.',
            'Пользовательские настройки: Язык, местоположение (для погоды и часового пояса), настройки отображения календаря и уведомлений.',
            'Данные об использовании: Мы отслеживаем использование функций (например, запрошенные сводки) для соблюдения лимитов плана и улучшения сервиса.',
            'Отзывы: Любые отзывы, которые вы добровольно отправляете через бота.',
          ],
        },
        {
          heading: 'Как мы используем вашу информацию',
          content: [
            'Для предоставления ежедневных и по запросу сводок календаря в текстовом и голосовом формате.',
            'Для создания, редактирования или удаления событий календаря по вашему запросу.',
            'Для отправки напоминаний о предстоящих событиях (если включено).',
            'Для персонализации вашего опыта на основе ваших предпочтений.',
            'Для соблюдения лимитов плана подписки.',
            'Для улучшения сервиса и исправления проблем.',
          ],
        },
        {
          heading: 'Данные Google Calendar',
          content: 'Мы получаем доступ к вашему Google Calendar с использованием разрешений calendar.readonly и calendar.events. Мы читаем данные календаря только для создания сводок и записываем в календарь только когда вы явно запрашиваете создание, редактирование или удаление событий. Мы не передаем данные вашего календаря третьим лицам. Данные календаря обрабатываются в реальном времени и не хранятся постоянно на наших серверах, кроме токена OAuth, необходимого для поддержания доступа.',
        },
        {
          heading: 'Хранение данных и безопасность',
          content: 'Ваши данные надежно хранятся в базе данных PostgreSQL, размещенной на Neon. Токены OAuth хранятся в зашифрованном виде. Мы используем стандартные отраслевые методы безопасности для защиты вашей информации. Мы не продаем ваши данные третьим лицам.',
        },
        {
          heading: 'Срок хранения данных',
          content: 'Мы храним данные вашего аккаунта, пока вы пользуетесь сервисом. Вы можете запросить удаление ваших данных в любое время, связавшись с нами. Когда вы отключаете Google Calendar или удаляете свой аккаунт, мы удаляем токены OAuth и связанные данные.',
        },
        {
          heading: 'Сторонние сервисы',
          content: [
            'Google Calendar API: Для доступа и управления событиями вашего календаря.',
            'Telegram Bot API: Для общения с вами через Telegram.',
            'OpenAI API: Для генерации сводок на естественном языке и обработки голосовых команд.',
            'OpenWeatherMap: Для предоставления информации о погоде в ваших сводках.',
          ],
        },
        {
          heading: 'Ваши права',
          content: [
            'Доступ: Вы можете запросить копию ваших данных.',
            'Исправление: Вы можете обновить свою информацию через настройки бота.',
            'Удаление: Вы можете запросить удаление вашего аккаунта и данных.',
            'Отзыв доступа: Вы можете отозвать доступ к Google Calendar в любое время через настройки вашего аккаунта Google.',
          ],
        },
        {
          heading: 'Конфиденциальность детей',
          content: 'Наш сервис не предназначен для детей младше 13 лет. Мы сознательно не собираем информацию от детей младше 13 лет.',
        },
        {
          heading: 'Изменения в этой политике',
          content: 'Мы можем время от времени обновлять эту Политику конфиденциальности. Мы уведомим пользователей о существенных изменениях через бота.',
        },
        {
          heading: 'Связаться с нами',
          content: 'Если у вас есть вопросы об этой Политике конфиденциальности или ваших данных, пожалуйста, свяжитесь с нами через Telegram-бота, используя команду /feedback.',
        },
      ],
    },
  };

  const c = content[locale] || content.en;

  return (
    <>
      <style>{`
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }

        body {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
          color: #1a1a1a;
          line-height: 1.7;
          background: #f8f9fa;
        }

        [dir="rtl"] body {
          font-family: 'Heebo', -apple-system, BlinkMacSystemFont, sans-serif;
        }

        .container {
          max-width: 800px;
          margin: 0 auto;
          padding: 2rem;
        }

        .back-link {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          color: #0088cc;
          text-decoration: none;
          margin-bottom: 2rem;
        }

        .back-link:hover {
          text-decoration: underline;
        }

        h1 {
          font-size: 2.5rem;
          margin-bottom: 0.5rem;
        }

        .last-updated {
          color: #666;
          margin-bottom: 2rem;
        }

        .content {
          background: white;
          border-radius: 12px;
          padding: 2rem;
          box-shadow: 0 2px 8px rgba(0,0,0,0.06);
        }

        h2 {
          font-size: 1.3rem;
          margin-top: 2rem;
          margin-bottom: 1rem;
          color: #1a1a1a;
        }

        h2:first-child {
          margin-top: 0;
        }

        p {
          margin-bottom: 1rem;
          color: #444;
        }

        ul {
          margin-bottom: 1rem;
          padding-left: 1.5rem;
        }

        [dir="rtl"] ul {
          padding-left: 0;
          padding-right: 1.5rem;
        }

        li {
          margin-bottom: 0.5rem;
          color: #444;
        }
      `}</style>

      <div className="container">
        <Link href={`/${locale}`} className="back-link">
          ← {c.backToHome}
        </Link>

        <h1>{c.title}</h1>
        <p className="last-updated">{c.lastUpdated}</p>

        <div className="content">
          {c.sections.map((section, i) => (
            <div key={i}>
              <h2>{section.heading}</h2>
              {Array.isArray(section.content) ? (
                <ul>
                  {section.content.map((item, j) => (
                    <li key={j}>{item}</li>
                  ))}
                </ul>
              ) : (
                <p>{section.content}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

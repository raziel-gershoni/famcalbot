import { Metadata } from 'next';
import Link from 'next/link';

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const titles: Record<string, string> = {
    en: 'Terms of Service - FamCal',
    he: 'תנאי שימוש - FamCal',
    ru: 'Условия использования - FamCal',
  };

  return {
    title: titles[locale] || titles.en,
  };
}

export default async function TermsPage({ params }: Props) {
  const { locale } = await params;

  const content: Record<string, {
    title: string;
    lastUpdated: string;
    sections: { heading: string; content: string | string[] }[];
    backToHome: string;
  }> = {
    en: {
      title: 'Terms of Service',
      lastUpdated: 'Last updated: February 2026',
      backToHome: 'Back to Home',
      sections: [
        {
          heading: 'Agreement to Terms',
          content: 'By using FamCal ("the Service"), you agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use the Service.',
        },
        {
          heading: 'Description of Service',
          content: 'FamCal is a Telegram bot that connects to your Google Calendar to provide daily summaries, event management through voice and text commands, and reminders. The Service requires you to grant access to your Google Calendar.',
        },
        {
          heading: 'Account and Access',
          content: [
            'You must have a valid Telegram account to use the Service.',
            'You must authorize the Service to access your Google Calendar.',
            'You are responsible for maintaining the security of your accounts.',
            'You may revoke access at any time through your Google Account settings.',
          ],
        },
        {
          heading: 'Acceptable Use',
          content: [
            'Use the Service only for its intended purpose of calendar management.',
            'Do not attempt to abuse, exploit, or overwhelm the Service.',
            'Do not use the Service for any illegal or unauthorized purpose.',
            'Do not interfere with or disrupt the Service or its infrastructure.',
          ],
        },
        {
          heading: 'Subscription Plans',
          content: 'The Service offers free and paid subscription plans. Free plans have usage limits. Paid plans are billed through Telegram Stars and provide expanded features. Subscription details and pricing are displayed in the bot. We reserve the right to modify pricing and features with reasonable notice.',
        },
        {
          heading: 'Intellectual Property',
          content: 'The Service and its original content, features, and functionality are owned by FamCal and are protected by applicable intellectual property laws. Your calendar data remains yours.',
        },
        {
          heading: 'Disclaimer of Warranties',
          content: 'The Service is provided "as is" without warranties of any kind. We do not guarantee that the Service will be uninterrupted, secure, or error-free. We are not responsible for any errors in calendar data or missed reminders.',
        },
        {
          heading: 'Limitation of Liability',
          content: 'To the maximum extent permitted by law, FamCal shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including loss of data or missed appointments, resulting from your use of the Service.',
        },
        {
          heading: 'Third-Party Services',
          content: 'The Service integrates with Google Calendar, Telegram, and other third-party services. Your use of these services is subject to their respective terms and policies. We are not responsible for the availability or functionality of third-party services.',
        },
        {
          heading: 'Modifications to Service',
          content: 'We reserve the right to modify, suspend, or discontinue the Service at any time with or without notice. We will make reasonable efforts to notify users of significant changes.',
        },
        {
          heading: 'Termination',
          content: 'We may terminate or suspend your access to the Service at any time for violation of these terms or for any other reason at our discretion. You may stop using the Service at any time by revoking Google Calendar access and blocking the Telegram bot.',
        },
        {
          heading: 'Changes to Terms',
          content: 'We may update these Terms of Service from time to time. Continued use of the Service after changes constitutes acceptance of the new terms.',
        },
        {
          heading: 'Contact',
          content: 'For questions about these Terms, please contact us through the Telegram bot using the /feedback command.',
        },
      ],
    },
    he: {
      title: 'תנאי שימוש',
      lastUpdated: 'עודכן לאחרונה: פברואר 2026',
      backToHome: 'חזרה לדף הבית',
      sections: [
        {
          heading: 'הסכמה לתנאים',
          content: 'באמצעות שימוש ב-FamCal ("השירות"), אתה מסכים להיות כפוף לתנאי שימוש אלה. אם אינך מסכים לתנאים אלה, אנא אל תשתמש בשירות.',
        },
        {
          heading: 'תיאור השירות',
          content: 'FamCal הוא בוט טלגרם שמתחבר ליומן Google שלך כדי לספק סיכומים יומיים, ניהול אירועים באמצעות פקודות קוליות וטקסט, ותזכורות. השירות דורש ממך להעניק גישה ליומן Google שלך.',
        },
        {
          heading: 'חשבון וגישה',
          content: [
            'עליך להיות בעל חשבון טלגרם תקף כדי להשתמש בשירות.',
            'עליך לאשר לשירות גישה ליומן Google שלך.',
            'אתה אחראי לשמירה על אבטחת החשבונות שלך.',
            'תוכל לבטל את הגישה בכל עת דרך הגדרות חשבון Google שלך.',
          ],
        },
        {
          heading: 'שימוש מקובל',
          content: [
            'השתמש בשירות רק למטרתו המיועדת של ניהול יומן.',
            'אל תנסה לנצל לרעה או להעמיס יתר על המידה את השירות.',
            'אל תשתמש בשירות לכל מטרה בלתי חוקית או לא מורשית.',
            'אל תפריע או תשבש את השירות או התשתית שלו.',
          ],
        },
        {
          heading: 'תוכניות מנוי',
          content: 'השירות מציע תוכניות מנוי חינמיות ובתשלום. לתוכניות חינמיות יש מגבלות שימוש. תוכניות בתשלום מחויבות באמצעות Telegram Stars ומספקות תכונות מורחבות. פרטי המנוי והתמחור מוצגים בבוט. אנו שומרים לעצמנו את הזכות לשנות תמחור ותכונות עם הודעה סבירה.',
        },
        {
          heading: 'קניין רוחני',
          content: 'השירות והתוכן, התכונות והפונקציונליות המקוריים שלו הם בבעלות FamCal ומוגנים על ידי חוקי קניין רוחני. נתוני היומן שלך נשארים שלך.',
        },
        {
          heading: 'הצהרת אי-אחריות',
          content: 'השירות מסופק "כמות שהוא" ללא אחריות מכל סוג. אנו לא מתחייבים שהשירות יהיה רציף, מאובטח או נטול שגיאות. אנו לא אחראים לשגיאות בנתוני יומן או תזכורות שהוחמצו.',
        },
        {
          heading: 'הגבלת אחריות',
          content: 'במידה המרבית המותרת על פי חוק, FamCal לא יהיה אחראי לכל נזק עקיף, מקרי, מיוחד, תוצאתי או עונשי, כולל אובדן נתונים או פגישות שהוחמצו, הנובעים משימושך בשירות.',
        },
        {
          heading: 'שירותי צד שלישי',
          content: 'השירות משתלב עם Google Calendar, Telegram ושירותי צד שלישי אחרים. השימוש שלך בשירותים אלה כפוף לתנאים ולמדיניות שלהם. אנו לא אחראים לזמינות או לפונקציונליות של שירותי צד שלישי.',
        },
        {
          heading: 'שינויים בשירות',
          content: 'אנו שומרים לעצמנו את הזכות לשנות, להשהות או להפסיק את השירות בכל עת עם או ללא הודעה. אנו נעשה מאמצים סבירים להודיע למשתמשים על שינויים משמעותיים.',
        },
        {
          heading: 'סיום',
          content: 'אנו עשויים לסיים או להשהות את הגישה שלך לשירות בכל עת בגין הפרת תנאים אלה או מכל סיבה אחרת לפי שיקול דעתנו. תוכל להפסיק להשתמש בשירות בכל עת על ידי ביטול גישת יומן Google וחסימת בוט הטלגרם.',
        },
        {
          heading: 'שינויים בתנאים',
          content: 'אנו עשויים לעדכן תנאי שימוש אלה מעת לעת. המשך השימוש בשירות לאחר שינויים מהווה הסכמה לתנאים החדשים.',
        },
        {
          heading: 'יצירת קשר',
          content: 'לשאלות לגבי תנאים אלה, אנא צור קשר דרך בוט הטלגרם באמצעות פקודת /feedback.',
        },
      ],
    },
    ru: {
      title: 'Условия использования',
      lastUpdated: 'Последнее обновление: февраль 2026',
      backToHome: 'На главную',
      sections: [
        {
          heading: 'Согласие с условиями',
          content: 'Используя FamCal ("Сервис"), вы соглашаетесь соблюдать настоящие Условия использования. Если вы не согласны с этими условиями, пожалуйста, не используйте Сервис.',
        },
        {
          heading: 'Описание сервиса',
          content: 'FamCal — это Telegram-бот, который подключается к вашему Google Calendar для предоставления ежедневных сводок, управления событиями через голосовые и текстовые команды, а также напоминаний. Сервис требует предоставления доступа к вашему Google Calendar.',
        },
        {
          heading: 'Аккаунт и доступ',
          content: [
            'Для использования Сервиса у вас должен быть действующий аккаунт Telegram.',
            'Вы должны авторизовать Сервис для доступа к вашему Google Calendar.',
            'Вы несете ответственность за безопасность своих аккаунтов.',
            'Вы можете отозвать доступ в любое время через настройки вашего аккаунта Google.',
          ],
        },
        {
          heading: 'Допустимое использование',
          content: [
            'Используйте Сервис только по его прямому назначению — управление календарем.',
            'Не пытайтесь злоупотреблять или перегружать Сервис.',
            'Не используйте Сервис в незаконных или несанкционированных целях.',
            'Не вмешивайтесь в работу Сервиса или его инфраструктуры.',
          ],
        },
        {
          heading: 'Планы подписки',
          content: 'Сервис предлагает бесплатные и платные планы подписки. Бесплатные планы имеют ограничения использования. Платные планы оплачиваются через Telegram Stars и предоставляют расширенные функции. Детали подписки и цены отображаются в боте. Мы оставляем за собой право изменять цены и функции с разумным уведомлением.',
        },
        {
          heading: 'Интеллектуальная собственность',
          content: 'Сервис и его оригинальный контент, функции и функциональность принадлежат FamCal и защищены применимыми законами об интеллектуальной собственности. Данные вашего календаря остаются вашими.',
        },
        {
          heading: 'Отказ от гарантий',
          content: 'Сервис предоставляется "как есть" без каких-либо гарантий. Мы не гарантируем, что Сервис будет бесперебойным, безопасным или безошибочным. Мы не несем ответственности за ошибки в данных календаря или пропущенные напоминания.',
        },
        {
          heading: 'Ограничение ответственности',
          content: 'В максимальной степени, разрешенной законом, FamCal не несет ответственности за любые косвенные, случайные, специальные, последующие или штрафные убытки, включая потерю данных или пропущенные встречи, возникшие в результате использования вами Сервиса.',
        },
        {
          heading: 'Сторонние сервисы',
          content: 'Сервис интегрируется с Google Calendar, Telegram и другими сторонними сервисами. Использование вами этих сервисов регулируется их соответствующими условиями и политиками. Мы не несем ответственности за доступность или функциональность сторонних сервисов.',
        },
        {
          heading: 'Изменения в сервисе',
          content: 'Мы оставляем за собой право изменять, приостанавливать или прекращать работу Сервиса в любое время с уведомлением или без него. Мы приложим разумные усилия для уведомления пользователей о существенных изменениях.',
        },
        {
          heading: 'Прекращение',
          content: 'Мы можем прекратить или приостановить ваш доступ к Сервису в любое время за нарушение этих условий или по любой другой причине по нашему усмотрению. Вы можете прекратить использование Сервиса в любое время, отозвав доступ к Google Calendar и заблокировав Telegram-бота.',
        },
        {
          heading: 'Изменения условий',
          content: 'Мы можем время от времени обновлять настоящие Условия использования. Продолжение использования Сервиса после изменений означает принятие новых условий.',
        },
        {
          heading: 'Контакты',
          content: 'По вопросам об этих Условиях, пожалуйста, свяжитесь с нами через Telegram-бота, используя команду /feedback.',
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

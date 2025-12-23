import { useTranslations } from 'next-intl';

export default function Home() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        padding: '20px',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <h1>FamCalBot</h1>
      <p>Family Calendar Telegram Bot</p>
      <p style={{ marginTop: '20px', color: '#666' }}>
        This is a Telegram Web App. Open it through your Telegram bot.
      </p>
    </div>
  );
}

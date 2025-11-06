import dotenv from 'dotenv';
import https from 'https';

dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN not found in environment variables');
  process.exit(1);
}

const TELEGRAM_API_BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

/**
 * Make a request to Telegram API
 */
function telegramRequest(endpoint: string, data?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, TELEGRAM_API_BASE);
    const options = {
      method: data ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(url, options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.ok) {
            resolve(json.result);
          } else {
            reject(new Error(json.description || 'Unknown error'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

/**
 * Get current webhook info
 */
async function getWebhookInfo() {
  try {
    const info = await telegramRequest('/getWebhookInfo');
    console.log('\n✅ Current webhook info:');
    console.log(JSON.stringify(info, null, 2));
  } catch (error) {
    console.error('\n❌ Error getting webhook info:', error);
    process.exit(1);
  }
}

/**
 * Set webhook URL
 */
async function setWebhook(url: string) {
  try {
    await telegramRequest('/setWebhook', { url });
    console.log(`\n✅ Webhook set successfully to: ${url}`);
    console.log('\n📝 Now test by sending /start, /help, or /summary to your bot');
  } catch (error) {
    console.error('\n❌ Error setting webhook:', error);
    process.exit(1);
  }
}

/**
 * Delete webhook (useful for local development with polling)
 */
async function deleteWebhook() {
  try {
    await telegramRequest('/deleteWebhook');
    console.log('\n✅ Webhook deleted successfully');
    console.log('\n📝 Bot is now ready for polling mode (local development)');
  } catch (error) {
    console.error('\n❌ Error deleting webhook:', error);
    process.exit(1);
  }
}

// Main script
const command = process.argv[2];
const webhookUrl = process.argv[3];

console.log('\n🤖 Telegram Webhook Setup Tool\n');

switch (command) {
  case 'set':
    if (!webhookUrl) {
      console.error('Error: Webhook URL required');
      console.log('Usage: npm run setup-webhook set https://your-domain.vercel.app/api/webhook');
      process.exit(1);
    }
    setWebhook(webhookUrl);
    break;

  case 'delete':
    deleteWebhook();
    break;

  case 'get':
  case 'info':
    getWebhookInfo();
    break;

  default:
    console.log('Usage:');
    console.log('  npm run setup-webhook set <url>  - Set webhook URL');
    console.log('  npm run setup-webhook delete     - Delete webhook (for local dev)');
    console.log('  npm run setup-webhook get        - Get current webhook info');
    console.log('\nExample:');
    console.log('  npm run setup-webhook set https://your-app.vercel.app/api/webhook');
    process.exit(0);
}

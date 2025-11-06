import dotenv from 'dotenv';
import { initBot } from './services/telegram';

// Load environment variables
dotenv.config();

/**
 * Main entry point for local development
 * This runs the bot with polling enabled for testing commands
 */
async function main() {
  console.log('Starting Family Calendar Bot...');

  // Validate required environment variables
  const requiredEnvVars = [
    'TELEGRAM_BOT_TOKEN',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REFRESH_TOKEN',
    'ANTHROPIC_API_KEY',
    'CRON_SECRET',
  ];

  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
    console.error('Missing required environment variables:');
    missingVars.forEach(varName => console.error(`  - ${varName}`));
    process.exit(1);
  }

  try {
    // Initialize the bot with polling for local development
    const bot = initBot();
    console.log('Bot is running with polling enabled...');
    console.log('Press Ctrl+C to stop.');

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\nStopping bot...');
      bot.stopPolling();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('\nStopping bot...');
      bot.stopPolling();
      process.exit(0);
    });
  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exit(1);
  }
}

// Run the bot if this file is executed directly
if (require.main === module) {
  main();
}

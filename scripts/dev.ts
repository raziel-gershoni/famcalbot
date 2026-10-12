#!/usr/bin/env tsx
/**
 * Development server script
 * Starts both Next.js dev server and Telegram bot polling
 */
import { spawn, ChildProcess } from 'child_process';
import dotenv from 'dotenv';
import { initBot } from '../src/services/telegram';

// Load environment variables
dotenv.config({ path: '.env.local' });
dotenv.config();

let nextProcess: ChildProcess | null = null;
let botInstance: ReturnType<typeof initBot> | null = null;

/**
 * Start Next.js dev server
 */
function startNextDev() {
  console.log('🚀 Starting Next.js dev server...');

  nextProcess = spawn('npx', ['next', 'dev'], {
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      NODE_ENV: 'development',
    },
  });

  nextProcess.on('error', (error) => {
    console.error('❌ Failed to start Next.js:', error);
    process.exit(1);
  });

  nextProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`❌ Next.js exited with code ${code}`);
      cleanup();
      process.exit(code);
    }
  });
}

/**
 * Start Telegram bot polling
 */
async function startBotPolling() {
  console.log('🤖 Starting Telegram bot polling...');

  try {
    botInstance = initBot();
    console.log('✅ Telegram bot is running in polling mode');
    console.log('📱 Test your bot by chatting with it on Telegram');
  } catch (error) {
    console.error('❌ Failed to start Telegram bot:', error);
    process.exit(1);
  }
}

/**
 * Cleanup on shutdown
 */
function cleanup() {
  console.log('\n👋 Shutting down development server...');

  if (botInstance) {
    console.log('⏹️  Stopping Telegram bot polling...');
    try {
      botInstance.stopPolling();
    } catch (error) {
      console.error('Error stopping bot polling:', error);
    }
  }

  if (nextProcess) {
    console.log('⏹️  Stopping Next.js dev server...');
    nextProcess.kill('SIGTERM');
  }
}

/**
 * Main entry point
 */
async function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║  FamCalBot - Development Environment   ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');

  // Validate required environment variables
  const requiredVars = [
    'TELEGRAM_BOT_TOKEN',
    'DATABASE_URL',
  ];

  const missingVars = requiredVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    console.error('❌ Missing required environment variables:');
    missingVars.forEach(v => console.error(`   - ${v}`));
    console.error('\n💡 Copy .env.local.example to .env.local and fill in your credentials');
    process.exit(1);
  }

  // Start services
  startNextDev();

  // Wait a bit for Next.js to start, then start bot
  setTimeout(async () => {
    await startBotPolling();
    console.log('');
    console.log('╔════════════════════════════════════════╗');
    console.log('║  ✅ Development server is running!     ║');
    console.log('╠════════════════════════════════════════╣');
    console.log('║  📱 Next.js: http://localhost:3000     ║');
    console.log('║  🤖 Bot: Polling mode (active)         ║');
    console.log('╠════════════════════════════════════════╣');
    console.log('║  Press Ctrl+C to stop                  ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('');
  }, 2000);

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  // Keep process alive
  process.stdin.resume();
}

// Run if executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    cleanup();
    process.exit(1);
  });
}

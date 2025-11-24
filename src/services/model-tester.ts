/**
 * Model Testing Service
 * Allows testing multiple AI models side-by-side
 */

import { CalendarEvent } from '../types';
import { generateSummaryWithMetrics } from './claude';
import { getAIConfig } from '../config/constants';
import { getBot } from './telegram';
import { getAvailableModels, getModelsByProvider, getRecommendedModels } from '../config/ai-models';

/**
 * Calculate estimated cost for a completion
 * HTML-escaped for Telegram
 */
function calculateCost(inputTokens: number, outputTokens: number, modelId: string): string {
  const config = getAIConfig(modelId);
  const inputCost = (inputTokens / 1000000) * config.MODEL_CONFIG.costPer1MTokens.input;
  const outputCost = (outputTokens / 1000000) * config.MODEL_CONFIG.costPer1MTokens.output;
  const totalCost = inputCost + outputCost;

  // Use &lt; instead of < to avoid HTML parsing issues in Telegram
  return totalCost < 0.01 ? `&lt;$0.01` : `$${totalCost.toFixed(3)}`;
}

/**
 * Test a single model and send results
 */
async function testSingleModel(
  modelId: string,
  todayEvents: CalendarEvent[],
  tomorrowEvents: CalendarEvent[],
  todayUserEvents: CalendarEvent[],
  todaySpouseEvents: CalendarEvent[],
  todayOtherEvents: CalendarEvent[],
  tomorrowUserEvents: CalendarEvent[],
  tomorrowSpouseEvents: CalendarEvent[],
  tomorrowOtherEvents: CalendarEvent[],
  userName: string,
  userHebrewName: string,
  spouseName: string,
  spouseHebrewName: string,
  primaryCalendar: string,
  chatId: number
): Promise<void> {
  const botInstance = getBot();
  const config = getAIConfig(modelId);

  try {
    // Start timing for today
    const todayStartTime = Date.now();

    // Generate today's summary with full metrics
    const todayResult = await generateSummaryWithMetrics(
      todayUserEvents,
      todaySpouseEvents,
      todayOtherEvents,
      userName,
      userHebrewName,
      spouseName,
      spouseHebrewName,
      primaryCalendar,
      new Date(),
      modelId
    );

    const todayElapsed = Date.now() - todayStartTime;

    // Send today's result with actual token usage
    const todayMessage = `🧪 <b>${config.MODEL_CONFIG.displayName}</b> - TODAY

${todayResult.text}

<i>⏱️ ${(todayElapsed / 1000).toFixed(1)}s | 🔢 ${todayResult.usage.inputTokens}→${todayResult.usage.outputTokens} tokens | 💰 ${calculateCost(todayResult.usage.inputTokens, todayResult.usage.outputTokens, modelId)} | ${todayResult.stopReason}</i>`;

    await botInstance.sendMessage(chatId, todayMessage, { parse_mode: 'HTML' });

    // Start timing for tomorrow
    const tomorrowStartTime = Date.now();

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Generate tomorrow's summary with full metrics
    const tomorrowResult = await generateSummaryWithMetrics(
      tomorrowUserEvents,
      tomorrowSpouseEvents,
      tomorrowOtherEvents,
      userName,
      userHebrewName,
      spouseName,
      spouseHebrewName,
      primaryCalendar,
      tomorrow,
      modelId
    );

    const tomorrowElapsed = Date.now() - tomorrowStartTime;

    // Send tomorrow's result with actual token usage
    const tomorrowMessage = `🧪 <b>${config.MODEL_CONFIG.displayName}</b> - TOMORROW

${tomorrowResult.text}

<i>⏱️ ${(tomorrowElapsed / 1000).toFixed(1)}s | 🔢 ${tomorrowResult.usage.inputTokens}→${tomorrowResult.usage.outputTokens} tokens | 💰 ${calculateCost(tomorrowResult.usage.inputTokens, tomorrowResult.usage.outputTokens, modelId)} | ${tomorrowResult.stopReason}</i>`;

    await botInstance.sendMessage(chatId, tomorrowMessage, { parse_mode: 'HTML' });
  } catch (error) {
    console.error(`Error testing model ${modelId}:`, error);
    await botInstance.sendMessage(
      chatId,
      `❌ <b>${config.MODEL_CONFIG.displayName}</b> failed:\n${error instanceof Error ? error.message : 'Unknown error'}`,
      { parse_mode: 'HTML' }
    );
  }
}

/**
 * Test multiple models and send comparison results
 */
export async function testModels(
  modelsToTest: string[],
  todayEvents: CalendarEvent[],
  tomorrowEvents: CalendarEvent[],
  todayUserEvents: CalendarEvent[],
  todaySpouseEvents: CalendarEvent[],
  todayOtherEvents: CalendarEvent[],
  tomorrowUserEvents: CalendarEvent[],
  tomorrowSpouseEvents: CalendarEvent[],
  tomorrowOtherEvents: CalendarEvent[],
  userName: string,
  userHebrewName: string,
  spouseName: string,
  spouseHebrewName: string,
  primaryCalendar: string,
  chatId: number,
  uniqueMarker: string
): Promise<void> {
  const botInstance = getBot();

  // Note: Lock is now handled via Redis in handleTestModelsCommand
  // No need for in-memory lock here (doesn't work in serverless anyway)

  try {
    // Send intro message with unique marker to detect Telegram retries
    await botInstance.sendMessage(
      chatId,
      `🧪 <b>Model Testing Started</b> ${uniqueMarker}\n\nTesting ${modelsToTest.length} models...\nEach will send 2 messages (today + tomorrow).\n\n<i>This will take ~${modelsToTest.length * 10} seconds.</i>`,
      { parse_mode: 'HTML' }
    );

    // Test each model sequentially (to avoid rate limits)
    for (let i = 0; i < modelsToTest.length; i++) {
      const modelId = modelsToTest[i];

      console.log(`Testing model ${i + 1}/${modelsToTest.length}: ${modelId}`);

      await testSingleModel(
        modelId,
        todayEvents,
        tomorrowEvents,
        todayUserEvents,
        todaySpouseEvents,
        todayOtherEvents,
        tomorrowUserEvents,
        tomorrowSpouseEvents,
        tomorrowOtherEvents,
        userName,
        userHebrewName,
        spouseName,
        spouseHebrewName,
        primaryCalendar,
        chatId
      );

      // Delay between models to avoid rate limits
      if (i < modelsToTest.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Increased to 2s
      }
    }

    // Send completion message
    await botInstance.sendMessage(
      chatId,
      `✅ <b>Testing Complete!</b>\n\nTested ${modelsToTest.length} models (${modelsToTest.length * 2} messages). Compare the results above to find your favorite!`,
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    console.error('Error in testModels:', error);
    await botInstance.sendMessage(
      chatId,
      `❌ <b>Testing Failed</b>\n\n${error instanceof Error ? error.message : 'Unknown error'}`,
      { parse_mode: 'HTML' }
    );
  }

  console.log('Model testing completed');
}

/**
 * Get list of models to test based on argument
 */
export function getModelsToTest(arg?: string): string[] {
  if (!arg || arg === 'recommended') {
    return getRecommendedModels();
  }

  if (arg === 'all') {
    return getAvailableModels();
  }

  if (arg === 'claude') {
    return Object.keys(getModelsByProvider('claude'));
  }

  if (arg === 'openai') {
    return Object.keys(getModelsByProvider('openai'));
  }

  // Single model test
  if (getAvailableModels().includes(arg)) {
    return [arg];
  }

  // Invalid argument
  return getRecommendedModels();
}

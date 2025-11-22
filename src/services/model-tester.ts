/**
 * Model Testing Service
 * Allows testing multiple AI models side-by-side
 */

import { CalendarEvent } from '../types';
import { generateSummary } from './claude';
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
  userEvents: CalendarEvent[],
  spouseEvents: CalendarEvent[],
  otherEvents: CalendarEvent[],
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
    // Start timing
    const startTime = Date.now();

    // Generate summaries for today and tomorrow
    const todaySummary = await generateSummary(
      userEvents.filter(e => todayEvents.includes(e)),
      spouseEvents.filter(e => todayEvents.includes(e)),
      otherEvents.filter(e => todayEvents.includes(e)),
      userName,
      userHebrewName,
      spouseName,
      spouseHebrewName,
      primaryCalendar,
      new Date(),
      false, // Don't include regular model info
      modelId
    );

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const tomorrowSummary = await generateSummary(
      userEvents.filter(e => tomorrowEvents.includes(e)),
      spouseEvents.filter(e => tomorrowEvents.includes(e)),
      otherEvents.filter(e => tomorrowEvents.includes(e)),
      userName,
      userHebrewName,
      spouseName,
      spouseHebrewName,
      primaryCalendar,
      tomorrow,
      false, // Don't include regular model info
      modelId
    );

    // Calculate elapsed time
    const elapsedTime = Date.now() - startTime;
    const seconds = (elapsedTime / 1000).toFixed(1);

    // Format the test result message
    const message = `🧪 <b>${config.MODEL_CONFIG.displayName}</b>

<b>📅 TODAY:</b>
${todaySummary}

<b>📅 TOMORROW:</b>
${tomorrowSummary}

<i>⏱️ ${seconds}s | 💰 ~${calculateCost(1400, 250, modelId)} per summary</i>`;

    await botInstance.sendMessage(chatId, message, { parse_mode: 'HTML' });
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
  userEvents: CalendarEvent[],
  spouseEvents: CalendarEvent[],
  otherEvents: CalendarEvent[],
  userName: string,
  userHebrewName: string,
  spouseName: string,
  spouseHebrewName: string,
  primaryCalendar: string,
  chatId: number
): Promise<void> {
  const botInstance = getBot();

  // Send intro message
  await botInstance.sendMessage(
    chatId,
    `🧪 <b>Model Testing Started</b>\n\nTesting ${modelsToTest.length} models...\nEach will send today's and tomorrow's summaries.`,
    { parse_mode: 'HTML' }
  );

  // Test each model sequentially (to avoid rate limits)
  for (const modelId of modelsToTest) {
    await testSingleModel(
      modelId,
      todayEvents,
      tomorrowEvents,
      userEvents,
      spouseEvents,
      otherEvents,
      userName,
      userHebrewName,
      spouseName,
      spouseHebrewName,
      primaryCalendar,
      chatId
    );

    // Small delay between models to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Send completion message
  await botInstance.sendMessage(
    chatId,
    `✅ <b>Testing Complete!</b>\n\nTested ${modelsToTest.length} models. Compare the results above to find your favorite!`,
    { parse_mode: 'HTML' }
  );
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

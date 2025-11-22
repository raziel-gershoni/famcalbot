# AI Model Configuration Guide

## Quick Start

Simply set the `AI_MODEL` environment variable to switch between models:

```bash
# Use Claude Sonnet 4.5 (default, best balance)
AI_MODEL=claude-sonnet-4.5

# Use GPT-4.1 Mini (faster, cheaper)
AI_MODEL=gpt-4.1-mini

# Use Claude Opus 4 (most powerful, best coding)
AI_MODEL=claude-opus-4
```

## Available Models

### Claude Models (Anthropic)

| Identifier | Model | Max Tokens | Context | Cost (per 1M tokens) | Best For |
|------------|-------|------------|---------|---------------------|----------|
| `claude-sonnet-4.5` | Claude Sonnet 4.5 | 64K | 1M | $3/$15 (in/out) | **Default choice** - excellent balance |
| `claude-opus-4` | Claude Opus 4 | 64K | 1M | $15/$75 (in/out) | Complex reasoning, best coding |
| `claude-sonnet-4` | Claude Sonnet 4 | 64K | 1M | $3/$15 (in/out) | Previous generation, still capable |

### OpenAI Models (GPT)

| Identifier | Model | Max Tokens | Context | Cost (per 1M tokens) | Best For |
|------------|-------|------------|---------|---------------------|----------|
| `gpt-4.1` | GPT-4.1 | 16K | 1M | $2.5/$10 (in/out) | Latest GPT, great coding |
| `gpt-4.1-mini` | GPT-4.1 Mini | 16K | 1M | $0.15/$0.6 (in/out) | Faster, cheaper, good for most tasks |
| `gpt-4.1-nano` | GPT-4.1 Nano | 16K | 1M | $0.04/$0.16 (in/out) | **Cheapest** - simple summaries |
| `gpt-4o` | GPT-4o | 16K | 128K | $2.5/$10 (in/out) | Multimodal (audio/vision/text) |
| `gpt-4o-mini` | GPT-4o Mini | 16K | 128K | $0.15/$0.6 (in/out) | Cheaper multimodal |

## Environment Variables

```bash
# Required: Choose your model
AI_MODEL=claude-sonnet-4.5

# Required: Provide API key for your chosen provider
ANTHROPIC_API_KEY=sk-ant-...    # For Claude models
OPENAI_API_KEY=sk-...           # For GPT models

# Optional: Override max output tokens (default: 2000)
AI_MAX_TOKENS=3000

# Optional: Configure retry attempts (default: 3)
AI_MAX_RETRIES=5
```

## Features

### ✅ Automatic Token Monitoring
The system monitors token usage and sends you a Telegram alert if the response is truncated due to hitting the token limit.

### ✅ Automatic Retries with Exponential Backoff
If the AI API fails (network issues, rate limits, etc.), the system automatically retries with increasing delays:
- Attempt 1: Immediate
- Attempt 2: Wait 1 second
- Attempt 3: Wait 2 seconds
- Attempt 4: Wait 4 seconds

### ✅ Easy Model Switching
Just change the `AI_MODEL` environment variable in Vercel or your `.env` file - no code changes needed!

### ✅ Cost Tracking
All API calls log token usage to help you monitor costs:

```
AI Completion Success: {
  model: 'Claude Sonnet 4.5',
  inputTokens: 1407,
  outputTokens: 256,
  stopReason: 'end_turn'
}
```

## How to Switch Models

### In Development (Local)
Edit your `.env` file:
```bash
AI_MODEL=gpt-4.1-mini
OPENAI_API_KEY=sk-...
```

### In Production (Vercel)
1. Go to Vercel Dashboard → Your Project → Settings → Environment Variables
2. Update `AI_MODEL` to your chosen model
3. Add the appropriate API key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`)
4. Redeploy

## Cost Optimization Tips

1. **Start with the cheapest**: Try `gpt-4.1-nano` first ($0.04/$0.16 per 1M tokens)
2. **Monitor usage**: Check Vercel logs for token counts
3. **Upgrade if needed**: If quality isn't good enough, upgrade to `gpt-4.1-mini` or `claude-sonnet-4.5`
4. **Use different models for different tasks**: Daily summaries might work with `gpt-4.1-nano`, while complex analysis might need `claude-opus-4`

## Current Usage

Based on your current logs (256 average output tokens):
- **Claude Sonnet 4.5**: ~$0.004 per summary
- **GPT-4.1 Mini**: ~$0.0002 per summary
- **GPT-4.1 Nano**: ~$0.00004 per summary

With 2 summaries/day × 2 users = 4 summaries/day:
- **Claude Sonnet 4.5**: ~$5/month
- **GPT-4.1 Mini**: ~$0.25/month
- **GPT-4.1 Nano**: ~$0.05/month

## Adding New Models

To add a new model, edit `src/config/ai-models.ts`:

```typescript
export const AI_MODELS: Record<string, ModelConfig> = {
  'my-new-model': {
    provider: 'openai', // or 'claude'
    modelId: 'gpt-5-turbo',
    displayName: 'GPT-5 Turbo',
    maxOutputTokens: 32000,
    contextWindow: 2000000,
    costPer1MTokens: { input: 1, output: 5 },
    description: 'Next generation GPT',
  },
  // ... other models
};
```

Then use it: `AI_MODEL=my-new-model`

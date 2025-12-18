import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Privacy Policy Page
 * Simple privacy policy for the Family Calendar Bot
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Privacy Policy - Family Calendar Bot</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            line-height: 1.6;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            color: #333;
        }
        h1 {
            color: #25D366;
            border-bottom: 2px solid #25D366;
            padding-bottom: 10px;
        }
        h2 {
            color: #075E54;
            margin-top: 30px;
        }
        .last-updated {
            color: #666;
            font-style: italic;
        }
    </style>
</head>
<body>
    <h1>Privacy Policy</h1>
    <p class="last-updated">Last updated: December 18, 2025</p>

    <h2>1. Introduction</h2>
    <p>
        Family Calendar Bot ("the Bot") is a private WhatsApp and Telegram bot designed to provide
        calendar summaries and weather information to authorized family members.
    </p>

    <h2>2. Data Collection</h2>
    <p>The Bot collects and processes the following data:</p>
    <ul>
        <li>WhatsApp phone numbers and Telegram user IDs (for authentication and message delivery)</li>
        <li>Message content (commands sent to the bot)</li>
        <li>Calendar events from linked Google Calendar accounts</li>
        <li>Location information (for weather queries)</li>
    </ul>

    <h2>3. Data Usage</h2>
    <p>Your data is used solely for the following purposes:</p>
    <ul>
        <li>Authenticating authorized family members</li>
        <li>Processing commands and generating calendar summaries</li>
        <li>Providing weather information for specified locations</li>
        <li>Generating voice messages with calendar information</li>
        <li>Sending automated daily/weekly calendar summaries</li>
    </ul>

    <h2>4. Data Storage</h2>
    <ul>
        <li>User messages are processed in real-time and not permanently stored</li>
        <li>User configuration (phone numbers, preferences) is stored in the application code</li>
        <li>Calendar data is accessed through Google Calendar API and not stored locally</li>
        <li>Temporary audio files for voice messages are deleted after delivery</li>
    </ul>

    <h2>5. Data Sharing</h2>
    <p>
        We do not share, sell, or distribute your personal data to third parties. The Bot uses the
        following third-party services:
    </p>
    <ul>
        <li><strong>WhatsApp Business Cloud API:</strong> For receiving and sending WhatsApp messages</li>
        <li><strong>Telegram Bot API:</strong> For receiving and sending Telegram messages</li>
        <li><strong>Google Calendar API:</strong> For accessing calendar events</li>
        <li><strong>Google Text-to-Speech API:</strong> For generating voice messages</li>
        <li><strong>Anthropic Claude API:</strong> For AI-powered calendar summaries</li>
        <li><strong>OpenWeather API:</strong> For weather information</li>
    </ul>
    <p>These services operate under their own privacy policies.</p>

    <h2>6. Data Security</h2>
    <ul>
        <li>Access to the Bot is restricted to whitelisted family members only</li>
        <li>API credentials and tokens are stored securely as environment variables</li>
        <li>All communications use encrypted HTTPS connections</li>
        <li>Unauthorized users receive no response from the Bot</li>
    </ul>

    <h2>7. User Rights</h2>
    <p>As an authorized user, you have the right to:</p>
    <ul>
        <li>Request information about what data is stored about you</li>
        <li>Request removal from the authorized users list</li>
        <li>Stop using the Bot at any time</li>
    </ul>

    <h2>8. Children's Privacy</h2>
    <p>
        This Bot is designed for family use and may be accessed by minors under parental supervision.
        We do not knowingly collect personal information from children without parental consent.
    </p>

    <h2>9. Changes to This Policy</h2>
    <p>
        We may update this privacy policy from time to time. Any changes will be reflected by updating
        the "Last updated" date at the top of this policy.
    </p>

    <h2>10. Contact</h2>
    <p>
        For any questions or concerns about this privacy policy or the Bot's data practices,
        please contact the Bot administrator.
    </p>

    <hr style="margin-top: 40px; border: none; border-top: 1px solid #ddd;">
    <p style="text-align: center; color: #666; font-size: 14px;">
        Family Calendar Bot - Private Family Assistant
    </p>
</body>
</html>
  `;

  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(html);
}

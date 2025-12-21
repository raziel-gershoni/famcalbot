import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUserByTelegramId, updateUserCalendars } from '../src/services/user-service';
import { listUserCalendars } from '../src/services/calendar';

/**
 * Standalone Calendar Selection Endpoint
 * Allows users to change calendar selections without OAuth
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const { user_id } = req.query;

  if (!user_id) {
    res.status(400).send('Missing user_id parameter');
    return;
  }

  const userId = parseInt(user_id as string);
  const user = await getUserByTelegramId(userId);

  if (!user) {
    res.status(404).send('User not found');
    return;
  }

  if (!user.googleRefreshToken) {
    res.status(400).send('No Google token found. Please refresh your token first.');
    return;
  }

  // Handle calendar selection submission
  if (req.method === 'POST') {
    const { primary, own_calendars, spouse_calendars } = req.body;

    const ownCals = Array.isArray(own_calendars) ? own_calendars : (own_calendars ? [own_calendars] : []);
    const spouseCals = spouse_calendars ? (Array.isArray(spouse_calendars) ? spouse_calendars : [spouse_calendars]) : [];
    const allCals = [...new Set([...ownCals, ...spouseCals])];

    await updateUserCalendars(userId, {
      all: allCals,
      primary: primary,
      own: ownCals,
      spouse: spouseCals
    });

    // Get updated user for success page
    const updatedUser = await getUserByTelegramId(userId);

    // Show simple success page
    const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'family_calendar_telegram_bot';
    res.setHeader('Content-Type', 'text/html');
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>✅ Calendars Saved</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <script src="https://telegram.org/js/telegram-web-app.js"></script>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              margin: 0;
              padding: 20px;
            }
            .container { max-width: 500px; width: 100%; }
            .success-box {
              background: white;
              padding: 40px;
              border-radius: 15px;
              box-shadow: 0 10px 40px rgba(0,0,0,0.2);
              text-align: center;
            }
            .icon {
              font-size: 64px;
              margin-bottom: 20px;
              animation: bounce 1s;
            }
            @keyframes bounce {
              0%, 100% { transform: translateY(0); }
              50% { transform: translateY(-20px); }
            }
            h1 { color: #22c55e; margin: 0 0 10px 0; }
            p { color: #666; line-height: 1.6; }
            .user-info {
              background: #f9fafb;
              padding: 15px;
              border-radius: 8px;
              margin: 20px 0;
            }
            .btn {
              width: 100%;
              padding: 15px 30px;
              background: #667eea;
              color: white;
              border: none;
              border-radius: 8px;
              font-size: 16px;
              font-weight: 600;
              cursor: pointer;
              transition: all 0.2s;
              margin-top: 20px;
            }
            .btn:hover { background: #5a67d8; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="success-box">
              <div class="icon">✅</div>
              <h1>Calendars Saved!</h1>
              <div class="user-info">
                <strong>${updatedUser?.name || 'User'}</strong><br>
                Your calendar settings have been updated successfully
              </div>
              <button onclick="closeWindow()" class="btn">
                ← Back to Chat
              </button>
            </div>
          </div>

          <script>
            const tg = window.Telegram.WebApp;
            tg.expand();
            tg.ready();

            function closeWindow() {
              tg.close();
            }
          </script>
        </body>
      </html>
    `);
    return;
  }

  // GET: Show calendar selection screen
  try {
    const availableCalendars = await listUserCalendars(user.googleRefreshToken);
    const currentSelections = {
      primary: user.primaryCalendar || '',
      own: user.ownCalendars || [],
      spouse: user.spouseCalendars || []
    };

    // Show calendar selection HTML
    res.setHeader('Content-Type', 'text/html');
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Select Calendars</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <script src="https://telegram.org/js/telegram-web-app.js"></script>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              min-height: 100vh;
              padding: 20px;
              margin: 0;
            }
            .container {
              max-width: 600px;
              margin: 0 auto;
              background: white;
              padding: 30px;
              border-radius: 15px;
              box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            }
            h1 {
              color: #667eea;
              margin: 0 0 10px 0;
              font-size: 24px;
            }
            .subtitle {
              color: #6b7280;
              margin-bottom: 30px;
            }
            .section {
              margin-bottom: 30px;
            }
            .section-title {
              font-weight: 600;
              color: #374151;
              margin-bottom: 15px;
              font-size: 16px;
            }
            .calendar-item {
              display: flex;
              align-items: center;
              padding: 12px;
              border: 2px solid #e5e7eb;
              border-radius: 8px;
              margin-bottom: 10px;
              cursor: pointer;
              transition: all 0.2s;
            }
            .calendar-item:hover {
              border-color: #667eea;
              background: #f9fafb;
            }
            .calendar-item.selected {
              border-color: #667eea;
              background: #ede9fe;
            }
            .calendar-color {
              width: 16px;
              height: 16px;
              border-radius: 50%;
              margin-right: 12px;
              flex-shrink: 0;
            }
            .calendar-info {
              flex: 1;
            }
            .calendar-name {
              font-weight: 500;
              color: #111827;
            }
            .calendar-desc {
              font-size: 13px;
              color: #6b7280;
            }
            input[type="checkbox"],
            input[type="radio"] {
              margin-right: 12px;
              width: 18px;
              height: 18px;
              cursor: pointer;
            }
            .btn {
              width: 100%;
              padding: 15px;
              background: #667eea;
              color: white;
              border: none;
              border-radius: 8px;
              font-size: 16px;
              font-weight: 600;
              cursor: pointer;
              transition: background 0.2s;
            }
            .btn:hover {
              background: #5a67d8;
            }
            .btn:disabled {
              background: #9ca3af;
              cursor: not-allowed;
            }
            .help-text {
              font-size: 13px;
              color: #6b7280;
              margin-top: 8px;
            }
            .badge {
              display: inline-block;
              padding: 2px 8px;
              background: #dbeafe;
              color: #1e40af;
              border-radius: 4px;
              font-size: 11px;
              font-weight: 600;
              margin-left: 8px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>📅 Select Your Calendars</h1>
            <p class="subtitle">Choose which calendars to sync with your bot</p>

            <form id="calendarForm" method="POST" action="/api/select-calendars?user_id=${userId}">
              <input type="hidden" name="user_id" value="${userId}">

              <!-- Primary Calendar Selection -->
              <div class="section">
                <div class="section-title">Primary Calendar</div>
                <p class="help-text">Your main personal calendar (used as default)</p>

                ${availableCalendars.map(cal => `
                  <label class="calendar-item" onclick="selectPrimary('${cal.id}')">
                    <input
                      type="radio"
                      name="primary"
                      value="${cal.id}"
                      ${cal.id === currentSelections.primary ? 'checked' : ''}
                      ${cal.primary && !currentSelections.primary ? 'checked' : ''}
                    >
                    <div class="calendar-color" style="background-color: ${cal.backgroundColor}"></div>
                    <div class="calendar-info">
                      <div class="calendar-name">
                        ${cal.name}
                        ${cal.primary ? '<span class="badge">PRIMARY</span>' : ''}
                      </div>
                      ${cal.description ? `<div class="calendar-desc">${cal.description}</div>` : ''}
                    </div>
                  </label>
                `).join('')}
              </div>

              <!-- Own Calendars -->
              <div class="section">
                <div class="section-title">Your Calendars</div>
                <p class="help-text">Select your personal and work calendars</p>

                ${availableCalendars.map(cal => `
                  <label class="calendar-item">
                    <input
                      type="checkbox"
                      name="own_calendars"
                      value="${cal.id}"
                      ${currentSelections.own.includes(cal.id) ? 'checked' : ''}
                      ${!currentSelections.own.length && (cal.accessRole === 'owner' || cal.accessRole === 'writer') ? 'checked' : ''}
                    >
                    <div class="calendar-color" style="background-color: ${cal.backgroundColor}"></div>
                    <div class="calendar-info">
                      <div class="calendar-name">${cal.name}</div>
                      ${cal.description ? `<div class="calendar-desc">${cal.description}</div>` : ''}
                    </div>
                  </label>
                `).join('')}
              </div>

              <!-- Spouse Calendars (optional) -->
              <div class="section">
                <div class="section-title">Spouse's Calendars (Optional)</div>
                <p class="help-text">Select calendars belonging to your spouse</p>

                ${availableCalendars.map(cal => `
                  <label class="calendar-item">
                    <input
                      type="checkbox"
                      name="spouse_calendars"
                      value="${cal.id}"
                      ${currentSelections.spouse.includes(cal.id) ? 'checked' : ''}
                    >
                    <div class="calendar-color" style="background-color: ${cal.backgroundColor}"></div>
                    <div class="calendar-info">
                      <div class="calendar-name">${cal.name}</div>
                      ${cal.description ? `<div class="calendar-desc">${cal.description}</div>` : ''}
                    </div>
                  </label>
                `).join('')}
              </div>

              <button type="submit" class="btn">Save Calendar Selection</button>
            </form>
          </div>

          <script>
            const tg = window.Telegram.WebApp;
            tg.expand();
            tg.ready();

            function selectPrimary(calendarId) {
              // Auto-check in "Own Calendars" when selected as primary
              const checkbox = document.querySelector(\`input[name="own_calendars"][value="\${calendarId}"]\`);
              if (checkbox) checkbox.checked = true;
            }

            // Validate form before submission
            document.getElementById('calendarForm').addEventListener('submit', function(e) {
              const primarySelected = document.querySelector('input[name="primary"]:checked');
              const ownSelected = document.querySelectorAll('input[name="own_calendars"]:checked');

              if (!primarySelected) {
                e.preventDefault();
                alert('Please select a primary calendar');
                return false;
              }

              if (ownSelected.length === 0) {
                e.preventDefault();
                alert('Please select at least one of your calendars');
                return false;
              }
            });
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error listing calendars:', error);
    res.status(500).send(`
      <html>
        <body style="font-family: Arial; padding: 40px; text-align: center;">
          <h2>❌ Error</h2>
          <p>${error instanceof Error ? error.message : 'Unknown error'}</p>
          <p><a href="/api/select-calendars?user_id=${userId}">Try Again</a></p>
        </body>
      </html>
    `);
  }
}

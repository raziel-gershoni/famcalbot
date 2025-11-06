/**
 * Utility script to generate Google OAuth refresh tokens
 * Run: npm run get-google-token
 */

import dotenv from 'dotenv';
import { google } from 'googleapis';
import * as readline from 'readline';

// Load environment variables
dotenv.config();

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

async function main() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env');
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    'http://localhost:3000' // Web app redirect URI
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  console.log('\n=== Google Calendar OAuth Token Generator ===\n');
  console.log('IMPORTANT: Add http://localhost:3000 to Authorized redirect URIs in Google Cloud Console\n');
  console.log('1. Open this URL in your browser:\n');
  console.log(authUrl);
  console.log('\n2. Authorize the application');
  console.log('3. You will be redirected to http://localhost:3000/?code=...');
  console.log('4. Copy the CODE from the URL (everything after "code=")\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question('Enter the authorization code: ', async (code) => {
    rl.close();

    try {
      const { tokens } = await oauth2Client.getToken(code);

      console.log('\n=== SUCCESS! ===\n');
      console.log('Add this refresh token to your .env file:\n');
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
      console.log('\n');
    } catch (error) {
      console.error('Error getting tokens:', error);
      process.exit(1);
    }
  });
}

main();

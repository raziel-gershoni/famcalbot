/**
 * QStash Client Singleton
 * Lazy-initialized client for publishing messages to QStash
 */

import { Client } from '@upstash/qstash';

let client: Client | null = null;

export function getQStashClient(): Client | null {
  if (client) return client;

  const token = process.env.QSTASH_TOKEN;
  if (!token) {
    return null;
  }

  client = new Client({ token });
  return client;
}

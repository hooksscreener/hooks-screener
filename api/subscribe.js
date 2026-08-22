/**
 * Hooks Screener — Push Subscription Manager with Vercel KV persistence
 * 
 * Subscriptions survive deploys by storing in Vercel KV (key-value store)
 * Setup: vercel.com → your project → Storage → Create KV Database → connect
 * 
 * GET  /api/subscribe?action=vapid-key  → returns VAPID public key
 * POST /api/subscribe                   → saves push subscription
 * DELETE /api/subscribe                 → removes push subscription
 */

import { kv } from '@vercel/kv';

const KV_KEY = 'push_subscriptions';

async function getSubscriptions() {
  try {
    const subs = await kv.get(KV_KEY);
    return Array.isArray(subs) ? subs : [];
  } catch {
    // KV not set up yet — fall back to empty array
    return [];
  }
}

async function saveSubscriptions(subs) {
  try {
    await kv.set(KV_KEY, subs);
    return true;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const publicKey = process.env.VAPID_PUBLIC_KEY;

  // GET — return VAPID public key
  if (req.method === 'GET') {
    if (!publicKey) return res.status(500).json({ error: 'VAPID_PUBLIC_KEY not set in Vercel env vars' });
    return res.status(200).json({ publicKey });
  }

  // POST — save subscription to KV
  if (req.method === 'POST') {
    const sub = req.body;
    if (!sub?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
    const subs = await getSubscriptions();
    if (!subs.find(s => s.endpoint === sub.endpoint)) {
      subs.push(sub);
      await saveSubscriptions(subs);
    }
    console.log(`Subscription saved to KV. Total: ${subs.length}`);
    return res.status(201).json({ success: true, total: subs.length });
  }

  // DELETE — remove subscription from KV
  if (req.method === 'DELETE') {
    const { endpoint } = req.body;
    const subs = await getSubscriptions();
    const filtered = subs.filter(s => s.endpoint !== endpoint);
    await saveSubscriptions(filtered);
    return res.status(200).json({ success: true, removed: subs.length - filtered.length });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
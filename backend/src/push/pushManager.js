import webpush from 'web-push';
import { config } from '../config/index.js';

/**
 * PUSH ALARM — fires a real OS-level push notification (with sound +
 * vibration) the instant a signal reaches SIGNAL_ACTIVE, even if the
 * phone is locked or the browser tab is fully backgrounded. A plain
 * in-page <audio> alarm cannot do this on mobile — the OS suspends
 * JS timers/audio once the screen sleeps. Push notifications are
 * delivered by the OS itself, outside the page's lifecycle.
 *
 * Subscriptions are kept in memory only (no DB in this project) —
 * they're re-registered by the frontend on every app load, which is
 * fine for a single-user personal trading tool.
 */
const subscriptions = new Map(); // endpoint -> subscription object

export function isPushConfigured() {
  return Boolean(config.vapid.publicKey && config.vapid.privateKey);
}

export function initPush() {
  if (!isPushConfigured()) {
    console.log('[Push] VAPID keys not set — push alarms disabled. See /api/push/vapid-public-key.');
    return;
  }
  webpush.setVapidDetails(
    `mailto:${config.vapid.contactEmail || 'noone@example.com'}`,
    config.vapid.publicKey,
    config.vapid.privateKey
  );
}

export function addSubscription(sub) {
  if (!sub?.endpoint) return;
  subscriptions.set(sub.endpoint, sub);
}

export function removeSubscription(endpoint) {
  subscriptions.delete(endpoint);
}

/**
 * Sends the alarm to every registered device. Never throws — a
 * failed push (expired subscription, offline device) must not crash
 * the signal pipeline. Dead subscriptions are pruned automatically.
 */
export async function sendSignalAlarm({ symbol, direction, grade, strike }) {
  if (!isPushConfigured() || subscriptions.size === 0) return;

  const title = direction === 'BULLISH' ? `▲ ${symbol} — BUY CALL` : `▼ ${symbol} — BUY PUT`;
  const body = strike ? `${strike} · Grade ${grade || '—'} · Manual entry — review before acting` : `Grade ${grade || '—'} · Manual entry — review before acting`;

  const payload = JSON.stringify({ title, body, symbol, direction, grade, tag: `signal-${symbol}` });

  for (const [endpoint, sub] of subscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        subscriptions.delete(endpoint); // subscription expired/revoked
      } else {
        console.error('[Push] send failed', err.statusCode, err.message);
      }
    }
  }
}

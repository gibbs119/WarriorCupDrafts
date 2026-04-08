// ─── Firebase Cloud Messaging — client-side ───────────────────────────────────
// Registers the service worker, gets an FCM push token, and provides
// a helper to check / request notification permission.
// Works on:  Android Chrome, desktop Chrome/Firefox, iOS 16.4+ PWA (home screen)

import { getMessaging, getToken, onMessage, type Messaging } from 'firebase/messaging';
import app from './firebase';

const VAPID_KEY = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;

let messaging: Messaging | null = null;

function getMsg(): Messaging | null {
  if (typeof window === 'undefined') return null;
  if (!messaging) {
    try { messaging = getMessaging(app); } catch { return null; }
  }
  return messaging;
}

// ─── Permission status ────────────────────────────────────────────────────────

export type PushPermission = 'granted' | 'denied' | 'default' | 'unsupported';

export function getPushPermission(): PushPermission {
  if (typeof window === 'undefined') return 'unsupported';
  if (!('Notification' in window))   return 'unsupported';
  if (!('serviceWorker' in navigator)) return 'unsupported';
  return Notification.permission as PushPermission;
}

// ─── Register service worker + get FCM token ─────────────────────────────────
// Must be called from a user-gesture handler the first time (iOS requirement).
// Returns the FCM token string, or null if push is not available / denied.

export async function requestPushToken(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  if (!VAPID_KEY) {
    console.warn('[FCM] NEXT_PUBLIC_FIREBASE_VAPID_KEY not set — push disabled');
    return null;
  }
  const msg = getMsg();
  if (!msg) return null;

  try {
    // Register our dynamic service worker with root scope
    const reg = await navigator.serviceWorker.register(
      '/api/firebase-messaging-sw',
      { scope: '/', updateViaCache: 'none' }
    );

    const token = await getToken(msg, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: reg,
    });

    return token || null;
  } catch (e) {
    console.warn('[FCM] getToken failed:', e);
    return null;
  }
}

// ─── Foreground message handler ───────────────────────────────────────────────
// When the app IS in the foreground, FCM doesn't show a system notification.
// Call this to handle the payload yourself (the draft room already has in-tab banners).

export function onForegroundMessage(cb: (payload: unknown) => void): () => void {
  const msg = getMsg();
  if (!msg) return () => {};
  return onMessage(msg, cb);
}

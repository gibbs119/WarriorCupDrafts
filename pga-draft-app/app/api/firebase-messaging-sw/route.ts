// Dynamic service worker — injects Firebase config from server env vars
// so we never hardcode credentials in a public static file.
// Registered with scope '/' via the Service-Worker-Allowed header.

export async function GET() {
  const config = {
    apiKey:            process.env.NEXT_PUBLIC_FIREBASE_API_KEY            ?? '',
    authDomain:        process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN        ?? '',
    databaseURL:       process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL       ?? '',
    projectId:         process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID         ?? '',
    storageBucket:     process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET     ?? '',
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? '',
    appId:             process.env.NEXT_PUBLIC_FIREBASE_APP_ID             ?? '',
  };

  const sw = `
// Warrior Cup Drafts — FCM background push handler
// Auto-generated — do not edit manually.

importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

firebase.initializeApp(${JSON.stringify(config)});

const messaging = firebase.messaging();

// Background push handler — fires when app is closed or tab is hidden
messaging.onBackgroundMessage(function(payload) {
  const n     = payload.notification ?? {};
  const title = n.title ?? 'Warrior Cup Drafts';
  const body  = n.body  ?? '';
  const url   = (payload.data && payload.data.url) ? payload.data.url : '/dashboard';

  self.registration.showNotification(title, {
    body,
    icon:  '/favicon.ico',
    badge: '/favicon.ico',
    tag:   'draft-notification',      // replaces previous draft notif instead of stacking
    renotify: true,                   // still vibrate/sound even if tag matches
    data: { url },
  });
});

// Tapping notification opens the draft room
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : '/dashboard';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
`;

  return new Response(sw, {
    headers: {
      'Content-Type':          'application/javascript; charset=utf-8',
      'Service-Worker-Allowed': '/',
      'Cache-Control':          'no-store',
    },
  });
}

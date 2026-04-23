import admin from 'firebase-admin';

// ─── Inicializacion unica de Firebase Admin ─────────────────────────────────
// Soporta 2 formatos de variables de entorno:
// 1) FIREBASE_SERVICE_ACCOUNT: JSON completo como string (usado por notifications.js)
// 2) FIREBASE_PROJECT_ID + FIREBASE_PRIVATE_KEY + FIREBASE_CLIENT_EMAIL: vars individuales
if (!admin.apps.length) {
  try {
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;

    if (serviceAccount) {
      // Formato 1: JSON completo
      const credentials = JSON.parse(serviceAccount);
      admin.initializeApp({
        credential: admin.credential.cert(credentials),
      });
    } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
      // Formato 2: Variables individuales
      admin.initializeApp({
        credential: admin.credential.cert({
          project_id: process.env.FIREBASE_PROJECT_ID,
          private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
          private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          client_email: process.env.FIREBASE_CLIENT_EMAIL,
        }),
      });
    } else {
      console.warn('[Firebase] No configurado. Notificaciones push deshabilitadas.');
    }
  } catch (err) {
    console.error('[Firebase] Error inicializando:', err.message);
  }
}

const isInitialized = admin.apps.length > 0;

export { admin, isInitialized };
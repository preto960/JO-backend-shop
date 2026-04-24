// ─── Configuracion de OneSignal ───────────────────────────────────────────────
// Variables de entorno requeridas:
//   ONESIGNAL_REST_API_KEY  →  Clave REST API de OneSignal
//   ONESIGNAL_APP_ID         →  App ID de la app en OneSignal

const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY || '';
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || '';
const ONESIGNAL_API_URL = 'https://onesignal.com/api/v1/notifications';

const isConfigured = !!(ONESIGNAL_REST_API_KEY && ONESIGNAL_APP_ID);

if (!isConfigured) {
  console.warn('[OneSignal] No configurado. Agrega ONESIGNAL_REST_API_KEY y ONESIGNAL_APP_ID a las variables de entorno.');
}

export {
  ONESIGNAL_REST_API_KEY,
  ONESIGNAL_APP_ID,
  ONESIGNAL_API_URL,
  isConfigured,
};

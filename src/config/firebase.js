// ─── firebase.js - DEPRECADO ────────────────────────────────────────────────
// Firebase Admin ha sido reemplazado por OneSignal REST API.
// Se mantiene como stub vacio para evitar errores de importacion.
//
// Si firebase-admin ya no se usa en ningun otro lugar, puede eliminarse
// del package.json con: npm uninstall firebase-admin
//
// Las nuevas credenciales requeridas son:
//   ONESIGNAL_REST_API_KEY  -> REST API Key de OneSignal
//   ONESIGNAL_APP_ID         -> App ID de la app en OneSignal
//
// Ver src/config/onesignal.js para la configuracion activa.

console.warn(
  '[Deprecado] Firebase ya no se usa para notificaciones. ' +
  'Las push notifications ahora usan OneSignal (ver src/config/onesignal.js)'
);

const admin = { apps: [] };
const isInitialized = false;

export { admin, isInitialized };

// ─── pushNotifications.js - DEPRECADO ────────────────────────────────────────
// Este archivo ha sido reemplazado por onesignal.js y notifications.js.
// Se mantiene como alias vacio para evitar errores de importacion si
// alguna otra parte del codigo lo referencia.
//
// Toda la funcionalidad de push ahora usa OneSignal:
//   - src/services/onesignal.js  -> Envio via OneSignal REST API
//   - src/services/notifications.js -> Logica de negocio (mantiene la misma API)
//   - src/config/onesignal.js     -> Configuracion de credenciales

console.warn(
  '[Deprecado] pushNotifications.js ha sido reemplazado por OneSignal. ' +
  'Actualiza las importaciones a usar src/services/notifications.js'
);

export async function saveUserToken() {
  console.warn('[Deprecado] saveUserToken ya no es necesario. OneSignal.login() maneja la asociacion del dispositivo.');
}

export async function sendPushToUser() {
  console.warn('[Deprecado] Usa sendToUser() de src/services/notifications.js');
}

export async function sendPushToMany() {
  console.warn('[Deprecado] Usa sendToRole() de src/services/notifications.js');
}

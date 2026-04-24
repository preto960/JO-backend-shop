// ─── OneSignal REST API Service ──────────────────────────────────────────────
// Wrapper para la API REST de OneSignal v1.
// Maneja el envio de notificaciones push usando external_user_ids (IDs de la DB).

import {
  ONESIGNAL_REST_API_KEY,
  ONESIGNAL_APP_ID,
  ONESIGNAL_API_URL,
  isConfigured,
} from '../config/onesignal.js';

/**
 * Enviar una notificacion via OneSignal REST API.
 *
 * @param {Object} options
 * @param {string} options.title    - Titulo de la notificacion
 * @param {string} options.body     - Cuerpo de la notificacion
 * @param {Object} [options.data]   - Datos adicionales (se pasan como additional_data)
 * @param {string[]} options.includeExternalUserIds - IDs de usuarios en nuestra DB
 * @param {string[]} [options.includePlayerIds]     - IDs de dispositivos OneSignal
 * @param {string}   [options.tag]     - Para agrupar notificaciones (reemplaza duplicados)
 * @param {string}   [options.smallIcon] - Icono pequeño de Android
 * @param {string}   [options.largeIcon] - Icono grande de Android
 * @returns {Promise<Object>} Resultado: { success, id, recipients, error }
 */
export async function sendNotification({
  title,
  body,
  data = {},
  includeExternalUserIds = [],
  includePlayerIds = [],
  tag = null,
  smallIcon = 'ic_stat_onesignal_default',
  largeIcon = 'ic_launcher',
}) {
  if (!isConfigured) {
    console.warn('[OneSignal] No configurado. La notificacion no se enviara.');
    return { success: false, reason: 'not_configured' };
  }

  // Construir payload base
  const payload = {
    app_id: ONESIGNAL_APP_ID,
    headings: { es: title, en: title },
    contents: { es: body, en: body },
    data: {
      ...data,
      type: data.type || 'general',
      click_action: data.type || 'general',
    },
    android_small_icon: smallIcon,
    android_large_icon: largeIcon,
    android_group: tag || undefined,
    ios_badgeType: 'Increase',
    ios_badgeCount: 1,
  };

  // Targeting: external_user_ids o player_ids
  if (includeExternalUserIds.length > 0) {
    payload.include_external_user_ids = includeExternalUserIds;
  }
  if (includePlayerIds.length > 0) {
    payload.include_player_ids = includePlayerIds;
  }

  // Si no hay destinatarios, abortar
  if (!includeExternalUserIds.length && !includePlayerIds.length) {
    console.warn('[OneSignal] No se especificaron destinatarios.');
    return { success: false, reason: 'no_recipients' };
  }

  // Limpiar undefined values
  Object.keys(payload).forEach(key => {
    if (payload[key] === undefined || payload[key] === null) {
      delete payload[key];
    }
  });

  try {
    const response = await fetch(ONESIGNAL_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Basic ${ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();

    if (!response.ok) {
      const errorMsg = result.errors?.join(', ') || JSON.stringify(result);
      console.error(`[OneSignal] Error ${response.status}: ${errorMsg}`);
      return { success: false, error: errorMsg, statusCode: response.status };
    }

    const recipients = result.recipients || 0;
    console.log(`[OneSignal] Notificacion enviada. ID: ${result.id} | Destinatarios: ${recipients}`);

    return {
      success: true,
      id: result.id,
      recipients,
      externalId: result.external_id,
    };
  } catch (err) {
    console.error(`[OneSignal] Error de conexion: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Cancelar una notificacion programada.
 *
 * @param {string} notificationId - ID de la notificacion en OneSignal
 * @returns {Promise<boolean>}
 */
export async function cancelNotification(notificationId) {
  if (!isConfigured || !notificationId) return false;

  try {
    const response = await fetch(`${ONESIGNAL_API_URL}/${notificationId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Basic ${ONESIGNAL_REST_API_KEY}`,
      },
    });
    return response.ok;
  } catch (err) {
    console.error(`[OneSignal] Error cancelando notificacion ${notificationId}: ${err.message}`);
    return false;
  }
}

export default {
  sendNotification,
  cancelNotification,
  isConfigured,
};

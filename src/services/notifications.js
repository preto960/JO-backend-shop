// ─── Servicio de Notificaciones (OneSignal) ──────────────────────────────────
// Migrado desde Firebase FCM a OneSignal.
// Usa OneSignal REST API via include_external_user_ids (IDs de la DB).
// La app cliente llama OneSignal.login(userId) al iniciar sesion, lo que
// asocia el dispositivo con el external_id. El backend no necesita almacenar
// tokens FCM; OneSignal maneja la relacion internamente.

import oneSignal from './onesignal.js';
import prisma from '../lib/prisma.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

// Obtener IDs de usuarios con un rol especifico
// Para el rol 'delivery', solo incluye usuarios conectados (isOnline = true)
async function getUserIdsByRole(roleName) {
  const where = {
    active: true,
    roles: { some: { role: { name: roleName } } },
    // Solo filtrar isOnline para deliverys
    ...(roleName === 'delivery' ? { isOnline: true } : {}),
  };
  const users = await prisma.user.findMany({
    where,
    select: { id: true },
  });
  return users.map(u => String(u.id));
}

// ─── Enviar notificacion push a un usuario especifico ────────────────────────

/**
 * Enviar notificacion a un usuario por su ID en la base de datos.
 * OneSignal usa include_external_user_ids para targeting directo.
 *
 * @param {number} userId - ID del usuario en la DB
 * @param {Object} options
 * @param {string} options.title - Titulo de la notificacion
 * @param {string} options.body  - Cuerpo de la notificacion
 * @param {Object} [options.data] - Datos adicionales para la app
 * @param {string} [options.tag]  - Tag para agrupar (reemplaza duplicados)
 */
export async function sendToUser(userId, { title, body, data = {}, tag = null }) {
  try {
    const result = await oneSignal.sendNotification({
      title,
      body,
      data: {
        ...data,
        notifTag: tag || `notif_${Date.now()}`,
      },
      includeExternalUserIds: [String(userId)],
      tag,
    });

    if (!result.success && result.reason !== 'not_configured') {
      console.warn(`[Notifications] Fallo al enviar a user ${userId}: ${JSON.stringify(result)}`);
    } else {
      console.log(`[Notifications] Enviada a user ${userId}: ${result.success ? 'ok' : 'simulada (no configurada)'}`);
    }

    return result;
  } catch (err) {
    console.error('[Notifications] Error enviando a usuario:', err.message);
    return { success: false, error: err.message };
  }
}

// ─── Enviar notificacion a todos los usuarios con un rol ─────────────────────

/**
 * Enviar notificacion a todos los usuarios activos que tienen un rol especifico.
 *
 * @param {string} roleName - Nombre del rol (admin, editor, delivery)
 * @param {Object} options - Mismas opciones que sendToUser
 */
export async function sendToRole(roleName, { title, body, data = {}, tag = null }) {
  try {
    const userIds = await getUserIdsByRole(roleName);
    if (userIds.length === 0) {
      console.log(`[Notifications] No se encontraron usuarios activos con rol "${roleName}"`);
      return { success: false, reason: 'no_users' };
    }

    const result = await oneSignal.sendNotification({
      title,
      body,
      data: {
        ...data,
        notifTag: tag || `notif_${Date.now()}`,
      },
      includeExternalUserIds: userIds,
      tag,
    });

    console.log(`[Notifications] Enviada a rol ${roleName} (${userIds.length} usuarios): ${result.recipients ?? 0} entregados`);
    return result;
  } catch (err) {
    console.error('[Notifications] Error enviando a rol:', err.message);
    return { success: false, error: err.message };
  }
}

// ─── HELPERS ESPECIFICOS PARA EVENTOS DE ORDENES ────────────────────────────

/**
 * Nuevo pedido creado -> notificar a admins, editors y deliverys.
 * Cada rol recibe informacion diferente (los deliverys ven mas detalle).
 */
export async function notifyNewOrder(order) {
  const promises = [];
  const orderId = String(order.id);
  const notifTag = `order_${orderId}`;

  // Construir lista de productos para la notificacion del delivery
  const itemsList = (order.items || []).slice(0, 6).map(
    (item, idx) => `${idx + 1}. ${item.productName} x${item.quantity}`
  ).join('\n');
  const remainingItems = (order.items || []).length - 6;
  const itemsSuffix = remainingItems > 0 ? `\n... y ${remainingItems} producto(s) mas` : '';
  const itemsBlock = itemsList + itemsSuffix;

  // Formatear total
  const totalFormatted = Number(order.total || 0).toFixed(2);

  // Notificar a admins
  promises.push(
    sendToRole('admin', {
      title: 'Nuevo pedido recibido',
      body: `Pedido #${orderId} - ${order.customerName} - ${order.totalItems} producto(s)`,
      data: {
        type: 'new_order',
        orderId,
        screen: 'AdminOrders',
      },
      tag: notifTag,
    })
  );

  // Notificar a editors
  promises.push(
    sendToRole('editor', {
      title: 'Nuevo pedido recibido',
      body: `Pedido #${orderId} - ${order.customerName}`,
      data: {
        type: 'new_order',
        orderId,
      },
      tag: notifTag,
    })
  );

  // Notificar a todos los deliverys con detalle completo de la orden
  promises.push(
    sendToRole('delivery', {
      title: `Nuevo pedido #${orderId} disponible`,
      body: `Cliente: ${order.customerName || 'Cliente'}\n${itemsBlock}\nTotal: ${totalFormatted}\nDir: ${order.customerAddr || 'Sin direccion'}`,
      data: {
        type: 'new_order',
        orderId,
        screen: 'DeliveryOrders',
        highlightOrderId: orderId,
      },
      tag: notifTag,
    })
  );

  await Promise.allSettled(promises);
}

// Delivery asignado -> notificar al delivery
export async function notifyDeliveryAssigned(order, deliveryName) {
  await sendToUser(order.deliveryId, {
    title: 'Nuevo pedido asignado',
    body: `Pedido #${order.id} - ${order.customerName} - Dir: ${order.customerAddr || 'Sin direccion'}`,
    data: {
      type: 'delivery_assigned',
      orderId: String(order.id),
      screen: 'DeliveryOrders',
      highlightOrderId: String(order.id),
    },
    tag: `order_${order.id}`,
  });
}

// Pedido aceptado por delivery -> notificar al cliente
export async function notifyOrderAccepted(order, deliveryName) {
  if (!order.userId) return;
  await sendToUser(order.userId, {
    title: 'Pedido en camino',
    body: `Tu pedido #${order.id} fue aceptado por ${deliveryName || 'un repartidor'}`,
    data: {
      type: 'order_accepted',
      orderId: String(order.id),
      screen: 'MyOrders',
      expandOrderId: String(order.id),
    },
    tag: `order_${order.id}`,
  });
}

// Estado del pedido cambiado -> notificar al cliente
export async function notifyOrderStatusChange(order, newStatus) {
  if (!order.userId) return;

  const statusMessages = {
    confirmed: 'Tu pedido ha sido confirmado y esta siendo preparado',
    preparing: 'Tu pedido esta siendo preparado',
    shipped: 'Tu pedido esta en camino',
    delivered: 'Tu pedido ha sido entregado',
    cancelled: 'Tu pedido ha sido cancelado',
  };

  const statusTitles = {
    confirmed: 'Pedido confirmado',
    preparing: 'Preparando tu pedido',
    shipped: 'Pedido en camino',
    delivered: 'Pedido entregado',
    cancelled: 'Pedido cancelado',
  };

  const message = statusMessages[newStatus] || `El estado de tu pedido ha cambiado a ${newStatus}`;
  const title = statusTitles[newStatus] || 'Actualizacion de pedido';

  await sendToUser(order.userId, {
    title,
    body: `Pedido #${order.id} - ${message}`,
    data: {
      type: 'order_status_change',
      orderId: String(order.id),
      newStatus,
      screen: 'MyOrders',
      expandOrderId: String(order.id),
    },
    tag: `order_${order.id}`,
  });
}

export default {
  sendToUser,
  sendToRole,
  notifyNewOrder,
  notifyDeliveryAssigned,
  notifyOrderAccepted,
  notifyOrderStatusChange,
};

import { admin, isInitialized as firebaseReady } from '../config/firebase.js';
import prisma from '../lib/prisma.js';

// Verificar si FCM esta disponible
function isFcmAvailable() {
  return firebaseReady && admin.apps.length > 0;
}

// Obtener tokens de un usuario
async function getUserTokens(userId) {
  const tokens = await prisma.pushToken.findMany({
    where: { userId },
    select: { token: true, platform: true },
  });
  return tokens;
}

// Obtener tokens de todos los usuarios con un rol especifico
async function getTokensByRole(roleName) {
  const users = await prisma.user.findMany({
    where: {
      active: true,
      roles: { some: { role: { name: roleName } } },
    },
    select: { id: true },
  });

  if (users.length === 0) return [];

  const tokens = await prisma.pushToken.findMany({
    where: { userId: { in: users.map(u => u.id) } },
    select: { token: true, platform: true },
  });
  return tokens;
}

// Enviar notificacion push a un usuario especifico
export async function sendToUser(userId, { title, body, data = {} }) {
  if (!isFcmAvailable()) {
    console.log(`[Notifications] FCM no disponible. Notificacion simulada para user ${userId}: "${title}"`);
    return { success: false, reason: 'fcm_not_configured' };
  }

  try {
    const tokens = await getUserTokens(userId);
    if (tokens.length === 0) {
      return { success: false, reason: 'no_tokens' };
    }

    const tokenList = tokens.map(t => t.token);

    const message = {
      notification: { title, body },
      data: {
        ...data,
        type: data.type || 'general',
        click_action: data.type || 'general',
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'joshop_orders',
          priority: 'high',
        },
      },
      tokens: tokenList,
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    const successCount = response.successCount;
    const failureCount = response.failureCount;

    // Limpiar tokens invalidos
    if (failureCount > 0) {
      const invalidTokens = response.responses
        .filter((r, i) => !r.success && r.error?.code === 'messaging/registration-token-not-registered')
        .map((_, i) => tokenList[i]);

      if (invalidTokens.length > 0) {
        await prisma.pushToken.deleteMany({
          where: { token: { in: invalidTokens } },
        });
      }
    }

    console.log(`[Notifications] Enviada a user ${userId}: ${successCount} exito, ${failureCount} fallo`);
    return { success: successCount > 0, successCount, failureCount };
  } catch (err) {
    console.error('[Notifications] Error enviando a usuario:', err.message);
    return { success: false, error: err.message };
  }
}

// Enviar notificacion a todos los usuarios con un rol
export async function sendToRole(roleName, { title, body, data = {} }) {
  if (!isFcmAvailable()) {
    console.log(`[Notifications] FCM no disponible. Notificacion simulada para rol ${roleName}: "${title}"`);
    return { success: false, reason: 'fcm_not_configured' };
  }

  try {
    const tokens = await getTokensByRole(roleName);
    if (tokens.length === 0) {
      return { success: false, reason: 'no_tokens' };
    }

    const tokenList = tokens.map(t => t.token);

    const message = {
      notification: { title, body },
      data: {
        ...data,
        type: data.type || 'general',
        click_action: data.type || 'general',
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'joshop_orders',
          priority: 'high',
        },
      },
      tokens: tokenList,
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    const successCount = response.successCount;
    const failureCount = response.failureCount;

    // Limpiar tokens invalidos
    if (failureCount > 0) {
      const invalidTokens = response.responses
        .filter((r, i) => !r.success && r.error?.code === 'messaging/registration-token-not-registered')
        .map((_, i) => tokenList[i]);

      if (invalidTokens.length > 0) {
        await prisma.pushToken.deleteMany({
          where: { token: { in: invalidTokens } },
        });
      }
    }

    console.log(`[Notifications] Enviada a rol ${roleName} (${tokenList.length} tokens): ${successCount} exito, ${failureCount} fallo`);
    return { success: successCount > 0, successCount, failureCount };
  } catch (err) {
    console.error('[Notifications] Error enviando a rol:', err.message);
    return { success: false, error: err.message };
  }
}

// ─── HELPERS ESPECIFICOS PARA EVENTOS DE ORDENES ────────────────────────

// Nuevo pedido creado → notificar a admins, editors y deliverys
export async function notifyNewOrder(order) {
  const promises = [];

  // Notificar a admins
  promises.push(
    sendToRole('admin', {
      title: 'Nuevo pedido recibido',
      body: `Pedido #${order.id} - ${order.customerName} - ${order.totalItems} producto(s)`,
      data: {
        type: 'new_order',
        orderId: String(order.id),
        screen: 'AdminOrders',
      },
    })
  );

  // Notificar a editors
  promises.push(
    sendToRole('editor', {
      title: 'Nuevo pedido recibido',
      body: `Pedido #${order.id} - ${order.customerName}`,
      data: {
        type: 'new_order',
        orderId: String(order.id),
      },
    })
  );

  // Notificar a todos los deliverys (para que vean el pedido disponible)
  promises.push(
    sendToRole('delivery', {
      title: 'Nuevo pedido disponible',
      body: `Pedido #${order.id} - ${order.customerName} - ${order.totalItems} producto(s) - ${order.customerAddr || 'Sin direccion'}`,
      data: {
        type: 'new_order',
        orderId: String(order.id),
        screen: 'DeliveryOrders',
      },
    })
  );

  await Promise.allSettled(promises);
}

// Delivery asignado → notificar al delivery
export async function notifyDeliveryAssigned(order, deliveryName) {
  await sendToUser(order.deliveryId, {
    title: 'Nuevo pedido asignado',
    body: `Pedido #${order.id} - ${order.customerName} - Dir: ${order.customerAddr || 'Sin direccion'}`,
    data: {
      type: 'delivery_assigned',
      orderId: String(order.id),
      screen: 'DeliveryOrders',
    },
  });
}

// Pedido aceptado por delivery → notificar al cliente
export async function notifyOrderAccepted(order, deliveryName) {
  if (!order.userId) return;
  await sendToUser(order.userId, {
    title: 'Pedido en camino',
    body: `Tu pedido #${order.id} fue aceptado por ${deliveryName || 'un repartidor'}`,
    data: {
      type: 'order_accepted',
      orderId: String(order.id),
      screen: 'MyOrders',
    },
  });
}

// Estado del pedido cambiado → notificar al cliente
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
    },
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

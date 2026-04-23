import { admin, isInitialized } from '../config/firebase.js';

// Este archivo usa Firestore para guardar tokens.
// NOTA: push.js ahora usa Prisma directamente (tabla push_tokens),
// asi que este archivo es un backup/complemento. Solo funciona si
// Firebase esta inicializado correctamente.

function getMessaging() {
  if (!isInitialized) return null;
  return admin.messaging();
}

// Guardar token FCM de un usuario en Firestore
export async function saveUserToken(userId, fcmToken, platform) {
  if (!isInitialized) return;
  try {
    const firestore = admin.firestore();
    await firestore.collection('userTokens').doc(String(userId)).set({
      fcmToken,
      platform,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error('[Push] Error guardando token en Firestore:', error.message);
  }
}

// Enviar notificacion a un usuario especifico
export async function sendPushToUser(userId, title, body, data = {}) {
  const messaging = getMessaging();
  if (!messaging) return false;

  try {
    const firestore = admin.firestore();
    const tokenDoc = await firestore.collection('userTokens').doc(String(userId)).get();
    if (!tokenDoc.exists) {
      console.log(`[Push] No se encontro token para usuario ${userId}`);
      return false;
    }

    const { fcmToken } = tokenDoc.data();

    const message = {
      notification: { title, body },
      data,
      token: fcmToken,
      android: {
        notification: {
          sound: 'default',
          channelId: 'joshop_orders',
        },
      },
    };

    await messaging.send(message);
    console.log('[Push] Notificacion enviada');
    return true;
  } catch (error) {
    console.error('[Push] Error enviando notificacion:', error.message);
    return false;
  }
}

// Enviar notificacion a multiples usuarios
export async function sendPushToMany(userIds, title, body, data = {}) {
  const messaging = getMessaging();
  if (!messaging) return false;

  try {
    const firestore = admin.firestore();

    const tokens = [];
    for (const userId of userIds) {
      const doc = await firestore.collection('userTokens').doc(String(userId)).get();
      if (doc.exists) {
        tokens.push(doc.data().fcmToken);
      }
    }

    if (tokens.length === 0) {
      console.log('[Push] No se encontraron tokens para los usuarios');
      return false;
    }

    const message = {
      notification: { title, body },
      data,
      tokens,
      android: {
        notification: {
          sound: 'default',
          channelId: 'joshop_orders',
        },
      },
    };

    const response = await messaging.sendEachForMulticast(message);
    console.log(`[Push] ${response.successCount} exitosas, ${response.failureCount} fallidas`);
    return response.successCount > 0;
  } catch (error) {
    console.error('[Push] Error enviando notificacion:', error.message);
    return false;
  }
}
import { messaging } from '../config/firebase.js';

// Guardar token FCM de un usuario
export async function saveUserToken(userId, fcmToken, platform) {
  // Aquí puedes guardar en tu base de datos de Firebase o en Prisma
  // Por ahora lo guardamos en Firestore
  const { default: admin } = await import('firebase-admin');
  const firestore = admin.firestore();
  
  await firestore.collection('userTokens').doc(userId).set({
    fcmToken,
    platform,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// Enviar notificación a un usuario específico
export async function sendPushToUser(userId, title, body, data = {}) {
  try {
    const { default: admin } = await import('firebase-admin');
    const firestore = admin.firestore();
    
    const tokenDoc = await firestore.collection('userTokens').doc(userId).get();
    if (!tokenDoc.exists) {
      console.log(`[Push] No se encontró token para usuario ${userId}`);
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
          channelId: 'joshop-notifications',
        },
      },
    };

    const response = await messaging.send(message);
    console.log('[Push] Notificación enviada:', response);
    return true;
  } catch (error) {
    console.error('[Push] Error enviando notificación:', error);
    return false;
  }
}

// Enviar notificación a múltiples usuarios
export async function sendPushToMany(userIds, title, body, data = {}) {
  const { default: admin } = await import('firebase-admin');
  const firestore = admin.firestore();
  
  const tokens = [];
  for (const userId of userIds) {
    const doc = await firestore.collection('userTokens').doc(userId).get();
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
    tokens, // máx 500 tokens por envío
    android: {
      notification: {
        sound: 'default',
        channelId: 'joshop-notifications',
      },
    },
  };

  const response = await messaging.sendEachForMulticast(message);
  console.log(`[Push] ${response.successCount} exitosas, ${response.failureCount} fallidas`);
  return response.successCount > 0;
}
// ─── Rutas de Notificaciones (OneSignal) ─────────────────────────────────────
// Migrado desde FCM a OneSignal.
//
// Con OneSignal, el flujo es:
//   1. La app llama OneSignal.login(userId) al iniciar sesion
//   2. OneSignal asocia el dispositivo con el external_id automaticamente
//   3. El backend envia notificaciones usando include_external_user_ids
//
// Estas rutas se mantienen por compatibilidad (guardar/eliminar tokens en la DB
// como referencia) pero el envio real usa OneSignal con external_user_ids.

import express from 'express';
import prisma from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// POST /notifications/token - Registrar token/push ID del dispositivo
// Con OneSignal, el token puede ser el player_id o subscription_id del dispositivo.
// Se guarda en la DB para referencia y debugging, pero el envio se hace via external_id.
router.post('/token', authenticate, async (req, res, next) => {
  try {
    const { token, platform } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'El token es requerido' });
    }

    // Upsert: crear o actualizar el token existente
    const pushToken = await prisma.pushToken.upsert({
      where: {
        userId_token: {
          userId: req.user.id,
          token: token,
        },
      },
      create: {
        userId: req.user.id,
        token: token,
        platform: platform || 'android',
      },
      update: {
        platform: platform || 'android',
      },
    });

    res.json({
      message: 'Token registrado correctamente',
      pushToken: { id: pushToken.id, platform: pushToken.platform },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /notifications/token - Eliminar token (logout del dispositivo)
router.delete('/token', authenticate, async (req, res, next) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'El token es requerido' });
    }

    await prisma.pushToken.deleteMany({
      where: {
        userId: req.user.id,
        token: token,
      },
    });

    res.json({ message: 'Token eliminado correctamente' });
  } catch (err) {
    next(err);
  }
});

// DELETE /notifications/tokens - Eliminar todos los tokens del usuario (logout total)
router.delete('/tokens', authenticate, async (req, res, next) => {
  try {
    const result = await prisma.pushToken.deleteMany({
      where: { userId: req.user.id },
    });

    res.json({
      message: 'Todos los tokens eliminados',
      count: result.count,
    });
  } catch (err) {
    next(err);
  }
});

export default router;

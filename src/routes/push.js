import express from 'express';
import prisma from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Registrar token FCM del usuario
router.post('/register', authenticate, async (req, res, next) => {
  try {
    const { fcmToken, platform } = req.body;

    if (!fcmToken) {
      return res.status(400).json({ error: 'El token es requerido' });
    }

    // Upsert: crear o actualizar el token existente
    const pushToken = await prisma.pushToken.upsert({
      where: {
        userId_token: {
          userId: req.user.id,
          token: fcmToken,
        },
      },
      create: {
        userId: req.user.id,
        token: fcmToken,
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

// Eliminar token FCM (logout)
router.delete('/token', authenticate, async (req, res, next) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'El token es requerido' });
    }

    await prisma.pushToken.deleteMany({
      where: { userId: req.user.id, token },
    });

    res.json({ message: 'Token eliminado correctamente' });
  } catch (err) {
    next(err);
  }
});

export default router;

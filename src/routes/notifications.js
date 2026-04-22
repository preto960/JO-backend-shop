import express from 'express';
import prisma from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// POST /notifications/token - Registrar token FCM del dispositivo
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

// DELETE /notifications/token - Eliminar token FCM (logout)
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

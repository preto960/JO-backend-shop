import express from 'express';
import { saveUserToken } from '../services/pushNotifications.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Registrar token FCM del usuario
router.post('/register', authenticateToken, async (req, res) => {
  try {
    const { fcmToken, platform } = req.body;
    const userId = req.user.id;

    if (!fcmToken) {
      return res.status(400).json({ error: 'fcmToken es requerido' });
    }

    await saveUserToken(userId, fcmToken, platform || 'android');
    res.json({ message: 'Token registrado exitosamente' });
  } catch (error) {
    console.error('[Push] Error registrando token:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
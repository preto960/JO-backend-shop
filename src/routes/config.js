import express from 'express';
import prisma from '../lib/prisma.js';
import { authenticate, hasRole } from '../middleware/auth.js';

const router = express.Router();

// GET /config - Obtener configuración del sistema (público)
router.get('/', async (req, res, next) => {
  try {
    const configs = await prisma.systemConfig.findMany();
    const configMap = {};
    for (const c of configs) {
      configMap[c.key] = c.value;
    }
    res.json(configMap);
  } catch (err) {
    next(err);
  }
});

// PUT /config - Actualizar configuración del sistema (solo admin)
router.put('/', authenticate, async (req, res, next) => {
  try {
    if (!req.user || !req.user.roles.includes('admin')) {
      return res.status(403).json({ error: 'Solo administradores pueden modificar la configuración' });
    }

    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'Se requiere un objeto "settings" con la configuración' });
    }

    const results = {};
    for (const [key, value] of Object.entries(settings)) {
      const strValue = String(value);
      const upserted = await prisma.systemConfig.upsert({
        where: { key },
        update: { value: strValue },
        create: { key, value: strValue },
      });
      results[key] = upserted.value;
    }

    res.json({
      message: 'Configuración actualizada',
      settings: results,
    });
  } catch (err) {
    next(err);
  }
});

export default router;

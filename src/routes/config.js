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

      const existing = await prisma.systemConfig.findUnique({
        where: { key },
      });

      let saved;
      if (existing) {
        saved = await prisma.systemConfig.update({
          where: { key },
          data: { value: strValue },
        });
      } else {
        // Si la DB tiene id fijo en 1 y ya existe una fila, usar el máximo + 1
        const maxId = await prisma.systemConfig.aggregate({
          _max: { id: true },
        });
        const nextId = (maxId._max.id || 0) + 1;

        saved = await prisma.systemConfig.create({
          data: {
            id: nextId,
            key,
            value: strValue,
          },
        });
      }

      results[key] = saved.value;
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

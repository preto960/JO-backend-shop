import express from 'express';
import multer from 'multer';
import { put } from '@vercel/blob';
import prisma from '../lib/prisma.js';
import { authenticate, hasRole } from '../middleware/auth.js';

// Multer config for logo upload (in-memory)
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/svg+xml',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de archivo no permitido. Solo se aceptan JPG, PNG, WebP y SVG.'));
    }
  },
});

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

// POST /config/upload-logo - Subir logo del shop a Vercel Blob (solo admin)
router.post('/upload-logo', authenticate, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.user || !req.user.roles.includes('admin')) {
      return res.status(403).json({ error: 'Solo administradores pueden modificar la configuración' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No se envió ningún archivo' });
    }

    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (!blobToken) {
      return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN no configurado' });
    }

    // Sanitize filename: remove spaces and special chars
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const blobName = `config_shop/${Date.now()}-${safeName}`;

    // Upload directly using @vercel/blob SDK (put)
    const blob = await put(blobName, req.file.buffer, {
      access: 'public',
      contentType: req.file.mimetype,
      addRandomSuffix: false,
    });

    // Save the download URL to SystemConfig
    await upsertConfig('shop_logo_url', blob.url);

    res.json({
      success: true,
      url: blob.url,
      message: 'Logo actualizado',
    });
  } catch (err) {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'El archivo excede el límite de 2MB' });
      }
    }
    next(err);
  }
});

// DELETE /config/upload-logo - Eliminar logo del shop (solo admin)
router.delete('/upload-logo', authenticate, async (req, res, next) => {
  try {
    if (!req.user || !req.user.roles.includes('admin')) {
      return res.status(403).json({ error: 'Solo administradores pueden modificar la configuración' });
    }

    await upsertConfig('shop_logo_url', '');

    res.json({ success: true, message: 'Logo eliminado' });
  } catch (err) {
    next(err);
  }
});

// Helper: upsert a SystemConfig entry
async function upsertConfig(key, value) {
  const existing = await prisma.systemConfig.findUnique({ where: { key } });

  if (existing) {
    return prisma.systemConfig.update({
      where: { key },
      data: { value },
    });
  }

  const maxId = await prisma.systemConfig.aggregate({ _max: { id: true } });
  const nextId = (maxId._max.id || 0) + 1;

  return prisma.systemConfig.create({
    data: { id: nextId, key, value },
  });
}

export default router;

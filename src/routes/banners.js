import express from 'express';
import multer from 'multer';
import { put, del } from '@vercel/blob';
import prisma from '../lib/prisma.js';
import { authenticate, hasRole } from '../middleware/auth.js';

// Multer config for banner upload (in-memory)
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de archivo no permitido. Solo se aceptan JPG, PNG, WebP, GIF, MP4 y WebM.'));
    }
  },
});

const router = express.Router();

// GET /banners - Obtener banners activos (público)
router.get('/', async (req, res, next) => {
  try {
    const banners = await prisma.banner.findMany({
      where: { active: true },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        imageUrl: true,
        mediaType: true,
        link: true,
        duration: true,
        sortOrder: true,
      },
    });
    res.json(banners);
  } catch (err) {
    next(err);
  }
});

// GET /banners/all - Obtener todos los banners (admin)
router.get('/all', authenticate, async (req, res, next) => {
  try {
    if (!req.user || !req.user.roles.includes('admin')) {
      return res.status(403).json({ error: 'Solo administradores' });
    }
    const banners = await prisma.banner.findMany({
      orderBy: { sortOrder: 'asc' },
      includeDeleted: true,
    });
    res.json(banners);
  } catch (err) {
    next(err);
  }
});

// POST /banners - Crear banner (admin) - subir archivo a Vercel Blob
router.post('/', authenticate, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.user || !req.user.roles.includes('admin')) {
      return res.status(403).json({ error: 'Solo administradores pueden crear banners' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No se envió ningún archivo' });
    }

    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (!blobToken) {
      return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN no configurado' });
    }

    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const blobName = `banners/${Date.now()}-${safeName}`;

    const blob = await put(blobName, req.file.buffer, {
      access: 'public',
      contentType: req.file.mimetype,
      addRandomSuffix: false,
    });

    // Determinar media type
    const isVideo = req.file.mimetype.startsWith('video/');
    const mediaType = isVideo ? 'video' : 'image';

    // Obtener el último sortOrder para ponerlo al final
    const lastBanner = await prisma.banner.findFirst({
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    const nextOrder = (lastBanner?.sortOrder || 0) + 1;

    const banner = await prisma.banner.create({
      data: {
        imageUrl: blob.url,
        mediaType,
        link: req.body.link || null,
        duration: parseInt(req.body.duration) || 4,
        sortOrder: nextOrder,
        active: true,
      },
    });

    res.status(201).json({
      success: true,
      banner,
      message: 'Banner creado correctamente',
    });
  } catch (err) {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'El archivo excede el límite de 5MB' });
      }
    }
    next(err);
  }
});

// PUT /banners/:id - Actualizar banner (admin)
router.put('/:id', authenticate, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.user || !req.user.roles.includes('admin')) {
      return res.status(403).json({ error: 'Solo administradores pueden modificar banners' });
    }

    const bannerId = parseInt(req.params.id);
    const existing = await prisma.banner.findUnique({ where: { id: bannerId } });
    if (!existing) {
      return res.status(404).json({ error: 'Banner no encontrado' });
    }

    const updateData = {};

    // Si se subió un nuevo archivo, reemplazar en Vercel Blob
    if (req.file) {
      const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
      if (!blobToken) {
        return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN no configurado' });
      }

      // Eliminar archivo anterior del Blob
      try { await del(existing.imageUrl); } catch {}

      const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      const blobName = `banners/${Date.now()}-${safeName}`;

      const blob = await put(blobName, req.file.buffer, {
        access: 'public',
        contentType: req.file.mimetype,
        addRandomSuffix: false,
      });

      const isVideo = req.file.mimetype.startsWith('video/');
      updateData.imageUrl = blob.url;
      updateData.mediaType = isVideo ? 'video' : 'image';
    }

    // Actualizar campos de texto
    if (req.body.link !== undefined) updateData.link = req.body.link || null;
    if (req.body.duration !== undefined) updateData.duration = parseInt(req.body.duration) || 4;
    if (req.body.active !== undefined) updateData.active = req.body.active === 'true' || req.body.active === true;
    if (req.body.sortOrder !== undefined) updateData.sortOrder = parseInt(req.body.sortOrder) || 0;

    const banner = await prisma.banner.update({
      where: { id: bannerId },
      data: updateData,
    });

    res.json({
      success: true,
      banner,
      message: 'Banner actualizado',
    });
  } catch (err) {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'El archivo excede el límite de 5MB' });
      }
    }
    next(err);
  }
});

// DELETE /banners/:id - Eliminar banner (soft delete, admin)
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    if (!req.user || !req.user.roles.includes('admin')) {
      return res.status(403).json({ error: 'Solo administradores pueden eliminar banners' });
    }

    const bannerId = parseInt(req.params.id);
    const banner = await prisma.banner.findUnique({ where: { id: bannerId } });
    if (!banner) {
      return res.status(404).json({ error: 'Banner no encontrado' });
    }

    // Soft delete: marcar como eliminado en vez de borrar
    const now = new Date();
    await prisma.banner.update({
      where: { id: bannerId },
      data: {
        deletedAt: now,
        deletedBy: req.user.id,
        active: false,
      },
    });

    // Eliminar del Vercel Blob (el archivo sí se borra del storage)
    try { await del(banner.imageUrl); } catch {}

    res.json({ success: true, message: 'Banner eliminado' });
  } catch (err) {
    next(err);
  }
});

export default router;

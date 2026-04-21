import express from 'express';
import prisma from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';
import { sanitize } from '../services/auth.js';

const router = express.Router();

// GET /addresses - Listar direcciones del usuario autenticado
router.get('/', authenticate, async (req, res, next) => {
  try {
    const addresses = await prisma.address.findMany({
      where: { userId: req.user.id },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });

    res.json({ data: addresses });
  } catch (err) {
    next(err);
  }
});

// POST /addresses - Crear dirección
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { label, address, city, notes, lat, lng, isDefault } = req.body;

    if (!label || label.trim().length < 2) {
      return res.status(400).json({ error: 'Etiqueta requerida (mínimo 2 caracteres)', field: 'label' });
    }

    if (!address || address.trim().length < 5) {
      return res.status(400).json({ error: 'Dirección requerida (mínimo 5 caracteres)', field: 'address' });
    }

    const sanitizedLabel = sanitize(label).substring(0, 100);
    const sanitizedAddress = sanitize(address);

    // Si es la primera dirección, marcarla como predeterminada
    const existingCount = await prisma.address.count({ where: { userId: req.user.id } });
    const makeDefault = isDefault === true || existingCount === 0;

    // Si se marca como predeterminada, quitar default de las otras
    if (makeDefault) {
      await prisma.address.updateMany({
        where: { userId: req.user.id, isDefault: true },
        data: { isDefault: false },
      });
    }

    const newAddress = await prisma.address.create({
      data: {
        userId: req.user.id,
        label: sanitizedLabel,
        address: sanitizedAddress,
        city: city ? sanitize(city) : null,
        notes: notes ? sanitize(notes) : null,
        lat: lat ? parseFloat(lat) : null,
        lng: lng ? parseFloat(lng) : null,
        isDefault: makeDefault,
      },
    });

    res.status(201).json({
      message: 'Dirección creada exitosamente',
      address: newAddress,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /addresses/:id - Actualizar dirección
router.put('/:id', authenticate, async (req, res, next) => {
  try {
    const addressId = parseInt(req.params.id);
    const { label, address, city, notes, lat, lng, isDefault } = req.body;

    const existing = await prisma.address.findUnique({ where: { id: addressId } });
    if (!existing) {
      return res.status(404).json({ error: 'Dirección no encontrada' });
    }

    // Verificar que la dirección pertenece al usuario
    if (existing.userId !== req.user.id) {
      return res.status(403).json({ error: 'No tienes permisos para editar esta dirección' });
    }

    const updateData = {};

    if (label !== undefined) {
      const sanitizedLabel = sanitize(label).substring(0, 100);
      if (sanitizedLabel.length < 2) {
        return res.status(400).json({ error: 'Etiqueta debe tener al menos 2 caracteres', field: 'label' });
      }
      updateData.label = sanitizedLabel;
    }

    if (address !== undefined) {
      const sanitizedAddress = sanitize(address);
      if (sanitizedAddress.length < 5) {
        return res.status(400).json({ error: 'Dirección debe tener al menos 5 caracteres', field: 'address' });
      }
      updateData.address = sanitizedAddress;
    }

    if (city !== undefined) updateData.city = sanitize(city) || null;
    if (notes !== undefined) updateData.notes = sanitize(notes) || null;
    if (lat !== undefined) updateData.lat = lat ? parseFloat(lat) : null;
    if (lng !== undefined) updateData.lng = lng ? parseFloat(lng) : null;

    if (isDefault === true) {
      await prisma.address.updateMany({
        where: { userId: req.user.id, isDefault: true },
        data: { isDefault: false },
      });
      updateData.isDefault = true;
    }

    const updated = await prisma.address.update({
      where: { id: addressId },
      data: updateData,
    });

    res.json({
      message: 'Dirección actualizada',
      address: updated,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /addresses/:id/default - Marcar como dirección predeterminada
router.put('/:id/default', authenticate, async (req, res, next) => {
  try {
    const addressId = parseInt(req.params.id);

    const existing = await prisma.address.findUnique({ where: { id: addressId } });
    if (!existing) {
      return res.status(404).json({ error: 'Dirección no encontrada' });
    }

    if (existing.userId !== req.user.id) {
      return res.status(403).json({ error: 'No tienes permisos para modificar esta dirección' });
    }

    await prisma.address.updateMany({
      where: { userId: req.user.id, isDefault: true },
      data: { isDefault: false },
    });

    const updated = await prisma.address.update({
      where: { id: addressId },
      data: { isDefault: true },
    });

    res.json({
      message: 'Dirección marcada como predeterminada',
      address: updated,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /addresses/:id - Eliminar dirección
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const addressId = parseInt(req.params.id);

    const existing = await prisma.address.findUnique({ where: { id: addressId } });
    if (!existing) {
      return res.status(404).json({ error: 'Dirección no encontrada' });
    }

    if (existing.userId !== req.user.id) {
      return res.status(403).json({ error: 'No tienes permisos para eliminar esta dirección' });
    }

    const wasDefault = existing.isDefault;

    await prisma.address.delete({ where: { id: addressId } });

    // Si era la predeterminada, hacer predeterminada a la más reciente
    if (wasDefault) {
      const nextDefault = await prisma.address.findFirst({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
      });
      if (nextDefault) {
        await prisma.address.update({
          where: { id: nextDefault.id },
          data: { isDefault: true },
        });
      }
    }

    res.json({ message: 'Dirección eliminada correctamente' });
  } catch (err) {
    next(err);
  }
});

export default router;

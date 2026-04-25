import express from 'express';
import prisma from '../lib/prisma.js';
import { authenticate, requirePermission, optionalAuth } from '../middleware/auth.js';
import { sanitize } from '../services/auth.js';

const router = express.Router();

// GET /stores - Listar tiendas (público con auth opcional)
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const { page = 1, limit = 20, active } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {};

    // Solo admin ve tiendas inactivas
    if (req.user && req.user.roles.includes('admin')) {
      if (active !== undefined) {
        where.active = active === 'true';
      }
    } else {
      where.active = true;
    }

    const [stores, total] = await Promise.all([
      prisma.store.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit),
        include: {
          owner: { select: { id: true, name: true, email: true } },
          _count: { select: { products: true } },
        },
      }),
      prisma.store.count({ where }),
    ]);

    res.json({
      data: stores,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /stores/my-store - Obtener la tienda del editor autenticado
// IMPORTANTE: Esta ruta debe ir ANTES de /:id para no ser capturada como parámetro
router.get('/my-store', authenticate, async (req, res, next) => {
  try {
    const store = await prisma.store.findUnique({
      where: { ownerId: req.user.id },
      include: {
        _count: { select: { products: true, assignedUsers: true } },
      },
    });

    if (!store) {
      return res.status(404).json({ error: 'No tienes una tienda asociada' });
    }

    res.json(store);
  } catch (err) {
    next(err);
  }
});

// GET /stores/:id - Detalle de tienda
router.get('/:id', async (req, res, next) => {
  try {
    const store = await prisma.store.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        owner: { select: { id: true, name: true, email: true, phone: true } },
        products: {
          where: { active: true },
          take: 20,
          orderBy: { createdAt: 'desc' },
          include: { category: { select: { id: true, name: true } } },
        },
        _count: { select: { products: true } },
      },
    });

    if (!store) {
      return res.status(404).json({ error: 'Tienda no encontrada' });
    }

    res.json(store);
  } catch (err) {
    next(err);
  }
});

// POST /stores - Crear tienda (requiere permiso stores.create o rol editor)
router.post('/', authenticate, async (req, res, next) => {
  try {
    const isAdmin = req.user.roles.includes('admin');
    const hasPerm = req.user.permissions.includes('stores.create');
    const isEditor = req.user.roles.includes('editor');

    if (!isAdmin && !hasPerm && !isEditor) {
      return res.status(403).json({ error: 'No tienes permisos para crear tiendas' });
    }

    // Un editor solo puede tener una tienda
    if (!isAdmin) {
      const existingStore = await prisma.store.findUnique({
        where: { ownerId: req.user.id },
      });
      if (existingStore) {
        return res.status(400).json({ error: 'Ya tienes una tienda asociada. Solo puedes tener una.' });
      }
    }

    const { name, description, logo, phone, address, ownerId, active } = req.body;

    if (!name || name.trim().length < 2) {
      return res.status(400).json({ error: 'Nombre de la tienda requerido (mínimo 2 caracteres)', field: 'name' });
    }

    const slug = sanitize(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    const existingSlug = await prisma.store.findUnique({ where: { slug } });
    const finalSlug = existingSlug ? `${slug}-${Date.now()}` : slug;

    // Si es editor, forzar ownerId a su propio ID
    const targetOwnerId = (!isAdmin && isEditor) ? req.user.id : (ownerId ? parseInt(ownerId) : req.user.id);

    const store = await prisma.store.create({
      data: {
        name: sanitize(name),
        slug: finalSlug,
        description: description ? sanitize(description) : null,
        logo: logo || null,
        phone: phone || null,
        address: address || null,
        active: active !== undefined ? Boolean(active) : true,
        ownerId: targetOwnerId,
      },
      include: {
        owner: { select: { id: true, name: true, email: true } },
      },
    });

    res.status(201).json({
      message: 'Tienda creada exitosamente',
      store,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /stores/:id - Actualizar tienda
router.put('/:id', authenticate, async (req, res, next) => {
  try {
    const isAdmin = req.user.roles.includes('admin');
    const hasPerm = req.user.permissions.includes('stores.edit');
    const isEditor = req.user.roles.includes('editor');

    if (!isAdmin && !hasPerm && !isEditor) {
      return res.status(403).json({ error: 'No tienes permisos para editar tiendas' });
    }

    const storeId = parseInt(req.params.id);
    const store = await prisma.store.findUnique({ where: { id: storeId } });
    if (!store) {
      return res.status(404).json({ error: 'Tienda no encontrada' });
    }

    // Editor solo puede editar su propia tienda
    if (!isAdmin && store.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Solo puedes editar tu propia tienda' });
    }

    const { name, description, logo, phone, address, active } = req.body;
    const updateData = {};

    if (name !== undefined) {
      if (name.trim().length < 2) {
        return res.status(400).json({ error: 'Nombre debe tener al menos 2 caracteres', field: 'name' });
      }
      updateData.name = sanitize(name);
      const newSlug = sanitize(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      updateData.slug = newSlug;
    }
    if (description !== undefined) updateData.description = sanitize(description) || null;
    if (logo !== undefined) updateData.logo = logo || null;
    if (phone !== undefined) updateData.phone = phone || null;
    if (address !== undefined) updateData.address = address || null;
    if (active !== undefined) updateData.active = Boolean(active);

    const updated = await prisma.store.update({
      where: { id: storeId },
      data: updateData,
      include: {
        owner: { select: { id: true, name: true, email: true } },
      },
    });

    res.json({
      message: 'Tienda actualizada',
      store: updated,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /stores/:id - Eliminar tienda (solo admin)
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const isAdmin = req.user.roles.includes('admin');
    const hasPerm = req.user.permissions.includes('stores.delete');

    if (!isAdmin && !hasPerm) {
      return res.status(403).json({ error: 'Solo admin puede eliminar tiendas' });
    }

    const storeId = parseInt(req.params.id);
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      include: { _count: { select: { products: true } } },
    });

    if (!store) {
      return res.status(404).json({ error: 'Tienda no encontrada' });
    }

    if (store._count.products > 0) {
      return res.status(400).json({
        error: `No se puede eliminar la tienda. Tiene ${store._count.products} producto(s) asociado(s). Elimina o reasigna los productos primero.`,
      });
    }

    await prisma.store.delete({ where: { id: storeId } });

    res.json({ message: 'Tienda eliminada correctamente' });
  } catch (err) {
    next(err);
  }
});

export default router;

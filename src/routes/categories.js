import express from 'express';
import prisma from '../lib/prisma.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { sanitize } from '../services/auth.js';

const router = express.Router();

// GET /categories - Listar categorías (público)
router.get('/', async (req, res, next) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: { products: { where: { active: true } } },
        },
      },
    });

    res.json(categories);
  } catch (err) {
    next(err);
  }
});

// GET /categories/:id - Detalle de categoría
router.get('/:id', async (req, res, next) => {
  try {
    const category = await prisma.category.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        _count: { select: { products: true } },
        products: {
          where: { active: true },
          take: 10,
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!category) {
      return res.status(404).json({ error: 'Categoría no encontrada' });
    }

    res.json(category);
  } catch (err) {
    next(err);
  }
});

// POST /categories - Crear categoría (requiere permiso categories.create)
router.post('/', authenticate, requirePermission('categories.create'), async (req, res, next) => {
  try {
    const { name, image } = req.body;

    if (!name || name.trim().length < 2) {
      return res.status(400).json({ error: 'Nombre requerido (mínimo 2 caracteres)', field: 'name' });
    }

    const slug = sanitize(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    const existing = await prisma.category.findFirst({
      where: { OR: [{ name: sanitize(name) }, { slug }] },
    });

    if (existing) {
      return res.status(409).json({
        error: existing.name === sanitize(name) ? 'Ya existe una categoría con ese nombre' : 'El slug ya está en uso',
        field: 'name',
      });
    }

    const category = await prisma.category.create({
      data: {
        name: sanitize(name),
        slug,
        image: image || null,
      },
    });

    res.status(201).json({
      message: 'Categoría creada exitosamente',
      category,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /categories/:id - Actualizar categoría (requiere permiso categories.edit)
router.put('/:id', authenticate, requirePermission('categories.edit'), async (req, res, next) => {
  try {
    const categoryId = parseInt(req.params.id);

    const category = await prisma.category.findUnique({ where: { id: categoryId } });
    if (!category) {
      return res.status(404).json({ error: 'Categoría no encontrada' });
    }

    const { name, image } = req.body;
    const updateData = {};

    if (name !== undefined) {
      if (name.trim().length < 2) {
        return res.status(400).json({ error: 'Nombre debe tener al menos 2 caracteres', field: 'name' });
      }
      const newName = sanitize(name);
      const duplicate = await prisma.category.findFirst({
        where: { name: newName, id: { not: categoryId } },
      });
      if (duplicate) {
        return res.status(409).json({ error: 'Ya existe una categoría con ese nombre', field: 'name' });
      }
      updateData.name = newName;
      updateData.slug = newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    if (image !== undefined) updateData.image = image || null;

    const updated = await prisma.category.update({
      where: { id: categoryId },
      data: updateData,
    });

    res.json({
      message: 'Categoría actualizada',
      category: updated,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /categories/:id - Eliminar categoría (soft delete)
router.delete('/:id', authenticate, requirePermission('categories.delete'), async (req, res, next) => {
  try {
    const categoryId = parseInt(req.params.id);

    const category = await prisma.category.findUnique({
      where: { id: categoryId },
      include: { _count: { select: { products: true } } },
    });

    if (!category) {
      return res.status(404).json({ error: 'Categoría no encontrada' });
    }

    if (category._count.products > 0) {
      return res.status(409).json({
        error: `No se puede eliminar la categoría porque tiene ${category._count.products} producto(s) asociado(s). Elimina o reasigna los productos primero.`,
      });
    }

    await prisma.category.update({
      where: { id: categoryId },
      data: {
        deletedAt: new Date(),
        deletedBy: req.user.id,
      },
    });

    res.json({ message: 'Categoría eliminada correctamente' });
  } catch (err) {
    next(err);
  }
});

export default router;

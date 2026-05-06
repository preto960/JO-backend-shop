import express from 'express';
import prisma from '../lib/prisma.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { sanitize } from '../services/auth.js';

const router = express.Router();

// GET /product-batches - Listar lotes con sus productos
router.get('/', authenticate, requirePermission('batches.view'), async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const where = {};
    if (status) where.status = status;

    const [batches, total] = await Promise.all([
      prisma.productBatch.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit),
        include: {
          createdByUser: { select: { id: true, name: true } },
          items: {
            include: {
              product: {
                select: { id: true, name: true, price: true, discountPercent: true, image: true },
              },
            },
          },
        },
      }),
      prisma.productBatch.count({ where }),
    ]);

    res.json({
      data: batches,
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

// GET /product-batches/:id - Detalle de lote con productos
router.get('/:id', authenticate, requirePermission('batches.view'), async (req, res, next) => {
  try {
    const batch = await prisma.productBatch.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        createdByUser: { select: { id: true, name: true } },
        items: {
          include: {
            product: {
              include: {
                category: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });
    if (!batch) {
      return res.status(404).json({ error: 'Lote no encontrado' });
    }
    res.json(batch);
  } catch (err) {
    next(err);
  }
});

// POST /product-batches - Crear lote con productos existentes
// Selecciona productos existentes y les aplica el descuento
router.post('/', authenticate, requirePermission('batches.create'), async (req, res, next) => {
  try {
    const { name, description, discountPercent, productIds } = req.body;

    if (!name || name.trim().length < 2) {
      return res.status(400).json({ error: 'Nombre del lote requerido (minimo 2 caracteres)', field: 'name' });
    }
    if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ error: 'Debe seleccionar al menos un producto', field: 'productIds' });
    }
    const discount = discountPercent !== undefined ? parseFloat(discountPercent) : 0;
    if (discount < 0 || discount > 100) {
      return res.status(400).json({ error: 'Descuento debe estar entre 0 y 100', field: 'discountPercent' });
    }

    // Verificar que los productos existen
    const existingProducts = await prisma.product.findMany({
      where: { id: { in: productIds.map(id => parseInt(id)) } },
      select: { id: true },
    });
    if (existingProducts.length !== productIds.length) {
      return res.status(400).json({ error: 'Uno o mas productos no encontrados', field: 'productIds' });
    }
    const validProductIds = existingProducts.map(p => p.id);

    // Crear el lote
    const batch = await prisma.productBatch.create({
      data: {
        name: sanitize(name),
        description: description ? sanitize(description) : null,
        discountPercent: discount,
        productCount: validProductIds.length,
        status: 'active',
        createdBy: req.user.id,
        items: {
          create: validProductIds.map(productId => ({ productId })),
        },
      },
      include: {
        createdByUser: { select: { id: true, name: true } },
        items: {
          include: {
            product: { select: { id: true, name: true, price: true, discountPercent: true } },
          },
        },
      },
    });

    // Aplicar el descuento a todos los productos seleccionados
    await prisma.product.updateMany({
      where: { id: { in: validProductIds } },
      data: { discountPercent: discount },
    });

    res.status(201).json({
      message: `Lote creado con ${validProductIds.length} productos, descuento ${discount}% aplicado`,
      batch,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /product-batches/:id - Actualizar lote (cambiar descuento, agregar/quitar productos)
router.put('/:id', authenticate, requirePermission('batches.edit'), async (req, res, next) => {
  try {
    const batchId = parseInt(req.params.id);
    const { name, description, discountPercent, productIds } = req.body;

    const batch = await prisma.productBatch.findUnique({
      where: { id: batchId },
      include: { items: { select: { productId: true } } },
    });
    if (!batch) {
      return res.status(404).json({ error: 'Lote no encontrado' });
    }
    if (batch.status !== 'active') {
      return res.status(400).json({ error: 'Solo se pueden editar lotes activos' });
    }

    const updateData = {};
    let newDiscount = batch.discountPercent;

    if (name !== undefined) {
      if (name.trim().length < 2) {
        return res.status(400).json({ error: 'Nombre debe tener al menos 2 caracteres', field: 'name' });
      }
      updateData.name = sanitize(name);
    }
    if (description !== undefined) {
      updateData.description = sanitize(description) || null;
    }
    if (discountPercent !== undefined) {
      const val = parseFloat(discountPercent);
      if (val < 0 || val > 100) {
        return res.status(400).json({ error: 'Descuento debe estar entre 0 y 100', field: 'discountPercent' });
      }
      newDiscount = val;
      updateData.discountPercent = val;
    }

    // Manejar cambio de productos
    if (productIds !== undefined && Array.isArray(productIds)) {
      const validProductIds = productIds.map(id => parseInt(id));

      // Verificar que los productos existen
      const existingProducts = await prisma.product.findMany({
        where: { id: { in: validProductIds } },
        select: { id: true },
      });
      if (existingProducts.length !== validProductIds.length) {
        return res.status(400).json({ error: 'Uno o mas productos no encontrados', field: 'productIds' });
      }

      const oldProductIds = batch.items.map(i => i.productId);
      const addedIds = validProductIds.filter(id => !oldProductIds.includes(id));
      const removedIds = oldProductIds.filter(id => !validProductIds.includes(id));

      // Resetear descuento a productos que se quitaron del lote
      if (removedIds.length > 0) {
        await prisma.product.updateMany({
          where: { id: { in: removedIds } },
          data: { discountPercent: 0 },
        });
      }

      // Eliminar items viejos y crear nuevos
      await prisma.productBatchItem.deleteMany({ where: { batchId } });
      await prisma.productBatchItem.createMany({
        data: validProductIds.map(productId => ({ batchId, productId })),
      });
      updateData.productCount = validProductIds.length;

      // Aplicar descuento a los productos actuales del lote
      await prisma.product.updateMany({
        where: { id: { in: validProductIds } },
        data: { discountPercent: newDiscount },
      });
    } else if (discountPercent !== undefined) {
      // Solo se cambio el descuento, aplicarlo a todos los productos del lote
      const currentProductIds = batch.items.map(i => i.productId);
      await prisma.product.updateMany({
        where: { id: { in: currentProductIds } },
        data: { discountPercent: newDiscount },
      });
    }

    const updated = await prisma.productBatch.update({
      where: { id: batchId },
      data: updateData,
      include: {
        createdByUser: { select: { id: true, name: true } },
        items: {
          include: {
            product: { select: { id: true, name: true, price: true, discountPercent: true } },
          },
        },
      },
    });

    res.json({
      message: 'Lote actualizado correctamente',
      batch: updated,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /product-batches/:id - Eliminar lote (soft delete) y resetear descuentos
router.delete('/:id', authenticate, requirePermission('batches.delete'), async (req, res, next) => {
  try {
    const batchId = parseInt(req.params.id);

    const batch = await prisma.productBatch.findUnique({
      where: { id: batchId },
      include: { items: { select: { productId: true } } },
    });
    if (!batch) {
      return res.status(404).json({ error: 'Lote no encontrado' });
    }

    // Resetear descuento a 0 en todos los productos del lote
    const productIds = batch.items.map(i => i.productId);
    if (productIds.length > 0) {
      await prisma.product.updateMany({
        where: { id: { in: productIds } },
        data: { discountPercent: 0 },
      });
    }

    // Eliminar los items del lote
    await prisma.productBatchItem.deleteMany({ where: { batchId } });

    // Soft delete del lote
    await prisma.productBatch.update({
      where: { id: batchId },
      data: {
        deletedAt: new Date(),
        deletedBy: req.user.id,
        status: 'deleted',
      },
    });

    res.json({
      message: 'Lote eliminado. Descuentos reseteados a 0% en los productos asociados.',
    });
  } catch (err) {
    next(err);
  }
});

export default router;

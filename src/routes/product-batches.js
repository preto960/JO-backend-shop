import express from 'express';
import prisma from '../lib/prisma.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { sanitize } from '../services/auth.js';

const router = express.Router();

// GET /product-batches - Listar lotes
router.get('/', authenticate, requirePermission('product_batches.view'), async (req, res, next) => {
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
          category: { select: { id: true, name: true } },
          createdByUser: { select: { id: true, name: true } },
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

// GET /product-batches/:id - Detalle de lote
router.get('/:id', authenticate, requirePermission('product_batches.view'), async (req, res, next) => {
  try {
    const batch = await prisma.productBatch.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        category: { select: { id: true, name: true } },
        createdByUser: { select: { id: true, name: true } },
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

// POST /product-batches - Crear lote y generar productos
router.post('/', authenticate, requirePermission('product_batches.create'), async (req, res, next) => {
  try {
    const { name, description, discountPercent, categoryId, storeIds, products } = req.body;

    if (!name || name.trim().length < 2) {
      return res.status(400).json({ error: 'Nombre del lote requerido (mínimo 2 caracteres)', field: 'name' });
    }
    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'Debe incluir al menos un producto', field: 'products' });
    }
    if (discountPercent !== undefined && (parseFloat(discountPercent) < 0 || parseFloat(discountPercent) > 100)) {
      return res.status(400).json({ error: 'Descuento debe estar entre 0 y 100', field: 'discountPercent' });
    }

    const discount = discountPercent !== undefined ? parseFloat(discountPercent) : 0;
    const catId = categoryId ? parseInt(categoryId) : null;

    // Validate category if provided
    if (catId) {
      const category = await prisma.category.findUnique({ where: { id: catId } });
      if (!category) {
        return res.status(404).json({ error: 'Categoría no encontrada', field: 'categoryId' });
      }
    }

    // Validate store IDs if provided
    let targetStoreIds = [];
    if (storeIds && Array.isArray(storeIds) && storeIds.length > 0) {
      const stores = await prisma.store.findMany({
        where: { id: { in: storeIds.map(id => parseInt(id)) } },
      });
      if (stores.length !== storeIds.length) {
        return res.status(400).json({ error: 'Una o más tiendas no encontradas', field: 'storeIds' });
      }
      targetStoreIds = storeIds.map(id => parseInt(id));
    } else {
      // Auto-assign editor's stores
      const isEditor = req.user.roles.includes('editor') && !req.user.roles.includes('admin');
      if (isEditor) {
        const userStores = await prisma.userStore.findMany({
          where: { userId: req.user.id },
          select: { storeId: true },
        });
        targetStoreIds = userStores.map(s => s.storeId);
      }
    }

    // Create batch
    const batch = await prisma.productBatch.create({
      data: {
        name: sanitize(name),
        description: description ? sanitize(description) : null,
        discountPercent: discount,
        categoryId: catId,
        storeIds: targetStoreIds.length > 0 ? JSON.stringify(targetStoreIds) : null,
        productCount: products.length,
        status: 'completed',
        deletedBy: req.user.id,
      },
      include: {
        category: { select: { id: true, name: true } },
        createdByUser: { select: { id: true, name: true } },
      },
    });

    // Create all products from the batch
    const createdProducts = [];
    for (const item of products) {
      if (!item.name || item.name.trim().length < 2) continue;
      const price = parseFloat(item.price) || 0;
      const slug = sanitize(item.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const existingSlug = await prisma.product.findUnique({ where: { slug } });
      const finalSlug = existingSlug ? `${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` : slug;

      const product = await prisma.product.create({
        data: {
          name: sanitize(item.name),
          slug: finalSlug,
          description: item.description ? sanitize(item.description) : null,
          price,
          discountPercent: discount,
          image: item.image || null,
          thumbnail: item.thumbnail || null,
          stock: parseInt(item.stock) || 0,
          active: true,
          categoryId: catId,
          stores: {
            create: targetStoreIds.map(storeId => ({ storeId })),
          },
        },
        include: { category: true },
      });
      createdProducts.push(product);
    }

    // Update batch productCount with actual created count
    await prisma.productBatch.update({
      where: { id: batch.id },
      data: { productCount: createdProducts.length },
    });

    res.status(201).json({
      message: `Lote creado con ${createdProducts.length} productos`,
      batch,
      products: createdProducts,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /product-batches/:id - Soft delete lote
router.delete('/:id', authenticate, requirePermission('product_batches.delete'), async (req, res, next) => {
  try {
    const batch = await prisma.productBatch.findUnique({
      where: { id: parseInt(req.params.id) },
    });
    if (!batch) {
      return res.status(404).json({ error: 'Lote no encontrado' });
    }

    await prisma.productBatch.update({
      where: { id: parseInt(req.params.id) },
      data: {
        deletedAt: new Date(),
        deletedBy: req.user.id,
      },
    });

    res.json({ message: 'Lote eliminado correctamente' });
  } catch (err) {
    next(err);
  }
});

export default router;

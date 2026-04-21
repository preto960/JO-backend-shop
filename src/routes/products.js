import express from 'express';
import prisma from '../lib/prisma.js';
import { authenticate, requirePermission, optionalAuth } from '../middleware/auth.js';
import { sanitize } from '../services/auth.js';

const router = express.Router();

// GET /products - Listar productos (lectura pública para auth optional)
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const { page = 1, limit = 20, category, sort = 'newest', active } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {};
    if (req.user && req.user.roles.includes('admin')) {
      if (active !== undefined) {
        where.active = active === 'true';
      }
    } else {
      where.active = true;
    }

    if (category) {
      where.categoryId = parseInt(category);
    }

    let orderBy = { createdAt: 'desc' };
    if (sort === 'price_asc') orderBy = { price: 'asc' };
    if (sort === 'price_desc') orderBy = { price: 'desc' };
    if (sort === 'name') orderBy = { name: 'asc' };

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy,
        skip,
        take: parseInt(limit),
        include: { category: { select: { id: true, name: true } } },
      }),
      prisma.product.count({ where }),
    ]);

    res.json({
      data: products,
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

// GET /products/search?q=query - Buscar productos
router.get('/search', optionalAuth, async (req, res, next) => {
  try {
    const { q, category, page = 1, limit = 20 } = req.query;

    if (!q || q.trim().length === 0) {
      return res.status(400).json({ error: 'Parámetro de búsqueda "q" es requerido' });
    }

    const where = {
      active: true,
      OR: [
        { name: { contains: q.trim(), mode: 'insensitive' } },
        { description: { contains: q.trim(), mode: 'insensitive' } },
      ],
    };

    if (category) {
      where.categoryId = parseInt(category);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit),
        include: { category: { select: { id: true, name: true } } },
      }),
      prisma.product.count({ where }),
    ]);

    res.json({
      data: products,
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

// GET /products/:id - Detalle de producto
router.get('/:id', async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { category: { select: { id: true, name: true, slug: true } } },
    });

    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    res.json(product);
  } catch (err) {
    next(err);
  }
});

// POST /products - Crear producto (requiere permiso products.create)
router.post('/', authenticate, requirePermission('products.create'), async (req, res, next) => {
  try {
    const { name, description, price, image, thumbnail, stock, categoryId, active } = req.body;

    if (!name || name.trim().length < 2) {
      return res.status(400).json({ error: 'Nombre del producto requerido (mínimo 2 caracteres)', field: 'name' });
    }
    if (price === undefined || price === null || parseFloat(price) < 0) {
      return res.status(400).json({ error: 'Precio válido requerido', field: 'price' });
    }
    if (categoryId === undefined || categoryId === null) {
      return res.status(400).json({ error: 'Categoría requerida', field: 'categoryId' });
    }

    const category = await prisma.category.findUnique({ where: { id: parseInt(categoryId) } });
    if (!category) {
      return res.status(404).json({ error: 'Categoría no encontrada', field: 'categoryId' });
    }

    const slug = sanitize(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    const existingSlug = await prisma.product.findUnique({ where: { slug } });
    const finalSlug = existingSlug ? `${slug}-${Date.now()}` : slug;

    const product = await prisma.product.create({
      data: {
        name: sanitize(name),
        slug: finalSlug,
        description: description ? sanitize(description) : null,
        price: parseFloat(price),
        image: image || null,
        thumbnail: thumbnail || null,
        stock: parseInt(stock) || 0,
        active: active !== undefined ? Boolean(active) : true,
        categoryId: parseInt(categoryId),
      },
      include: { category: true },
    });

    res.status(201).json({
      message: 'Producto creado exitosamente',
      product,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /products/:id - Actualizar producto (requiere permiso products.edit)
router.put('/:id', authenticate, requirePermission('products.edit'), async (req, res, next) => {
  try {
    const productId = parseInt(req.params.id);

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    const { name, description, price, image, thumbnail, stock, categoryId, active } = req.body;
    const updateData = {};

    if (name !== undefined) {
      if (name.trim().length < 2) {
        return res.status(400).json({ error: 'Nombre debe tener al menos 2 caracteres', field: 'name' });
      }
      updateData.name = sanitize(name);
      const newSlug = sanitize(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      updateData.slug = newSlug;
    }

    if (description !== undefined) {
      updateData.description = sanitize(description) || null;
    }

    if (price !== undefined) {
      if (parseFloat(price) < 0) {
        return res.status(400).json({ error: 'Precio no puede ser negativo', field: 'price' });
      }
      updateData.price = parseFloat(price);
    }

    if (image !== undefined) updateData.image = image || null;
    if (thumbnail !== undefined) updateData.thumbnail = thumbnail || null;
    if (stock !== undefined) updateData.stock = parseInt(stock);
    if (active !== undefined) updateData.active = Boolean(active);

    if (categoryId !== undefined) {
      const category = await prisma.category.findUnique({ where: { id: parseInt(categoryId) } });
      if (!category) {
        return res.status(404).json({ error: 'Categoría no encontrada', field: 'categoryId' });
      }
      updateData.categoryId = parseInt(categoryId);
    }

    const updated = await prisma.product.update({
      where: { id: productId },
      data: updateData,
      include: { category: true },
    });

    res.json({
      message: 'Producto actualizado',
      product: updated,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /products/:id - Eliminar producto (requiere permiso products.delete)
router.delete('/:id', authenticate, requirePermission('products.delete'), async (req, res, next) => {
  try {
    const productId = parseInt(req.params.id);

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    await prisma.product.delete({ where: { id: productId } });

    res.json({ message: 'Producto eliminado correctamente' });
  } catch (err) {
    next(err);
  }
});

export default router;

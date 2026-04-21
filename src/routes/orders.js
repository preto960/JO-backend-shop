import express from 'express';
import prisma from '../lib/prisma.js';

const router = express.Router();

// GET /orders - Listar pedidos
router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {};
    if (status) {
      where.status = status;
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit),
        include: { items: true },
      }),
      prisma.order.count({ where }),
    ]);

    res.json({
      data: orders,
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

// GET /orders/:id - Detalle de pedido
router.get('/:id', async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { items: true },
    });

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    res.json(order);
  } catch (err) {
    next(err);
  }
});

// POST /orders - Crear pedido
router.post('/', async (req, res, next) => {
  try {
    const { customer, items, total, totalItems } = req.body;

    if (!customer || !customer.name || !customer.phone) {
      return res.status(400).json({
        error: 'Datos del cliente son requeridos (nombre y teléfono)',
      });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: 'El pedido debe contener al menos un producto',
      });
    }

    // Crear pedido con sus items en una transacción
    const order = await prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          customerName: customer.name,
          customerPhone: customer.phone,
          customerAddr: customer.address || null,
          total: parseFloat(total) || 0,
          totalItems: parseInt(totalItems) || 0,
          status: 'pending',
          items: {
            create: items.map((item) => ({
              productName: item.name,
              productPrice: parseFloat(item.price) || 0,
              quantity: parseInt(item.quantity) || 1,
              subtotal: (parseFloat(item.price) || 0) * (parseInt(item.quantity) || 1),
              productId: item.id || null,
            })),
          },
        },
        include: { items: true },
      });

      // Descontar stock de los productos
      for (const item of items) {
        if (item.id) {
          await tx.product.update({
            where: { id: parseInt(item.id) },
            data: { stock: { decrement: parseInt(item.quantity) || 1 } },
          });
        }
      }

      return newOrder;
    });

    res.status(201).json({
      message: 'Pedido creado exitosamente',
      order,
    });
  } catch (err) {
    next(err);
  }
});

export default router;

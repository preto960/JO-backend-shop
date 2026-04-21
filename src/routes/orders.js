import express from 'express';
import prisma from '../lib/prisma.js';
import { authenticate, authorize, optionalAuth } from '../middleware/auth.js';

const router = express.Router();

// GET /orders - Listar pedidos
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {};

    // Los clientes solo ven sus propios pedidos
    if (req.user.role === 'customer') {
      where.userId = req.user.id;
    }

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
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { items: true },
    });

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    // Clientes solo pueden ver sus pedidos
    if (req.user.role === 'customer' && order.userId && order.userId !== req.user.id) {
      return res.status(403).json({ error: 'No tienes permisos para ver este pedido' });
    }

    res.json(order);
  } catch (err) {
    next(err);
  }
});

// POST /orders - Crear pedido (cualquier usuario autenticado)
router.post('/', authenticate, async (req, res, next) => {
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

    const order = await prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          customerName: customer.name,
          customerPhone: customer.phone,
          customerAddr: customer.address || null,
          total: parseFloat(total) || 0,
          totalItems: parseInt(totalItems) || 0,
          status: 'pending',
          userId: req.user.id,
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

      // Descontar stock
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

// PUT /orders/:id/status - Actualizar estado del pedido (solo admin)
router.put('/:id/status', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.id);
    const { status } = req.body;

    const validStatuses = ['pending', 'confirmed', 'preparing', 'shipped', 'delivered', 'cancelled'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        error: `Estado inválido. Valores permitidos: ${validStatuses.join(', ')}`,
      });
    }

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: { status },
      include: { items: true },
    });

    res.json({
      message: 'Estado del pedido actualizado',
      order: updated,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /orders/:id - Cancelar/Eliminar pedido
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.id);

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    // Solo admin o el dueño pueden cancelar
    if (req.user.role !== 'admin' && order.userId !== req.user.id) {
      return res.status(403).json({ error: 'No tienes permisos para cancelar este pedido' });
    }

    // Solo se pueden cancelar pedidos pendientes o confirmados
    if (!['pending', 'confirmed'].includes(order.status)) {
      return res.status(400).json({
        error: 'Solo se pueden cancelar pedidos pendientes o confirmados',
      });
    }

    // Restaurar stock
    await prisma.$transaction(async (tx) => {
      for (const item of order.items) {
        if (item.productId) {
          await tx.product.update({
            where: { id: item.productId },
            data: { stock: { increment: item.quantity } },
          });
        }
      }

      await tx.order.update({
        where: { id: orderId },
        data: { status: 'cancelled' },
      });
    });

    res.json({ message: 'Pedido cancelado y stock restaurado' });
  } catch (err) {
    next(err);
  }
});

// GET /orders/stats/dashboard - Estadísticas (solo admin)
router.get('/stats/dashboard', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      totalOrders,
      totalRevenue,
      todayOrders,
      todayRevenue,
      pendingOrders,
      totalProducts,
      totalCustomers,
    ] = await Promise.all([
      prisma.order.count({ where: { status: { not: 'cancelled' } } }),
      prisma.order.aggregate({
        where: { status: { not: 'cancelled' } },
        _sum: { total: true },
      }),
      prisma.order.count({ where: { createdAt: { gte: today }, status: { not: 'cancelled' } } }),
      prisma.order.aggregate({
        where: { createdAt: { gte: today }, status: { not: 'cancelled' } },
        _sum: { total: true },
      }),
      prisma.order.count({ where: { status: 'pending' } }),
      prisma.product.count({ where: { active: true } }),
      prisma.user.count({ where: { role: 'customer' } }),
    ]);

    // Últimos pedidos
    const recentOrders = await prisma.order.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' },
      include: { items: true },
    });

    res.json({
      totalOrders,
      totalRevenue: totalRevenue._sum.total || 0,
      todayOrders,
      todayRevenue: todayRevenue._sum.total || 0,
      pendingOrders,
      totalProducts,
      totalCustomers,
      recentOrders,
    });
  } catch (err) {
    next(err);
  }
});

export default router;

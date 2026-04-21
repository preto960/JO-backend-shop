import express from 'express';
import prisma from '../lib/prisma.js';
import { authenticate, requirePermission, authorize } from '../middleware/auth.js';

const router = express.Router();

// GET /orders - Listar pedidos
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {};

    if (!req.user.roles.includes('admin')) {
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

// ⚠️ ESTA RUTA DEBE IR ANTES DE /:id PARA EVITAR CONFLICTO
// GET /orders/stats/dashboard - Estadísticas (requiere permiso dashboard.view)
router.get('/stats/dashboard', authenticate, requirePermission('dashboard.view'), async (req, res, next) => {
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
      prisma.user.count(),
    ]);

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

    if (!req.user.roles.includes('admin') && order.userId && order.userId !== req.user.id) {
      return res.status(403).json({ error: 'No tienes permisos para ver este pedido' });
    }

    res.json(order);
  } catch (err) {
    next(err);
  }
});

// POST /orders - Crear pedido (requiere permiso orders.create)
router.post('/', authenticate, requirePermission('orders.create'), async (req, res, next) => {
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

// PUT /orders/:id/status - Actualizar estado del pedido (requiere permiso orders.edit)
router.put('/:id/status', authenticate, requirePermission('orders.edit'), async (req, res, next) => {
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

// DELETE /orders/:id - Cancelar/Eliminar pedido (requiere permiso orders.delete)
router.delete('/:id', authenticate, requirePermission('orders.delete'), async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.id);

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    if (!req.user.roles.includes('admin') && order.userId !== req.user.id) {
      return res.status(403).json({ error: 'No tienes permisos para cancelar este pedido' });
    }

    if (!['pending', 'confirmed'].includes(order.status)) {
      return res.status(400).json({
        error: 'Solo se pueden cancelar pedidos pendientes o confirmados',
      });
    }

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

export default router;

import express from 'express';
import prisma from '../lib/prisma.js';
import { authenticate, requirePermission, authorize } from '../middleware/auth.js';
import {
  notifyNewOrder,
  notifyDeliveryAssigned,
  notifyOrderAccepted,
  notifyOrderStatusChange,
} from '../services/notifications.js';

const router = express.Router();

// GET /orders - Listar pedidos
// Admin: ve todos. Delivery: ve todos (para entregas). Customer: solo los suyos.
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {};

    // Solo filtrar por userId si es customer (no admin ni delivery)
    if (!req.user.roles.includes('admin') && !req.user.roles.includes('delivery')) {
      where.userId = req.user.id;
    }

    if (status) {
      where.status = status;
    } else if (req.user.roles.includes('delivery')) {
      // Delivery por defecto solo ve los que puede tomar (sin asignar) + los suyos
      // Pero lo dejamos flexible para que también vea sus asignados
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit),
        include: {
          items: true,
          delivery: {
            select: { id: true, name: true, phone: true },
          },
        },
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

// ⚠️ RUTAS CON PATH ESPECÍFICO DEBEN IR ANTES DE /:id PARA EVITAR CONFLICTO

// GET /orders/available - Pedidos disponibles para que delivery acepte (sin asignar)
router.get('/available', authenticate, requirePermission('delivery.accept'), async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      where: {
        status: { in: ['confirmed', 'pending'] },
        deliveryId: null,
      },
      orderBy: { createdAt: 'asc' },
      include: {
        items: true,
        user: { select: { id: true, name: true, phone: true } },
      },
    });

    res.json({
      data: orders,
      total: orders.length,
    });
  } catch (err) {
    next(err);
  }
});

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
      include: {
        items: true,
        delivery: {
          select: { id: true, name: true, phone: true },
        },
      },
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
      include: {
        items: true,
        delivery: {
          select: { id: true, name: true, phone: true },
        },
      },
    });

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    // Solo admin, delivery asignado, o dueño del pedido pueden verlo
    const isOwner = order.userId && order.userId === req.user.id;
    const isDelivery = order.deliveryId && order.deliveryId === req.user.id;
    const isAdmin = req.user.roles.includes('admin');
    const isDeliveryRole = req.user.roles.includes('delivery');

    if (!isAdmin && !isDeliveryRole && !isOwner) {
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
    const { customer, items, total, totalItems, addressId } = req.body;

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

    // Si se proporciona un addressId, verificar que pertenece al usuario
    let addressData = null;
    if (addressId) {
      const address = await prisma.address.findUnique({
        where: { id: parseInt(addressId) },
      });
      if (address && address.userId === req.user.id) {
        addressData = address.address;
        if (!customer.address && addressData) {
          customer.address = addressData;
        }
      }
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

    // Notificar a admins/editores sobre nuevo pedido (fire & forget)
    notifyNewOrder(order).catch(() => {});
  } catch (err) {
    next(err);
  }
});

// POST /orders/:id/accept - Delivery acepta un pedido (con bloqueo atómico para race conditions)
router.post('/:id/accept', authenticate, requirePermission('delivery.accept'), async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.id);

    // updateMany con WHERE es atómico a nivel BD: solo uno de los dos concurrentes obtendrá count=1
    const result = await prisma.order.updateMany({
      where: {
        id: orderId,
        status: { in: ['confirmed', 'pending'] },
        deliveryId: null,
      },
      data: {
        deliveryId: req.user.id,
        status: 'shipped',
      },
    });

    if (result.count === 0) {
      // El pedido fue tomado por otro o ya no está disponible
      const existing = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
          delivery: { select: { id: true, name: true } },
        },
      });

      if (!existing) {
        return res.status(404).json({ error: 'Pedido no encontrado' });
      }

      if (existing.deliveryId && existing.deliveryId !== req.user.id) {
        return res.status(409).json({
          error: 'Este pedido ya fue asignado a otro repartidor',
          assignedTo: existing.delivery,
          code: 'ORDER_ALREADY_ASSIGNED',
        });
      }

      if (existing.status === 'shipped' || existing.status === 'delivered') {
        return res.status(409).json({
          error: 'Este pedido ya está en camino o fue entregado',
          code: 'ORDER_NOT_AVAILABLE',
        });
      }

      return res.status(409).json({
        error: 'Este pedido no está disponible para aceptar',
        code: 'ORDER_NOT_AVAILABLE',
      });
    }

    // Retornar el pedido actualizado
    const updated = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        delivery: { select: { id: true, name: true, phone: true } },
      },
    });

    res.json({
      message: 'Pedido aceptado correctamente',
      order: updated,
    });

    // Notificar al cliente que su pedido fue aceptado (fire & forget)
    notifyOrderAccepted(updated, updated.delivery?.name).catch(() => {});
    // Notificar a admins que el pedido fue tomado (fire & forget)
    notifyOrderStatusChange(updated, 'shipped').catch(() => {});
  } catch (err) {
    next(err);
  }
});

// PUT /orders/:id/status - Actualizar estado del pedido
// Admin y delivery pueden cambiar estado
router.put('/:id/status', authenticate, async (req, res, next) => {
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

    const isAdmin = req.user.roles.includes('admin');
    const isDelivery = req.user.roles.includes('delivery');

    // Delivery solo puede cambiar a shipped o delivered, y solo si está asignado
    if (isDelivery && !isAdmin) {
      if (order.deliveryId && order.deliveryId !== req.user.id) {
        return res.status(403).json({ error: 'Este pedido te fue asignado a otro delivery' });
      }
      if (!['shipped', 'delivered'].includes(status)) {
        return res.status(403).json({ error: 'Delivery solo puede marcar como "en camino" o "entregado"' });
      }
      if (!order.deliveryId) {
        return res.status(403).json({ error: 'Debes aceptar el pedido primero' });
      }
    }

    // No admin ni delivery con permiso orders.edit: no puede cambiar
    if (!isAdmin && !isDelivery && !req.user.permissions.includes('orders.edit')) {
      return res.status(403).json({ error: 'No tienes permisos para cambiar el estado' });
    }

    const updateData = { status };

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: updateData,
      include: {
        items: true,
        delivery: {
          select: { id: true, name: true, phone: true },
        },
      },
    });

    res.json({
      message: 'Estado del pedido actualizado',
      order: updated,
    });

    // Notificar al cliente sobre cambio de estado (fire & forget)
    if (updated.userId) {
      notifyOrderStatusChange(updated, status).catch(() => {});
    }
  } catch (err) {
    next(err);
  }
});

// PUT /orders/:id/assign - Asignar delivery a un pedido (admin/confirmer)
router.put('/:id/assign', authenticate, async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.id);
    const { deliveryId } = req.body;

    const isAdmin = req.user.roles.includes('admin');
    if (!isAdmin && !req.user.permissions.includes('orders.edit')) {
      return res.status(403).json({ error: 'Solo admin puede asignar delivery' });
    }

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    if (!deliveryId) {
      return res.status(400).json({ error: 'deliveryId es requerido' });
    }

    // Verificar que el delivery user existe y tiene el rol delivery
    const deliveryUser = await prisma.user.findUnique({
      where: { id: parseInt(deliveryId) },
      include: { roles: { include: { role: true } } },
    });

    if (!deliveryUser) {
      return res.status(404).json({ error: 'Usuario delivery no encontrado' });
    }

    const isDeliveryRole = deliveryUser.roles.some(r => r.role.name === 'delivery');
    if (!isDeliveryRole) {
      return res.status(400).json({ error: 'El usuario no tiene el rol de delivery' });
    }

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: {
        deliveryId: parseInt(deliveryId),
        status: 'confirmed', // Al asignar delivery, confirmar el pedido
      },
      include: {
        items: true,
        delivery: {
          select: { id: true, name: true, phone: true },
        },
      },
    });

    res.json({
      message: 'Delivery asignado correctamente',
      order: updated,
    });

    // Notificar al delivery asignado (fire & forget)
    notifyDeliveryAssigned(updated).catch(() => {});
    // Notificar al cliente que su pedido fue confirmado (fire & forget)
    if (updated.userId) {
      notifyOrderStatusChange(updated, 'confirmed').catch(() => {});
    }
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

    const isAdmin = req.user.roles.includes('admin');
    const hasPerm = req.user.permissions.includes('orders.delete');

    if (!isAdmin && !hasPerm) {
      return res.status(403).json({ error: 'No tienes permisos para cancelar este pedido' });
    }

    if (!isAdmin && order.userId !== req.user.id) {
      return res.status(403).json({ error: 'No puedes cancelar pedidos de otros usuarios' });
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

    // Notificar al cliente sobre cancelacion (fire & forget)
    if (order.userId) {
      notifyOrderStatusChange(order, 'cancelled').catch(() => {});
    }
  } catch (err) {
    next(err);
  }
});

export default router;

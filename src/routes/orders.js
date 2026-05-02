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

// GET /orders/stats/dashboard - Estadísticas con filtros de fecha
router.get('/stats/dashboard', authenticate, requirePermission('dashboard.view'), async (req, res, next) => {
  try {
    const { from, to, period } = req.query;

    // Calculate date range
    let startDate = new Date();
    let endDate = new Date();

    if (period) {
      const now = new Date();
      switch (period) {
        case 'today':
          startDate.setHours(0, 0, 0, 0);
          endDate.setHours(23, 59, 59, 999);
          break;
        case 'week':
          startDate.setDate(startDate.getDate() - 7);
          startDate.setHours(0, 0, 0, 0);
          break;
        case 'month':
          startDate.setMonth(startDate.getMonth() - 1);
          startDate.setHours(0, 0, 0, 0);
          break;
        case 'year':
          startDate.setFullYear(startDate.getFullYear() - 1);
          startDate.setHours(0, 0, 0, 0);
          break;
      }
    } else if (from && to) {
      startDate = new Date(from);
      endDate = new Date(to);
      endDate.setHours(23, 59, 59, 999);
    } else {
      // Default: last 30 days
      startDate.setDate(startDate.getDate() - 30);
      startDate.setHours(0, 0, 0, 0);
    }

    const dateFilter = {
      createdAt: { gte: startDate, lte: endDate },
    };

    const [
      totalOrders,
      totalRevenue,
      pendingOrders,
      preparingOrders,
      shippedOrders,
      deliveredOrders,
      cancelledOrders,
      totalProducts,
      totalCustomers,
    ] = await Promise.all([
      prisma.order.count({ where: { ...dateFilter, status: { not: 'cancelled' } } }),
      prisma.order.aggregate({ where: { ...dateFilter, status: { not: 'cancelled' } }, _sum: { total: true } }),
      prisma.order.count({ where: { ...dateFilter, status: 'pending' } }),
      prisma.order.count({ where: { ...dateFilter, status: 'preparing' } }),
      prisma.order.count({ where: { ...dateFilter, status: 'shipped' } }),
      prisma.order.count({ where: { ...dateFilter, status: 'delivered' } }),
      prisma.order.count({ where: { ...dateFilter, status: 'cancelled' } }),
      prisma.product.count({ where: { active: true } }),
      prisma.user.count(),
    ]);

    // Orders by day (for chart)
    const ordersByDay = await prisma.$queryRaw`
      SELECT DATE("created_at") as date, COUNT(*)::int as count, COALESCE(SUM("total"), 0) as revenue
      FROM "orders"
      WHERE "created_at" >= ${startDate} AND "created_at" <= ${endDate}
      GROUP BY DATE("created_at")
      ORDER BY date ASC
    `;

    // Top products (by quantity sold)
    const topProducts = await prisma.$queryRaw`
      SELECT "product_name", SUM("quantity")::int as totalQty, SUM("subtotal") as totalRevenue
      FROM "order_items"
      JOIN "orders" o ON o.id = "order_items"."order_id"
      WHERE o."created_at" >= ${startDate} AND o."created_at" <= ${endDate}
      GROUP BY "product_name"
      ORDER BY "totalQty" DESC
      LIMIT 10
    `;

    // Revenue by status
    const revenueByStatus = await prisma.$queryRaw`
      SELECT status, COUNT(*)::int as count, COALESCE(SUM("total"), 0) as revenue
      FROM "orders"
      WHERE "created_at" >= ${startDate} AND "created_at" <= ${endDate}
      GROUP BY status
      ORDER BY count DESC
    `;

    const recentOrders = await prisma.order.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' },
      include: { items: true, delivery: { select: { id: true, name: true, phone: true } } },
    });

    res.json({
      dateRange: { from: startDate, to: endDate },
      summary: {
        totalOrders,
        totalRevenue: totalRevenue._sum.total || 0,
        pendingOrders,
        preparingOrders,
        shippedOrders,
        deliveredOrders,
        cancelledOrders,
        totalProducts,
        totalCustomers,
      },
      charts: {
        ordersByDay: ordersByDay.map(r => ({
          date: r.date,
          count: Number(r.count),
          revenue: Number(r.revenue),
        })),
        topProducts: topProducts.map(r => ({
          name: r.productName,
          quantity: Number(r.totalQty),
          revenue: Number(r.totalRevenue),
        })),
        revenueByStatus: revenueByStatus.map(r => ({
          status: r.status,
          count: Number(r.count),
          revenue: Number(r.revenue),
        })),
      },
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

    // Auto-fill customer data from user profile if not provided
    const finalCustomer = {
      name: customer?.name?.trim() || req.user.name || '',
      phone: customer?.phone?.trim() || req.user.phone || '',
      address: customer?.address?.trim() || null,
      notes: customer?.notes?.trim() || null,
    };

    if (!finalCustomer.name || !finalCustomer.phone) {
      return res.status(400).json({
        error: 'Datos del cliente son requeridos (nombre y teléfono). Completa tu perfil.',
      });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: 'El pedido debe contener al menos un producto',
      });
    }

    // Si se proporciona un addressId, verificar que pertenece al usuario
    if (addressId) {
      const address = await prisma.address.findUnique({
        where: { id: parseInt(addressId) },
      });
      if (address && address.userId === req.user.id) {
        if (!finalCustomer.address) {
          finalCustomer.address = address.address;
        }
      }
    }

    // Fetch product prices from DB to ensure accuracy
    const productIds = items.filter(i => i.id || i.productId).map(i => parseInt(i.id || i.productId)).filter(Boolean);
    const productMap = {};
    if (productIds.length > 0) {
      const products = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, price: true, name: true },
      });
      for (const p of products) {
        productMap[p.id] = p;
      }
    }

    const order = await prisma.$transaction(async (tx) => {
      // Calculate total from items if not provided
      const calculatedTotal = items.reduce((sum, item) => {
        const price = parseFloat(item.price) || productMap[parseInt(item.id || item.productId)]?.price || 0;
        const qty = parseInt(item.quantity) || 1;
        return sum + (price * qty);
      }, 0);
      const calculatedTotalItems = items.reduce((sum, item) => sum + (parseInt(item.quantity) || 1), 0);

      const newOrder = await tx.order.create({
        data: {
          customerName: finalCustomer.name,
          customerPhone: finalCustomer.phone,
          customerAddr: finalCustomer.address,
          total: parseFloat(total) || calculatedTotal,
          totalItems: parseInt(totalItems) || calculatedTotalItems,
          status: 'pending',
          userId: req.user.id,
          items: {
            create: items.map((item) => {
              const pid = parseInt(item.id || item.productId) || null;
              const dbProduct = pid ? productMap[pid] : null;
              const itemPrice = parseFloat(item.price) || dbProduct?.price || 0;
              const itemName = item.name || dbProduct?.name || 'Producto';
              const qty = parseInt(item.quantity) || 1;
              return {
                productName: itemName,
                productPrice: itemPrice,
                quantity: qty,
                subtotal: itemPrice * qty,
                productId: pid,
              };
            }),
          },
        },
        include: { items: true },
      });

      for (const item of items) {
        const pid = parseInt(item.id || item.productId);
        if (pid) {
          await tx.product.update({
            where: { id: pid },
            data: { stock: { decrement: parseInt(item.quantity) || 1 } },
          });
        }
      }

      return newOrder;
    });

    // CRITICO: Enviar notificaciones ANTES de responder al cliente.
    // En Vercel serverless (Hobby plan), la funcion se congela inmediatamente
    // despues de res.json(), por lo que cualquier proceso async pendiente se pierde.
    // El await asegura que la notificacion se envia antes de que Vercel congele la funcion.
    try {
      await notifyNewOrder(order);
    } catch (notifErr) {
      console.error('[Orders] Error enviando notificaciones de nuevo pedido:', notifErr.message);
    }

    res.status(201).json({
      message: 'Pedido creado exitosamente',
      order,
    });
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

    // CRITICO: Enviar notificaciones ANTES de responder (ver nota en POST /orders)
    try {
      await Promise.allSettled([
        notifyOrderAccepted(updated, updated.delivery?.name),
        notifyOrderStatusChange(updated, 'shipped'),
      ]);
    } catch (notifErr) {
      console.error('[Orders] Error enviando notificaciones de aceptacion:', notifErr.message);
    }

    res.json({
      message: 'Pedido aceptado correctamente',
      order: updated,
    });
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

    // CRITICO: Notificar ANTES de responder
    if (updated.userId) {
      try {
        await notifyOrderStatusChange(updated, status);
      } catch (notifErr) {
        console.error('[Orders] Error notificando cambio de estado:', notifErr.message);
      }
    }

    res.json({
      message: 'Estado del pedido actualizado',
      order: updated,
    });
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

    // CRITICO: Notificar ANTES de responder
    try {
      await notifyDeliveryAssigned(updated);
    } catch (notifErr) {
      console.error('[Orders] Error notificando delivery asignado:', notifErr.message);
    }
    if (updated.userId) {
      try {
        await notifyOrderStatusChange(updated, 'confirmed');
      } catch (notifErr) {
        console.error('[Orders] Error notificando confirmacion:', notifErr.message);
      }
    }

    res.json({
      message: 'Delivery asignado correctamente',
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

    // CRITICO: Notificar ANTES de responder
    if (order.userId) {
      try {
        await notifyOrderStatusChange(order, 'cancelled');
      } catch (notifErr) {
        console.error('[Orders] Error notificando cancelacion:', notifErr.message);
      }
    }

    res.json({ message: 'Pedido cancelado y stock restaurado' });
  } catch (err) {
    next(err);
  }
});

export default router;

import express from 'express';
import prisma from '../lib/prisma.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { emitPusher } from '../config/pusher.js';

const router = express.Router();

// ─── POST /tracking/location - Enviar ubicación del delivery en tiempo real ──
router.post('/location', authenticate, async (req, res, next) => {
  try {
    const { orderId, lat, lng, heading, speed } = req.body;

    if (!orderId || lat === undefined || lng === undefined) {
      return res.status(400).json({
        error: 'orderId, lat y lng son requeridos',
      });
    }

    const parsedLat = parseFloat(lat);
    const parsedLng = parseFloat(lng);

    if (isNaN(parsedLat) || isNaN(parsedLng)) {
      return res.status(400).json({ error: 'lat y lng deben ser números válidos' });
    }

    // Verificar que el pedido existe y que el delivery está asignado
    const order = await prisma.order.findUnique({
      where: { id: parseInt(orderId) },
      select: { id: true, userId: true, deliveryId: true, status: true },
    });

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    // Solo el delivery asignado o admin pueden enviar ubicación
    const isAdmin = req.user.roles.includes('admin');
    const isDelivery = req.user.roles.includes('delivery');

    if (!isAdmin && order.deliveryId !== req.user.id) {
      return res.status(403).json({ error: 'Solo el delivery asignado puede enviar ubicación' });
    }

    // Solo permitir tracking si el pedido está en tránsito
    if (!['confirmed', 'shipped', 'preparing'].includes(order.status)) {
      return res.status(400).json({
        error: 'No se puede rastrear un pedido que no está en tránsito',
      });
    }

    // Guardar ubicación en BD
    const locationUpdate = await prisma.locationUpdate.create({
      data: {
        orderId: order.id,
        userId: req.user.id,
        lat: parsedLat,
        lng: parsedLng,
        heading: heading ? parseFloat(heading) : null,
        speed: speed ? parseFloat(speed) : null,
      },
    });

    // Emitir evento Pusher al canal de tracking del pedido
    await emitPusher(`private-tracking-${orderId}`, 'location-update', {
      orderId: order.id,
      userId: req.user.id,
      userName: req.user.name,
      lat: parsedLat,
      lng: parsedLng,
      heading: heading ? parseFloat(heading) : null,
      speed: speed ? parseFloat(speed) : null,
      timestamp: locationUpdate.createdAt,
    });

    res.json({
      message: 'Ubicación actualizada',
      location: locationUpdate,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /tracking/:orderId/history - Historial de ubicaciones de un pedido ──
router.get('/:orderId/history', authenticate, async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.orderId);
    const { limit = 100 } = req.query;

    // Verificar acceso al pedido
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { userId: true, deliveryId: true },
    });

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const isAdmin = req.user.roles.includes('admin');
    const isDelivery = req.user.roles.includes('delivery');

    if (!isAdmin && order.userId !== req.user.id && order.deliveryId !== req.user.id && !isDelivery) {
      return res.status(403).json({ error: 'No tienes acceso al tracking de este pedido' });
    }

    const history = await prisma.locationUpdate.findMany({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit),
      include: {
        user: {
          select: { id: true, name: true },
        },
      },
    });

    res.json({ data: history });
  } catch (err) {
    next(err);
  }
});

// ─── GET /tracking/:orderId/latest - Última ubicación conocida ──
router.get('/:orderId/latest', authenticate, async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.orderId);

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { userId: true, deliveryId: true },
    });

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const isAdmin = req.user.roles.includes('admin');
    const isDelivery = req.user.roles.includes('delivery');

    if (!isAdmin && order.userId !== req.user.id && order.deliveryId !== req.user.id && !isDelivery) {
      return res.status(403).json({ error: 'No tienes acceso al tracking de este pedido' });
    }

    const latest = await prisma.locationUpdate.findFirst({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: { id: true, name: true },
        },
      },
    });

    res.json({
      data: latest || null,
      orderId,
    });
  } catch (err) {
    next(err);
  }
});

export default router;

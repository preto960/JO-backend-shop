import express from 'express';
import Pusher from 'pusher';

const router = express.Router();

// ─── POST /pusher/auth - Autenticar canales privados y presencia ──────────
router.post('/auth', async (req, res) => {
  try {
    const socketId = req.body.socket_id;
    const channelName = req.body.channel_name;

    if (!socketId || !channelName) {
      return res.status(400).json({ error: 'socket_id and channel_name are required' });
    }

    // ── Canales privados de usuario: private-user-{userId} ──
    const userMatch = channelName.match(/^private-user-(\d+)$/);
    if (userMatch) {
      const userId = parseInt(userMatch[1]);
      // Verificar que el usuario autenticado coincide con el canal solicitado
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { verifyToken } = await import('../services/auth.js');
      const decoded = verifyToken(authHeader.split(' ')[1]);
      if (!decoded || !decoded.valid) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      // Admin puede suscribirse a cualquier canal de usuario
      const isAdmin = decoded.roles && decoded.roles.includes('admin');
      if (!isAdmin && decoded.id !== userId) {
        return res.status(403).json({ error: 'Cannot subscribe to another user channel' });
      }

      const pusher = new Pusher({
        appId: process.env.PUSHER_APP_ID,
        key: process.env.PUSHER_KEY,
        secret: process.env.PUSHER_SECRET,
        cluster: process.env.PUSHER_CLUSTER,
        useTLS: true,
      });

      const authResponse = pusher.authenticate(socketId, channelName);
      return res.json(authResponse);
    }

    // ── Canales privados de pedido: private-order-{orderId} ──
    const orderMatch = channelName.match(/^private-order-(\d+)$/);
    if (orderMatch) {
      const orderId = parseInt(orderMatch[1]);

      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { verifyToken } = await import('../services/auth.js');
      const decoded = verifyToken(authHeader.split(' ')[1]);
      if (!decoded || !decoded.valid) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      const { PrismaClient } = await import('@prisma/client');
      const { PrismaPg } = await import('@prisma/adapter-pg');
      const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
      const prisma = new PrismaClient({ adapter });

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { userId: true, deliveryId: true },
      });

      await prisma.$disconnect();

      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const isAdmin = decoded.roles && decoded.roles.includes('admin');
      const isDelivery = decoded.roles && decoded.roles.includes('delivery');

      // Solo el dueño del pedido, delivery asignado, o admin pueden suscribirse
      if (!isAdmin && order.userId !== decoded.id && order.deliveryId !== decoded.id && !isDelivery) {
        return res.status(403).json({ error: 'Not authorized for this order channel' });
      }

      const pusher = new Pusher({
        appId: process.env.PUSHER_APP_ID,
        key: process.env.PUSHER_KEY,
        secret: process.env.PUSHER_SECRET,
        cluster: process.env.PUSHER_CLUSTER,
        useTLS: true,
      });

      const authResponse = pusher.authenticate(socketId, channelName);
      return res.json(authResponse);
    }

    // ── Canal de presencia: presence-admin-chat ──
    if (channelName === 'presence-admin-chat') {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { verifyToken } = await import('../services/auth.js');
      const decoded = verifyToken(authHeader.split(' ')[1]);
      if (!decoded || !decoded.valid) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      // Solo admin puede unirse al chat de administradores
      const isAdmin = decoded.roles && decoded.roles.includes('admin');
      if (!isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const pusher = new Pusher({
        appId: process.env.PUSHER_APP_ID,
        key: process.env.PUSHER_KEY,
        secret: process.env.PUSHER_SECRET,
        cluster: process.env.PUSHER_CLUSTER,
        useTLS: true,
      });

      const presenceData = {
        user_id: String(decoded.id),
        user_info: {
          id: decoded.id,
          name: decoded.name || decoded.email,
          email: decoded.email,
        },
      };

      const authResponse = pusher.authenticate(socketId, channelName, presenceData);
      return res.json(authResponse);
    }

    // ── Canal privado de tracking: private-tracking-{orderId} ──
    const trackingMatch = channelName.match(/^private-tracking-(\d+)$/);
    if (trackingMatch) {
      const orderId = parseInt(trackingMatch[1]);

      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { verifyToken } = await import('../services/auth.js');
      const decoded = verifyToken(authHeader.split(' ')[1]);
      if (!decoded || !decoded.valid) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      const { PrismaClient } = await import('@prisma/client');
      const { PrismaPg } = await import('@prisma/adapter-pg');
      const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
      const prisma = new PrismaClient({ adapter });

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { userId: true, deliveryId: true },
      });

      await prisma.$disconnect();

      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const isAdmin = decoded.roles && decoded.roles.includes('admin');
      const isDelivery = decoded.roles && decoded.roles.includes('delivery');

      // Solo el dueño, delivery asignado o admin
      if (!isAdmin && order.userId !== decoded.id && order.deliveryId !== decoded.id && !isDelivery) {
        return res.status(403).json({ error: 'Not authorized for this tracking channel' });
      }

      const pusher = new Pusher({
        appId: process.env.PUSHER_APP_ID,
        key: process.env.PUSHER_KEY,
        secret: process.env.PUSHER_SECRET,
        cluster: process.env.PUSHER_CLUSTER,
        useTLS: true,
      });

      const authResponse = pusher.authenticate(socketId, channelName);
      return res.json(authResponse);
    }

    // Canal no reconocido
    return res.status(403).json({ error: 'Channel not authorized' });
  } catch (err) {
    console.error('[Pusher Auth] Error:', err.message);
    return res.status(500).json({ error: 'Authentication failed' });
  }
});

export default router;

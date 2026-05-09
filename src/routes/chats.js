import express from 'express';
import prisma from '../lib/prisma.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { emitPusher } from '../config/pusher.js';

const router = express.Router();

// ─── GET /chats/orders/:orderId/messages - Obtener mensajes de chat de un pedido ──
router.get('/orders/:orderId/messages', authenticate, async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.orderId);
    const { page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Verificar que el usuario tiene acceso al pedido
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
      return res.status(403).json({ error: 'No tienes acceso al chat de este pedido' });
    }

    // Obtener o crear conversación
    let conversation = await prisma.conversation.findUnique({
      where: { orderId },
    });

    // Si no existe conversación para este pedido, devolver vacío
    // (sin esto, conversationId: undefined haría que Prisma devuelva TODOS los mensajes)
    if (!conversation) {
      return res.json({
        data: [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: 0,
          totalPages: 0,
        },
      });
    }

    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
      skip,
      take: parseInt(limit),
      include: {
        sender: {
          select: { id: true, name: true, phone: true },
        },
      },
    });

    const total = await prisma.message.count({
      where: { conversationId: conversation.id },
    });

    res.json({
      data: messages,
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

// ─── POST /chats/orders/:orderId/messages - Enviar mensaje en chat de pedido ──
router.post('/orders/:orderId/messages', authenticate, async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.orderId);
    const { content, type = 'text' } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'El contenido del mensaje es requerido' });
    }

    // Verificar acceso al pedido
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { userId: true, deliveryId: true, status: true },
    });

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const isAdmin = req.user.roles.includes('admin');
    const isDelivery = req.user.roles.includes('delivery');
    const isOwner = order.userId === req.user.id;
    const isAssignedDelivery = order.deliveryId === req.user.id;

    if (!isAdmin && !isOwner && !isAssignedDelivery && !isDelivery) {
      return res.status(403).json({ error: 'No tienes acceso al chat de este pedido' });
    }

    // Obtener o crear conversación
    let conversation = await prisma.conversation.findUnique({
      where: { orderId },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          orderId,
          type: 'order',
          participantIds: [order.userId, order.deliveryId].filter(Boolean),
        },
      });
    } else {
      // Actualizar participantIds si hay nuevo delivery asignado
      const currentIds = conversation.participantIds || [];
      const neededIds = [order.userId, order.deliveryId].filter(Boolean);
      const merged = [...new Set([...currentIds, ...neededIds])];
      if (merged.length !== currentIds.length) {
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { participantIds: merged },
        });
      }
    }

    // Detectar plataforma desde header
    const platform = req.headers['x-platform'] || 'unknown';

    // Crear mensaje
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderId: req.user.id,
        platform,
        content: content.trim(),
        type,
      },
      include: {
        sender: {
          select: { id: true, name: true, phone: true },
        },
      },
    });

    // Emitir evento Pusher al canal del pedido
    const channel = `private-order-${orderId}`;
    await emitPusher(channel, 'new-message', {
      id: message.id,
      conversationId: conversation.id,
      senderId: message.senderId,
      senderName: message.sender.name,
      platform: message.platform,
      content: message.content,
      type: message.type,
      createdAt: message.createdAt,
    });

    // También notificar al usuario dueño del pedido si no es él quien envía
    if (order.userId && order.userId !== req.user.id) {
      await emitPusher(`private-user-${order.userId}`, 'order-message', {
        orderId,
        conversationId: conversation.id,
        messageId: message.id,
        senderName: message.sender.name,
        content: message.content,
        type: message.type,
        createdAt: message.createdAt,
      });
    }

    // Notificar al delivery si no es él quien envía
    if (order.deliveryId && order.deliveryId !== req.user.id) {
      await emitPusher(`private-user-${order.deliveryId}`, 'order-message', {
        orderId,
        conversationId: conversation.id,
        messageId: message.id,
        senderName: message.sender.name,
        content: message.content,
        type: message.type,
        createdAt: message.createdAt,
      });
    }

    res.status(201).json({ message });
  } catch (err) {
    next(err);
  }
});

// ─── GET /chats/admin/messages - Obtener mensajes del chat de admin (presencia) ──
router.get('/admin/messages', authenticate, requirePermission('admin-chat.view'), async (req, res, next) => {
  try {
    const { page = 1, limit = 50, recipientId } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // La conversación de admin tiene type = 'admin' y orderId = null
    let conversation = await prisma.conversation.findFirst({
      where: { type: 'admin' },
    });

    // Si no existe conversación de admin, devolver vacío
    if (!conversation) {
      return res.json({
        data: [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: 0,
          totalPages: 0,
        },
      });
    }

    // Construir filtro: si se pide recipientId, filtrar mensajes entre yo y ese usuario
    let whereClause = { conversationId: conversation.id };
    if (recipientId) {
      const rid = parseInt(recipientId);
      if (!isNaN(rid)) {
        whereClause = {
          conversationId: conversation.id,
          OR: [
            // Mensajes que yo envié a ese usuario
            { senderId: req.user.id, recipientId: rid },
            // Mensajes que ese usuario me envió a mí
            { senderId: rid, recipientId: req.user.id },
            // Mensajes de ese usuario sin destinatario específico (broadcast)
            { senderId: rid, recipientId: null },
            // Mis mensajes broadcast
            { senderId: req.user.id, recipientId: null },
          ],
        };
      }
    }

    const messages = await prisma.message.findMany({
      where: whereClause,
      orderBy: { createdAt: 'asc' },
      skip,
      take: parseInt(limit),
      include: {
        sender: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    const total = await prisma.message.count({
      where: whereClause,
    });

    res.json({
      data: messages,
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

// ─── POST /chats/admin/messages - Enviar mensaje al chat de admin ──
router.post('/admin/messages', authenticate, requirePermission('admin-chat.send'), async (req, res, next) => {
  try {
    const { content, type = 'text', recipientId, targetPlatform } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'El contenido del mensaje es requerido' });
    }

    // Validar recipientId si se envía
    let validatedRecipientId = null;
    if (recipientId !== undefined && recipientId !== null) {
      validatedRecipientId = parseInt(recipientId);
      if (isNaN(validatedRecipientId)) {
        return res.status(400).json({ error: 'recipientId debe ser un número válido' });
      }
    }

    // Validar targetPlatform si se envía
    const validPlatforms = ['all', 'frontend-shop', 'landingpage', 'app-shop', 'app-delivery'];
    const validatedTargetPlatform = validPlatforms.includes(targetPlatform) ? targetPlatform : 'all';

    // Obtener o crear conversación de admin
    let conversation = await prisma.conversation.findFirst({
      where: { type: 'admin' },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          type: 'admin',
          participantIds: [],
        },
      });
    }

    // Detectar plataforma desde header
    const platform = req.headers['x-platform'] || 'unknown';

    // Crear mensaje con recipientId y targetPlatform
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderId: req.user.id,
        recipientId: validatedRecipientId,
        platform,
        targetPlatform: validatedTargetPlatform,
        content: content.trim(),
        type,
      },
      include: {
        sender: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    // Emitir evento Pusher al canal de presencia de admin
    await emitPusher('presence-admin-chat', 'new-message', {
      id: message.id,
      conversationId: conversation.id,
      senderId: message.senderId,
      senderName: message.sender.name,
      senderEmail: message.sender.email,
      senderPlatform: message.platform,
      recipientId: message.recipientId,
      targetPlatform: message.targetPlatform,
      content: message.content,
      type: message.type,
      createdAt: message.createdAt,
    });

    res.status(201).json({ message });
  } catch (err) {
    next(err);
  }
});

// ─── GET /chats/my-conversations - Obtener conversaciones del usuario ──
router.get('/my-conversations', authenticate, async (req, res, next) => {
  try {
    // Buscar conversaciones donde el usuario es participante
    const conversations = await prisma.conversation.findMany({
      where: {
        OR: [
          { participantIds: { has: req.user.id } },
          { orderId: { not: null } }, // También verificar pedidos del usuario
        ],
      },
      orderBy: { updatedAt: 'desc' },
      include: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: {
            sender: {
              select: { id: true, name: true },
            },
          },
        },
        order: {
          select: {
            id: true,
            status: true,
            total: true,
            customerName: true,
            delivery: {
              select: { id: true, name: true, phone: true },
            },
          },
        },
      },
    });

    // Filtrar solo conversaciones a las que el usuario realmente tiene acceso
    const filtered = conversations.filter(conv => {
      if (conv.participantIds && conv.participantIds.includes(req.user.id)) return true;
      if (conv.order) {
        return conv.order.userId === req.user.id || conv.order.deliveryId === req.user.id;
      }
      return false;
    });

    // Formatear respuesta
    const formatted = filtered.map(conv => ({
      id: conv.id,
      type: conv.type,
      orderId: conv.orderId,
      order: conv.order,
      lastMessage: conv.messages[0] || null,
      updatedAt: conv.updatedAt,
    }));

    res.json({ data: formatted });
  } catch (err) {
    next(err);
  }
});

export default router;

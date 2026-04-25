import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import prisma from './lib/prisma.js';
import authRouter from './routes/auth.js';
import productsRouter from './routes/products.js';
import categoriesRouter from './routes/categories.js';
import ordersRouter from './routes/orders.js';
import addressesRouter from './routes/addresses.js';
import adminRouter from './routes/admin.js';
import storesRouter from './routes/stores.js';
import configRouter from './routes/config.js';
import notificationsRouter from './routes/notifications.js';
import verificationRouter from './routes/verification.js';
import pushRoutes from './routes/push.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' }));

// Rutas de la API
app.use('/auth', authRouter);
app.use('/auth', adminRouter); // Sub-rutas: /auth/permissions, /auth/roles, /auth/users
app.use('/products', productsRouter);
app.use('/categories', categoriesRouter);
app.use('/orders', ordersRouter);
app.use('/addresses', addressesRouter);
app.use('/stores', storesRouter);
app.use('/config', configRouter);
app.use('/notifications', notificationsRouter);
app.use('/auth/otp', verificationRouter);
app.use('/api/push', pushRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'JO-backend-shop',
    version: '3.0.0',
    timestamp: new Date().toISOString(),
  });
});

// Raíz
app.get('/', (req, res) => {
  res.json({
    message: 'JO-backend-shop API',
    version: '3.0.0',
    auth: {
      register: 'POST /auth/register',
      login: 'POST /auth/login',
      refresh: 'POST /auth/refresh',
      profile: 'GET /auth/me',
      updateProfile: 'PUT /auth/profile',
    },
    admin: {
      permissions: 'GET /auth/permissions (admin)',
      roles: 'GET /auth/roles (admin)',
      createRole: 'POST /auth/roles (admin)',
      updateRole: 'PUT /auth/roles/:id (admin)',
      deleteRole: 'DELETE /auth/roles/:id (admin)',
      users: 'GET /auth/users (admin)',
      assignRoles: 'PUT /auth/users/:id/roles (admin)',
      grantPermission: 'POST /auth/users/:id/permissions (admin)',
      revokePermission: 'DELETE /auth/users/:id/permissions/:permissionId (admin)',
    },
    products: {
      list: 'GET /products',
      detail: 'GET /products/:id',
      search: 'GET /products/search?q=query',
      create: 'POST /products (products.create)',
      update: 'PUT /products/:id (products.edit)',
      delete: 'DELETE /products/:id (products.delete)',
    },
    categories: {
      list: 'GET /categories',
      create: 'POST /categories (categories.create)',
      update: 'PUT /categories/:id (categories.edit)',
      delete: 'DELETE /categories/:id (categories.delete)',
    },
    orders: {
      list: 'GET /orders',
      create: 'POST /orders (orders.create)',
      detail: 'GET /orders/:id',
      updateStatus: 'PUT /orders/:id/status (orders.edit)',
      assignDelivery: 'PUT /orders/:id/assign (orders.edit)',
      available: 'GET /orders/available (delivery.accept)',
      accept: 'POST /orders/:id/accept (delivery.accept)',
      cancel: 'DELETE /orders/:id (orders.delete)',
      dashboard: 'GET /orders/stats/dashboard (dashboard.view)',
    },
    stores: {
      list: 'GET /stores',
      detail: 'GET /stores/:id',
      myStore: 'GET /stores/my-store (auth)',
      create: 'POST /stores (stores.create / editor)',
      update: 'PUT /stores/:id (stores.edit / own store)',
      delete: 'DELETE /stores/:id (stores.delete / admin)',
    },
    addresses: {
      list: 'GET /addresses (auth)',
      create: 'POST /addresses (auth)',
      update: 'PUT /addresses/:id (auth)',
      setDefault: 'PUT /addresses/:id/default (auth)',
      delete: 'DELETE /addresses/:id (auth)',
    },
  });
});

// Manejador de errores global
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(err.statusCode || 500).json({
    error: err.message || 'Error interno del servidor',
  });
});

// Iniciar servidor (solo local, no en Vercel)
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n  JO-backend-shop v3.0.0`);
    console.log(`  Puerto: ${PORT}`);
    console.log(`  Health: http://localhost:${PORT}/health\n`);
  });
}

export default app;

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import prisma from './lib/prisma.js';
import authRouter from './routes/auth.js';
import productsRouter from './routes/products.js';
import categoriesRouter from './routes/categories.js';
import ordersRouter from './routes/orders.js';

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
app.use('/products', productsRouter);
app.use('/categories', categoriesRouter);
app.use('/orders', ordersRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'JO-backend-shop',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
  });
});

// Raíz
app.get('/', (req, res) => {
  res.json({
    message: 'JO-backend-shop API',
    version: '2.0.0',
    auth: {
      register: 'POST /auth/register',
      login: 'POST /auth/login',
      refresh: 'POST /auth/refresh',
      profile: 'GET /auth/me',
      updateProfile: 'PUT /auth/profile',
    },
    products: {
      list: 'GET /products',
      detail: 'GET /products/:id',
      search: 'GET /products/search?q=query',
      create: 'POST /products (admin)',
      update: 'PUT /products/:id (admin)',
      delete: 'DELETE /products/:id (admin)',
    },
    categories: {
      list: 'GET /categories',
      create: 'POST /categories (admin)',
      update: 'PUT /categories/:id (admin)',
      delete: 'DELETE /categories/:id (admin)',
    },
    orders: {
      list: 'GET /orders',
      create: 'POST /orders',
      updateStatus: 'PUT /orders/:id/status (admin)',
      cancel: 'DELETE /orders/:id',
      dashboard: 'GET /orders/stats/dashboard (admin)',
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
    console.log(`\n  JO-backend-shop v2.0.0`);
    console.log(`  Puerto: ${PORT}`);
    console.log(`  Health: http://localhost:${PORT}/health\n`);
  });
}

export default app;

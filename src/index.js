import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import prisma from './lib/prisma.js';
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
app.use('/products', productsRouter);
app.use('/categories', categoriesRouter);
app.use('/orders', ordersRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'JO-backend-shop',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// Raíz
app.get('/', (req, res) => {
  res.json({
    message: 'JO-backend-shop API',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      products: 'GET /products',
      productDetail: 'GET /products/:id',
      search: 'GET /products/search?q=query',
      categories: 'GET /categories',
      createOrder: 'POST /orders',
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

// Iniciar servidor (solo si no es Vercel)
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 JO-backend-shop corriendo en puerto ${PORT}`);
    console.log(`📍 Health: http://localhost:${PORT}/health`);
    console.log(`📍 API: http://localhost:${PORT}/`);
  });
}

export default app;

import express from 'express';
import multer from 'multer';
import { put, del } from '@vercel/blob';
import prisma from '../lib/prisma.js';
import { authenticate, requirePermission, optionalAuth } from '../middleware/auth.js';
import { sanitize } from '../services/auth.js';

// Multer config for product image upload (in-memory)
const ALLOWED_IMG_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMG_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de archivo no permitido. Solo se aceptan JPG, PNG, WebP y GIF.'));
    }
  },
});

// Multer config for CSV bulk upload (in-memory, allows text/csv)
const uploadCSV = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const router = express.Router();

// GET /products - Listar productos (lectura pública para auth optional)
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const { page = 1, limit = 20, category, store, sort = 'newest', active } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Get system config for multi-store filtering
    const systemConfig = await prisma.config.findMany({
      where: { key: { in: ['multi_store'] } },
      select: { key: true, value: true },
    });
    const config = {};
    for (const c of systemConfig) {
      config[c.key] = c.value;
    }

    const where = {};
    if (req.user && req.user.roles.includes('admin')) {
      if (active !== undefined) {
        where.active = active === 'true';
      }
    } else {
      where.active = true;
    }

    if (category) {
      where.categoryId = parseInt(category);
    }

    // Filtro por tienda (vía ProductStore)
    if (store) {
      where.stores = {
        some: { storeId: parseInt(store) },
      };
    }

    // Editor solo ve productos de sus tiendas asignadas
    if (req.user && req.user.roles.includes('editor') && !req.user.roles.includes('admin')) {
      const userStores = await prisma.userStore.findMany({
        where: { userId: req.user.id },
        select: { storeId: true },
      });
      if (userStores.length > 0) {
        where.stores = {
          some: { storeId: { in: userStores.map(s => s.storeId) } },
        };
      }
    }

    // Multi-store: only show products with assigned stores
    if (config.multi_store === 'true') {
      where.stores = {
        some: {},  // has at least one store
      };
      // If a specific store was already requested, merge with that filter
      if (store) {
        where.stores = {
          some: { storeId: parseInt(store) },
        };
      }
    }

    let orderBy = { createdAt: 'desc' };
    if (sort === 'price_asc') orderBy = { price: 'asc' };
    if (sort === 'price_desc') orderBy = { price: 'desc' };
    if (sort === 'name') orderBy = { name: 'asc' };

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy,
        skip,
        take: parseInt(limit),
        include: {
          category: { select: { id: true, name: true } },
          stores: { include: { store: { select: { id: true, name: true, slug: true } } } },
        },
      }),
      prisma.product.count({ where }),
    ]);

    const formatted = products.map(p => ({
      ...p,
      store: p.stores.length > 0 ? p.stores[0].store : null,
      storeIds: p.stores.map(ps => ps.storeId),
    }));

    res.json({
      data: formatted,
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

// GET /products/search?q=query - Buscar productos
router.get('/search', optionalAuth, async (req, res, next) => {
  try {
    const { q, category, store, page = 1, limit = 20 } = req.query;

    // Get system config for multi-store filtering
    const systemConfig = await prisma.config.findMany({
      where: { key: { in: ['multi_store'] } },
      select: { key: true, value: true },
    });
    const config = {};
    for (const c of systemConfig) {
      config[c.key] = c.value;
    }

    if (!q || q.trim().length === 0) {
      return res.status(400).json({ error: 'Parámetro de búsqueda "q" es requerido' });
    }

    const where = {
      active: true,
      OR: [
        { name: { contains: q.trim(), mode: 'insensitive' } },
        { description: { contains: q.trim(), mode: 'insensitive' } },
      ],
    };

    if (category) {
      where.categoryId = parseInt(category);
    }

    if (store) {
      where.stores = {
        some: { storeId: parseInt(store) },
      };
    }

    // Multi-store: only show products with assigned stores
    if (config.multi_store === 'true') {
      where.stores = {
        some: {},  // has at least one store
      };
      if (store) {
        where.stores = {
          some: { storeId: parseInt(store) },
        };
      }
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit),
        include: {
          category: { select: { id: true, name: true } },
          stores: { include: { store: { select: { id: true, name: true, slug: true } } } },
        },
      }),
      prisma.product.count({ where }),
    ]);

    const formatted = products.map(p => ({
      ...p,
      store: p.stores.length > 0 ? p.stores[0].store : null,
      storeIds: p.stores.map(ps => ps.storeId),
    }));

    res.json({
      data: formatted,
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

// POST /products/bulk-csv - Carga masiva de productos via CSV
router.post('/bulk-csv', authenticate, requirePermission('products.create'), uploadCSV.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se envio ningun archivo CSV' });
    }
    if (!req.file.mimetype.includes('text/csv') && !req.file.originalname.endsWith('.csv')) {
      return res.status(400).json({ error: 'El archivo debe ser un CSV' });
    }

    const csvContent = req.file.buffer.toString('utf-8');
    const lines = csvContent.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    if (lines.length < 2) {
      return res.status(400).json({ error: 'El CSV debe tener al menos una fila de datos (fila de encabezados + datos)' });
    }

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g, ''));
    
    // Map column names to field names (flexible)
    const colMap = {};
    headers.forEach((h, i) => {
      if (['nombre', 'name', 'producto', 'product'].includes(h)) colMap.name = i;
      else if (['descripcion', 'description', 'desc'].includes(h)) colMap.description = i;
      else if (['precio', 'price', 'costo'].includes(h)) colMap.price = i;
      else if (['descuento', 'discount', 'dto', 'discountpercent'].includes(h)) colMap.discountPercent = i;
      else if (['stock', 'cantidad', 'quantity', 'qty'].includes(h)) colMap.stock = i;
      else if (['categoria', 'category', 'categoria_id', 'categoryid'].includes(h)) colMap.categoryName = i;
    });

    if (colMap.name === undefined) {
      return res.status(400).json({ error: 'El CSV debe tener una columna "nombre" o "name"' });
    }

    // Get all categories for name matching
    const categories = await prisma.category.findMany({ select: { id: true, name: true } });
    const categoryMap = {};
    for (const c of categories) {
      categoryMap[c.name.toLowerCase()] = c.id;
    }

    // Default category if none specified
    const defaultCategory = categories[0]?.id;

    const results = { created: 0, errors: [], skipped: 0 };
    const products = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      const name = (cols[colMap.name] || '').trim().replace(/['"]/g, '');
      
      if (!name || name.length < 2) {
        results.errors.push({ row: i + 1, error: 'Nombre vacio o muy corto' });
        continue;
      }

      const description = colMap.description !== undefined ? (cols[colMap.description] || '').trim().replace(/['"]/g, '') : '';
      const price = colMap.price !== undefined ? parseFloat((cols[colMap.price] || '0').replace(/['"]/g, '')) : 0;
      const discountPercent = colMap.discountPercent !== undefined ? parseFloat((cols[colMap.discountPercent] || '0').replace(/['"]/g, '')) : 0;
      const stock = colMap.stock !== undefined ? parseInt((cols[colMap.stock] || '0').replace(/['"]/g, '')) : 0;
      const categoryName = colMap.categoryName !== undefined ? (cols[colMap.categoryName] || '').trim().replace(/['"]/g, '').toLowerCase() : '';
      const categoryId = categoryMap[categoryName] || defaultCategory;

      if (isNaN(price) || price < 0) {
        results.errors.push({ row: i + 1, name, error: 'Precio invalido' });
        continue;
      }

      const slug = sanitize(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const finalSlug = `${slug}-${Date.now()}-${i}`;

      products.push({
        name: sanitize(name),
        slug: finalSlug,
        description: description || null,
        price,
        discountPercent: isNaN(discountPercent) ? 0 : Math.min(100, Math.max(0, discountPercent)),
        stock: isNaN(stock) ? 0 : Math.max(0, stock),
        categoryId: categoryId || defaultCategory,
        active: true,
      });
      results.created++;
    }

    // Bulk create products
    if (products.length > 0) {
      await prisma.product.createMany({ data: products, skipDuplicates: true });
    }

    res.json({
      message: `Importacion completada: ${results.created} productos creados, ${results.errors.length} errores, ${results.skipped} omitidos`,
      results,
    });
  } catch (err) {
    next(err);
  }
});

// Helper: parse CSV line respecting quoted fields
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && !inQuotes) { inQuotes = true; continue; }
    if (char === '"' && inQuotes) { inQuotes = false; continue; }
    if (char === ',' && !inQuotes) { result.push(current); current = ''; continue; }
    current += char;
  }
  result.push(current);
  return result;
}

// GET /products/:id - Detalle de producto
router.get('/:id', async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        category: { select: { id: true, name: true, slug: true } },
        stores: { include: { store: { select: { id: true, name: true, slug: true } } } },
      },
    });

    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    res.json({
      ...product,
      store: product.stores.length > 0 ? product.stores[0].store : null,
      storeIds: product.stores.map(ps => ps.storeId),
    });
  } catch (err) {
    next(err);
  }
});

// POST /products - Crear producto (requiere permiso products.create)
router.post('/', authenticate, requirePermission('products.create'), async (req, res, next) => {
  try {
    const { name, description, price, discountPercent, image, thumbnail, images, stock, categoryId, storeIds, active } = req.body;

    if (!name || name.trim().length < 2) {
      return res.status(400).json({ error: 'Nombre del producto requerido (mínimo 2 caracteres)', field: 'name' });
    }
    if (price === undefined || price === null || parseFloat(price) < 0) {
      return res.status(400).json({ error: 'Precio válido requerido', field: 'price' });
    }
    if (categoryId === undefined || categoryId === null) {
      return res.status(400).json({ error: 'Categoría requerida', field: 'categoryId' });
    }

    const category = await prisma.category.findUnique({ where: { id: parseInt(categoryId) } });
    if (!category) {
      return res.status(404).json({ error: 'Categoría no encontrada', field: 'categoryId' });
    }

    // Validar storeIds si se proporcionan
    let targetStoreIds = [];
    if (storeIds && Array.isArray(storeIds) && storeIds.length > 0) {
      const stores = await prisma.store.findMany({
        where: { id: { in: storeIds.map(id => parseInt(id)) } },
      });
      if (stores.length !== storeIds.length) {
        return res.status(400).json({ error: 'Una o más tiendas no encontradas', field: 'storeIds' });
      }
      targetStoreIds = storeIds.map(id => parseInt(id));
    } else {
      // Si es editor y no se especifican tiendas, auto-asignar a sus tiendas
      const isEditor = req.user.roles.includes('editor') && !req.user.roles.includes('admin');
      if (isEditor) {
        const userStores = await prisma.userStore.findMany({
          where: { userId: req.user.id },
          select: { storeId: true },
        });
        targetStoreIds = userStores.map(s => s.storeId);
      }
    }

    const slug = sanitize(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    const existingSlug = await prisma.product.findUnique({ where: { slug } });
    const finalSlug = existingSlug ? `${slug}-${Date.now()}` : slug;

    const product = await prisma.product.create({
      data: {
        name: sanitize(name),
        slug: finalSlug,
        description: description ? sanitize(description) : null,
        price: parseFloat(price),
        discountPercent: discountPercent !== undefined ? parseFloat(discountPercent) : 0,
        image: image || null,
        thumbnail: thumbnail || null,
        images: images && Array.isArray(images) ? JSON.stringify(images) : null,
        stock: parseInt(stock) || 0,
        active: active !== undefined ? Boolean(active) : true,
        categoryId: parseInt(categoryId),
        stores: {
          create: targetStoreIds.map(storeId => ({ storeId })),
        },
      },
      include: {
        category: true,
        stores: { include: { store: { select: { id: true, name: true } } } },
      },
    });

    res.status(201).json({
      message: 'Producto creado exitosamente',
      product: {
        ...product,
        store: product.stores.length > 0 ? product.stores[0].store : null,
        storeIds: product.stores.map(ps => ps.storeId),
      },
    });
  } catch (err) {
    next(err);
  }
});

// PUT /products/:id - Actualizar producto (requiere permiso products.edit)
router.put('/:id', authenticate, requirePermission('products.edit'), async (req, res, next) => {
  try {
    const productId = parseInt(req.params.id);

    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { stores: { include: { store: { select: { id: true } } } } },
    });
    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    // Editor solo puede editar productos de sus tiendas
    const isEditor = req.user.roles.includes('editor') && !req.user.roles.includes('admin');
    if (isEditor) {
      const userStores = await prisma.userStore.findMany({
        where: { userId: req.user.id },
        select: { storeId: true },
      });
      const userStoreIds = userStores.map(s => s.storeId);
      const productStoreIds = product.stores.map(ps => ps.storeId);
      const hasAccess = productStoreIds.some(id => userStoreIds.includes(id));
      if (!hasAccess && productStoreIds.length > 0) {
        return res.status(403).json({ error: 'Solo puedes editar productos de tus tiendas' });
      }
    }

    const { name, description, price, discountPercent, image, thumbnail, images, stock, categoryId, active, storeIds } = req.body;
    const updateData = {};

    if (name !== undefined) {
      if (name.trim().length < 2) {
        return res.status(400).json({ error: 'Nombre debe tener al menos 2 caracteres', field: 'name' });
      }
      updateData.name = sanitize(name);
      const newSlug = sanitize(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      updateData.slug = newSlug;
    }

    if (description !== undefined) {
      updateData.description = sanitize(description) || null;
    }

    if (price !== undefined) {
      if (parseFloat(price) < 0) {
        return res.status(400).json({ error: 'Precio no puede ser negativo', field: 'price' });
      }
      updateData.price = parseFloat(price);
    }

    if (discountPercent !== undefined) {
      const val = parseFloat(discountPercent);
      if (val < 0 || val > 100) {
        return res.status(400).json({ error: 'Descuento debe estar entre 0 y 100', field: 'discountPercent' });
      }
      updateData.discountPercent = val;
    }

    if (image !== undefined) updateData.image = image || null;
    if (thumbnail !== undefined) updateData.thumbnail = thumbnail || null;
    if (images !== undefined) updateData.images = (Array.isArray(images) && images.length > 0) ? JSON.stringify(images) : null;
    if (stock !== undefined) updateData.stock = parseInt(stock);
    if (active !== undefined) updateData.active = Boolean(active);

    if (categoryId !== undefined) {
      const category = await prisma.category.findUnique({ where: { id: parseInt(categoryId) } });
      if (!category) {
        return res.status(404).json({ error: 'Categoría no encontrada', field: 'categoryId' });
      }
      updateData.categoryId = parseInt(categoryId);
    }

    // Actualizar tiendas asignadas (muchos a muchos)
    if (storeIds !== undefined) {
      if (Array.isArray(storeIds) && storeIds.length > 0) {
        const stores = await prisma.store.findMany({
          where: { id: { in: storeIds.map(id => parseInt(id)) } },
        });
        if (stores.length !== storeIds.length) {
          return res.status(400).json({ error: 'Una o más tiendas no encontradas', field: 'storeIds' });
        }
      }
      await prisma.productStore.deleteMany({ where: { productId } });
      if (Array.isArray(storeIds) && storeIds.length > 0) {
        await prisma.productStore.createMany({
          data: storeIds.map(id => ({
            productId,
            storeId: parseInt(id),
          })),
        });
      }
    }

    const updated = await prisma.product.update({
      where: { id: productId },
      data: updateData,
      include: {
        category: true,
        stores: { include: { store: { select: { id: true, name: true } } } },
      },
    });

    res.json({
      message: 'Producto actualizado',
      product: {
        ...updated,
        store: updated.stores.length > 0 ? updated.stores[0].store : null,
        storeIds: updated.stores.map(ps => ps.storeId),
      },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /products/:id - Eliminar producto (soft delete)
router.delete('/:id', authenticate, requirePermission('products.delete'), async (req, res, next) => {
  try {
    const productId = parseInt(req.params.id);

    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { stores: { include: { store: { select: { id: true } } } } },
    });
    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    // Editor solo puede eliminar productos de sus tiendas
    const isEditor = req.user.roles.includes('editor') && !req.user.roles.includes('admin');
    if (isEditor) {
      const userStores = await prisma.userStore.findMany({
        where: { userId: req.user.id },
        select: { storeId: true },
      });
      const userStoreIds = userStores.map(s => s.storeId);
      const productStoreIds = product.stores.map(ps => ps.storeId);
      const hasAccess = productStoreIds.some(id => userStoreIds.includes(id));
      if (!hasAccess && productStoreIds.length > 0) {
        return res.status(403).json({ error: 'Solo puedes eliminar productos de tus tiendas' });
      }
    }

    await prisma.product.update({
      where: { id: productId },
      data: {
        deletedAt: new Date(),
        deletedBy: req.user.id,
        active: false,
      },
    });

    res.json({ message: 'Producto eliminado correctamente' });
  } catch (err) {
    next(err);
  }
});

// POST /products/upload-image - Subir imagen de producto (multipart)
router.post('/upload-image', authenticate, requirePermission('products.create'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se envio ningun archivo' });
    }

    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (!blobToken) {
      return res.status(500).json({ error: 'Configuracion de almacenamiento no disponible' });
    }

    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const blobName = `products/${Date.now()}-${safeName}`;

    const blob = await put(blobName, req.file.buffer, {
      access: 'public',
      contentType: req.file.mimetype,
      addRandomSuffix: false,
    });

    res.status(201).json({ url: blob.url });
  } catch (err) {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'El archivo excede el limite de 5MB' });
      }
    }
    next(err);
  }
});

// POST /products/upload-images - Subir multiples imagenes de producto (multipart)
router.post('/upload-images', authenticate, requirePermission('products.create'), upload.array('files', 10), async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No se enviaron archivos' });
    }

    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (!blobToken) {
      return res.status(500).json({ error: 'Configuracion de almacenamiento no disponible' });
    }

    const urls = [];
    for (const file of req.files) {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      const blobName = `products/${Date.now()}-${safeName}`;
      const blob = await put(blobName, file.buffer, {
        access: 'public',
        contentType: file.mimetype,
        addRandomSuffix: false,
      });
      urls.push(blob.url);
    }

    res.status(201).json({ urls });
  } catch (err) {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Uno o mas archivos exceden el limite de 5MB' });
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: 'Maximo 10 imagenes por envio' });
      }
    }
    next(err);
  }
});

// DELETE /products/delete-image - Eliminar imagen de Vercel Blob
router.delete('/delete-image', authenticate, requirePermission('products.edit'), async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URL de imagen requerida' });
    }

    // Solo eliminar si es una URL de Vercel Blob (productos/)
    if (url.includes('/products/')) {
      try {
        await del(url);
      } catch {
        // Si no existe, no es error
      }
    }

    res.json({ message: 'Imagen eliminada' });
  } catch (err) {
    next(err);
  }
});

export default router;

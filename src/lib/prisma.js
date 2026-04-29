import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const globalForPrisma = globalThis;

function createBaseClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });
}

// ─── Tablas con soft delete ─────────────────────────────────────────────────
const SOFT_DELETE_MODELS = ['Role', 'Address', 'Store', 'Category', 'Product', 'Banner', 'ProductBatch'];
const SOFT_DELETE_TABLES = ['roles', 'addresses', 'stores', 'categories', 'products', 'banners', 'product_batches'];

// ─── Interceptor de soft delete usando Prisma Client Extensions ─────────────
// Reemplaza el antiguo prisma.$use() que fue eliminado en Prisma 5+
function createInterceptor() {
  return async ({ args, query, model }) => {
    // Extraer flag custom y limpiar args antes de pasar a Prisma
    const includeDeleted = args?.includeDeleted;
    const cleanArgs = { ...args };
    delete cleanArgs.includeDeleted;

    // Si el modelo tiene soft delete y no se pidió incluir eliminados, filtrar
    if (SOFT_DELETE_MODELS.includes(model) && !includeDeleted) {
      const hasDeletedAtFilter = cleanArgs?.where?.deletedAt !== undefined;
      if (!hasDeletedAtFilter) {
        cleanArgs.where = { ...cleanArgs.where, deletedAt: null };
      }
    }

    return query(cleanArgs);
  };
}

function createExtendedClient() {
  const baseClient = createBaseClient();
  const interceptor = createInterceptor();

  return baseClient.$extends({
    query: {
      $allModels: {
        // Interceptamos todas las operaciones de lectura
        findMany: interceptor,
        findFirst: interceptor,
        findFirstOrThrow: interceptor,
        findUnique: interceptor,
        findUniqueOrThrow: interceptor,
        count: interceptor,
        aggregate: interceptor,
        groupBy: interceptor,
      },
    },
  });
}

const prisma = globalForPrisma.prisma || createExtendedClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// ─── Auto-migration: crear columnas faltantes en producción ─────────────────
let _migrated = false;
export async function ensureColumns() {
  if (_migrated) return;
  _migrated = true;

  // Columnas de 2FA para users
  const twoFactorColumns = [
    { col: 'two_factor_enabled', def: 'BOOLEAN NOT NULL DEFAULT false' },
    { col: 'two_factor_type', def: "VARCHAR(20) DEFAULT 'email'" },
    { col: 'two_factor_secret', def: 'TEXT DEFAULT NULL' },
    { col: 'two_factor_backup_codes', def: 'TEXT DEFAULT NULL' },
  ];

  for (const { col, def } of twoFactorColumns) {
    try {
      const result = await prisma.$queryRawUnsafe(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = '${col}';
      `);
      if (!result || result.length === 0) {
        console.log(`[DB] Creando columna users.${col}...`);
        await prisma.$executeRawUnsafe(`ALTER TABLE users ADD COLUMN ${col} ${def};`);
        console.log(`[DB] Columna users.${col} creada.`);
      }
    } catch (err) {
      console.error(`[DB] Error en auto-migration users.${col}:`, err.message);
    }
  }

  // Columnas de soft delete: deleted_at y deleted_by para cada tabla
  for (const table of SOFT_DELETE_TABLES) {
    try {
      const result = await prisma.$queryRawUnsafe(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = '${table}' AND column_name = 'deleted_at';
      `);
      if (!result || result.length === 0) {
        console.log(`[DB] Creando columnas soft delete en ${table}...`);
        await prisma.$executeRawUnsafe(`
          ALTER TABLE ${table} ADD COLUMN deleted_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;
          ALTER TABLE ${table} ADD COLUMN deleted_by INTEGER DEFAULT NULL;
        `);
        console.log(`[DB] Columnas soft delete creadas en ${table}.`);
      }
    } catch (err) {
      console.error(`[DB] Error en auto-migration soft delete ${table}:`, err.message);
    }
  }

  // Columna discount_percent en products
  try {
    const result = await prisma.$queryRawUnsafe(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'products' AND column_name = 'discount_percent';
    `);
    if (!result || result.length === 0) {
      console.log('[DB] Creando columna products.discount_percent...');
      await prisma.$executeRawUnsafe(`ALTER TABLE products ADD COLUMN discount_percent FLOAT NOT NULL DEFAULT 0;`);
      console.log('[DB] Columna products.discount_percent creada.');
    }
  } catch (err) {
    console.error('[DB] Error en auto-migration products.discount_percent:', err.message);
  }

  // Tabla product_batches
  try {
    const result = await prisma.$queryRawUnsafe(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'product_batches';
    `);
    if (!result || result.length === 0) {
      console.log('[DB] Creando tabla product_batches...');
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS product_batches (
          id SERIAL PRIMARY KEY,
          name VARCHAR(200) NOT NULL,
          description TEXT,
          discount_percent FLOAT NOT NULL DEFAULT 0,
          category_id INTEGER REFERENCES categories(id),
          store_ids TEXT,
          product_count INTEGER NOT NULL DEFAULT 0,
          status VARCHAR(20) NOT NULL DEFAULT 'pending',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          deleted_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
          deleted_by INTEGER REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_product_batches_status ON product_batches(status);
        CREATE INDEX IF NOT EXISTS idx_product_batches_category_id ON product_batches(category_id);
      `);
      console.log('[DB] Tabla product_batches creada.');
    }
  } catch (err) {
    console.error('[DB] Error en auto-migration product_batches:', err.message);
  }

  // Permisos para product_batches
  try {
    await prisma.$executeRawUnsafe(`
      INSERT INTO permissions (name, code, module, description, "created_at") VALUES 
        ('Ver lotes', 'product_batches.view', 'product_batches', 'Ver lotes de productos', NOW()),
        ('Crear lotes', 'product_batches.create', 'product_batches', 'Crear lotes de productos', NOW()),
        ('Editar lotes', 'product_batches.edit', 'product_batches', 'Editar lotes de productos', NOW()),
        ('Eliminar lotes', 'product_batches.delete', 'product_batches', 'Eliminar lotes de productos', NOW())
      ON CONFLICT (code) DO NOTHING;
    `);
    console.log('[DB] Permisos de product_batches verificados.');
  } catch (err) {
    console.error('[DB] Error insertando permisos product_batches:', err.message);
  }
}

export default prisma;

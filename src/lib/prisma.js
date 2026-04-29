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
const SOFT_DELETE_MODELS = ['Role', 'Address', 'Store', 'Category', 'Product', 'Banner'];
const SOFT_DELETE_TABLES = ['roles', 'addresses', 'stores', 'categories', 'products', 'banners'];

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
}

export default prisma;

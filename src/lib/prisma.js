import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const globalForPrisma = globalThis;

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });
}

const prisma = globalForPrisma.prisma || createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// ─── Tablas con soft delete ─────────────────────────────────────────────────
const SOFT_DELETE_TABLES = [
  'roles',
  'addresses',
  'stores',
  'categories',
  'products',
  'banners',
];

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

// ─── Prisma Middleware: filtrar registros eliminados (soft delete) ──────────
// Aplica automáticamente `where: { deletedAt: null }` a todas las queries
// de las tablas con soft delete, excepto cuando se usa `findDeleted` en args.
prisma.$use(async (params, next) => {
  const model = params.model;
  const modelName = model ? model.charAt(0).toUpperCase() + model.slice(1) : '';

  // Mapear nombre del modelo a la tabla de soft delete
  const softDeleteModels = {
    Role: 'roles',
    Address: 'addresses',
    Store: 'stores',
    Category: 'categories',
    Product: 'products',
    Banner: 'banners',
  };

  const isSoftDeleteModel = modelName && softDeleteModels[modelName];

  // Si el modelo tiene soft delete y la operación es de lectura, filtrar eliminados
  if (isSoftDeleteModel && !params.args?.includeDeleted) {
    const readActions = ['findMany', 'findFirst', 'findUnique', 'count', 'aggregate', 'groupBy'];
    if (readActions.includes(params.action)) {
      // No filtrar si se busca explícitamente por deletedAt
      const hasDeletedAtFilter = params.args?.where?.deletedAt !== undefined;
      if (!hasDeletedAtFilter) {
        params.args = {
          ...params.args,
          where: {
            ...params.args.where,
            deletedAt: null,
          },
        };
      }
    }
  }

  return next(params);
});

export default prisma;

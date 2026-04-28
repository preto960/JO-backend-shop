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

// ─── Auto-migration: crear columnas faltantes en producción ─────────────────
// Esto asegura que columnas nuevas (como two_factor_enabled) existan en la DB
// sin necesidad de correr migraciones manualmente en Vercel/Neon/Supabase.
let _migrated = false;
export async function ensureColumns() {
  if (_migrated) return;
  _migrated = true;

  try {
    const result = await prisma.$queryRawUnsafe(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'two_factor_enabled';
    `);
    if (!result || result.length === 0) {
      console.log('[DB] Creando columna faltante: two_factor_enabled...');
      await prisma.$executeRawUnsafe(`
        ALTER TABLE users ADD COLUMN two_factor_enabled BOOLEAN NOT NULL DEFAULT false;
      `);
      console.log('[DB] Columna two_factor_enabled creada exitosamente.');
    }
  } catch (err) {
    console.error('[DB] Error en auto-migration:', err.message);
  }
}

export default prisma;

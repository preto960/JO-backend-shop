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
// Esto asegura que columnas nuevas (como two_factor_enabled, two_factor_type, etc.)
// existan en la DB sin necesidad de correr migraciones manualmente en Vercel/Neon/Supabase.
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

  // Columna: two_factor_type (email | totp)
  try {
    const result = await prisma.$queryRawUnsafe(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'two_factor_type';
    `);
    if (!result || result.length === 0) {
      console.log('[DB] Creando columna: two_factor_type...');
      await prisma.$executeRawUnsafe(`
        ALTER TABLE users ADD COLUMN two_factor_type VARCHAR(20) DEFAULT 'email';
      `);
      console.log('[DB] Columna two_factor_type creada exitosamente.');
    }
  } catch (err) {
    console.error('[DB] Error en auto-migration two_factor_type:', err.message);
  }

  // Columna: two_factor_secret (para TOTP)
  try {
    const result = await prisma.$queryRawUnsafe(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'two_factor_secret';
    `);
    if (!result || result.length === 0) {
      console.log('[DB] Creando columna: two_factor_secret...');
      await prisma.$executeRawUnsafe(`
        ALTER TABLE users ADD COLUMN two_factor_secret TEXT DEFAULT NULL;
      `);
      console.log('[DB] Columna two_factor_secret creada exitosamente.');
    }
  } catch (err) {
    console.error('[DB] Error en auto-migration two_factor_secret:', err.message);
  }

  // Columna: two_factor_backup_codes (JSON array de códigos de recuperación)
  try {
    const result = await prisma.$queryRawUnsafe(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'two_factor_backup_codes';
    `);
    if (!result || result.length === 0) {
      console.log('[DB] Creando columna: two_factor_backup_codes...');
      await prisma.$executeRawUnsafe(`
        ALTER TABLE users ADD COLUMN two_factor_backup_codes TEXT DEFAULT NULL;
      `);
      console.log('[DB] Columna two_factor_backup_codes creada exitosamente.');
    }
  } catch (err) {
    console.error('[DB] Error en auto-migration two_factor_backup_codes:', err.message);
  }
}

export default prisma;

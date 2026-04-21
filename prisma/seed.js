import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// ─── Permisos por módulo ───────────────────────────────────────────────────────
const MODULES = {
  products: {
    name: 'Productos',
    permissions: [
      { name: 'Ver menú Productos', code: 'products.view_menu', description: 'Permite ver el módulo de productos en el menú' },
      { name: 'Leer productos', code: 'products.read', description: 'Permite ver la lista y detalle de productos' },
      { name: 'Crear productos', code: 'products.create', description: 'Permite crear nuevos productos' },
      { name: 'Editar productos', code: 'products.edit', description: 'Permite editar productos existentes' },
      { name: 'Eliminar productos', code: 'products.delete', description: 'Permite eliminar productos' },
    ],
  },
  categories: {
    name: 'Categorías',
    permissions: [
      { name: 'Ver menú Categorías', code: 'categories.view_menu', description: 'Permite ver el módulo de categorías en el menú' },
      { name: 'Leer categorías', code: 'categories.read', description: 'Permite ver la lista de categorías' },
      { name: 'Crear categorías', code: 'categories.create', description: 'Permite crear nuevas categorías' },
      { name: 'Editar categorías', code: 'categories.edit', description: 'Permite editar categorías existentes' },
      { name: 'Eliminar categorías', code: 'categories.delete', description: 'Permite eliminar categorías' },
    ],
  },
  orders: {
    name: 'Pedidos',
    permissions: [
      { name: 'Ver menú Pedidos', code: 'orders.view_menu', description: 'Permite ver el módulo de pedidos en el menú' },
      { name: 'Leer pedidos', code: 'orders.read', description: 'Permite ver la lista y detalle de pedidos' },
      { name: 'Crear pedidos', code: 'orders.create', description: 'Permite crear nuevos pedidos' },
      { name: 'Editar pedidos', code: 'orders.edit', description: 'Permite cambiar estado de pedidos' },
      { name: 'Eliminar pedidos', code: 'orders.delete', description: 'Permite cancelar/eliminar pedidos' },
    ],
  },
  users: {
    name: 'Usuarios',
    permissions: [
      { name: 'Ver menú Usuarios', code: 'users.view_menu', description: 'Permite ver el módulo de usuarios en el menú' },
      { name: 'Leer usuarios', code: 'users.read', description: 'Permite ver la lista de usuarios' },
      { name: 'Crear usuarios', code: 'users.create', description: 'Permite crear nuevos usuarios' },
      { name: 'Editar usuarios', code: 'users.edit', description: 'Permite editar datos de usuarios' },
      { name: 'Eliminar usuarios', code: 'users.delete', description: 'Permite desactivar/eliminar usuarios' },
    ],
  },
  dashboard: {
    name: 'Dashboard',
    permissions: [
      { name: 'Ver menú Dashboard', code: 'dashboard.view_menu', description: 'Permite ver el módulo del panel principal' },
      { name: 'Ver Dashboard', code: 'dashboard.view', description: 'Permite acceder al panel principal con estadísticas' },
    ],
  },
};

async function main() {
  console.log('🌱 Seeding database...\n');

  // ─── Limpiar datos existentes (orden por dependencias) ─────────────────────
  await prisma.userPermission.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.user.deleteMany();
  await prisma.permission.deleteMany();
  await prisma.role.deleteMany();

  // ─── Crear permisos ───────────────────────────────────────────────────────
  const allPermissions = [];
  for (const [module, config] of Object.entries(MODULES)) {
    for (const perm of config.permissions) {
      const created = await prisma.permission.create({
        data: {
          name: perm.name,
          code: perm.code,
          module,
          description: perm.description,
        },
      });
      allPermissions.push(created);
    }
  }
  console.log(`✅ ${allPermissions.length} permisos creados (${Object.keys(MODULES).length} módulos)`);

  // ─── Crear roles ──────────────────────────────────────────────────────────
  const adminRole = await prisma.role.create({
    data: {
      name: 'admin',
      description: 'Administrador total del sistema. Acceso completo a todos los módulos.',
      active: true,
    },
  });

  const customerRole = await prisma.role.create({
    data: {
      name: 'customer',
      description: 'Cliente. Puede ver productos, crear pedidos y ver sus propios pedidos.',
      active: true,
    },
  });

  const editorRole = await prisma.role.create({
    data: {
      name: 'editor',
      description: 'Editor. Puede gestionar productos y categorías pero no usuarios ni pedidos.',
      active: true,
    },
  });

  console.log(`✅ 3 roles creados: admin, customer, editor`);

  // ─── Asignar permisos a roles ─────────────────────────────────────────────

  // Admin: TODOS los permisos
  const allPermCodes = allPermissions.map(p => p.code);
  await prisma.rolePermission.createMany({
    data: allPermissions.map(p => ({
      roleId: adminRole.id,
      permissionId: p.id,
    })),
  });

  // Customer: solo leer y crear pedidos, ver menú de productos/categorías
  const customerPermCodes = [
    'products.view_menu', 'products.read',
    'categories.view_menu', 'categories.read',
    'orders.view_menu', 'orders.read', 'orders.create', 'orders.delete',
  ];
  const customerPerms = allPermissions.filter(p => customerPermCodes.includes(p.code));
  await prisma.rolePermission.createMany({
    data: customerPerms.map(p => ({
      roleId: customerRole.id,
      permissionId: p.id,
    })),
  });

  // Editor: productos y categorías completos + dashboard
  const editorPermCodes = [
    'dashboard.view_menu', 'dashboard.view',
    'products.view_menu', 'products.read', 'products.create', 'products.edit', 'products.delete',
    'categories.view_menu', 'categories.read', 'categories.create', 'categories.edit', 'categories.delete',
  ];
  const editorPerms = allPermissions.filter(p => editorPermCodes.includes(p.code));
  await prisma.rolePermission.createMany({
    data: editorPerms.map(p => ({
      roleId: editorRole.id,
      permissionId: p.id,
    })),
  });

  console.log(`✅ Permisos asignados a roles`);

  // ─── Crear usuarios ───────────────────────────────────────────────────────
  const adminPassword = await bcrypt.hash('Admin123', 12);
  const customerPassword = await bcrypt.hash('Cliente123', 12);
  const editorPassword = await bcrypt.hash('Editor123', 12);

  const admin = await prisma.user.create({
    data: {
      name: 'Administrador',
      email: 'admin@joshop.com',
      password: adminPassword,
      active: true,
      emailVerified: new Date(),
    },
  });

  const customer = await prisma.user.create({
    data: {
      name: 'Cliente Demo',
      email: 'cliente@joshop.com',
      password: customerPassword,
      active: true,
      emailVerified: new Date(),
    },
  });

  const editor = await prisma.user.create({
    data: {
      name: 'Editor Demo',
      email: 'editor@joshop.com',
      password: editorPassword,
      active: true,
      emailVerified: new Date(),
    },
  });

  console.log('✅ Usuarios creados');

  // ─── Asignar roles a usuarios ─────────────────────────────────────────────
  await prisma.userRole.createMany([
    { userId: admin.id, roleId: adminRole.id },
    { userId: customer.id, roleId: customerRole.id },
    { userId: editor.id, roleId: editorRole.id },
  ]);

  console.log('✅ Roles asignados a usuarios');

  // ─── Ejemplo de permiso directo a usuario ─────────────────────────────────
  // Le damos al editor permiso directo para ver pedidos (aunque su rol no lo tenga)
  const ordersViewMenu = allPermissions.find(p => p.code === 'orders.view_menu');
  if (ordersViewMenu) {
    await prisma.userPermission.create({
      data: {
        userId: editor.id,
        permissionId: ordersViewMenu.id,
      },
    });
    console.log('✅ Permiso directo "orders.view_menu" asignado al editor');
  }

  // ─── Crear categorías ────────────────────────────────────────────────────
  const categories = await Promise.all([
    prisma.category.create({ data: { name: 'Electrónica', slug: 'electronica' } }),
    prisma.category.create({ data: { name: 'Ropa', slug: 'ropa' } }),
    prisma.category.create({ data: { name: 'Alimentos', slug: 'alimentos' } }),
    prisma.category.create({ data: { name: 'Hogar', slug: 'hogar' } }),
    prisma.category.create({ data: { name: 'Deportes', slug: 'deportes' } }),
  ]);

  console.log(`✅ ${categories.length} categorías creadas`);

  // ─── Crear productos ─────────────────────────────────────────────────────
  const productsData = [
    { name: 'Auriculares Bluetooth Pro', slug: 'auriculares-bluetooth-pro', description: 'Auriculares inalámbricos con cancelación de ruido activa, batería de 30 horas y sonido Hi-Fi.', price: 49.99, image: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=400', thumbnail: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=150', stock: 45, categoryId: categories[0].id },
    { name: 'Smart Watch Fitness', slug: 'smart-watch-fitness', description: 'Reloj inteligente con monitor cardíaco, GPS integrado y más de 100 modos de deporte.', price: 129.99, image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400', thumbnail: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=150', stock: 28, categoryId: categories[0].id },
    { name: 'Cargador Inalámbrico Rápido', slug: 'cargador-inalambrico-rapido', description: 'Cargador de escritorio con carga rápida de 15W, compatible con todos los dispositivos Qi.', price: 24.99, image: 'https://images.unsplash.com/photo-1586953208448-b95a79798f07?w=400', thumbnail: 'https://images.unsplash.com/photo-1586953208448-b95a79798f07?w=150', stock: 60, categoryId: categories[0].id },
    { name: 'Speaker Portátil Mini', slug: 'speaker-portatil-mini', description: 'Altavoz Bluetooth compacto con sonido 360°, resistente al agua IPX7.', price: 34.99, image: 'https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?w=400', thumbnail: 'https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?w=150', stock: 35, categoryId: categories[0].id },
    { name: 'Camiseta Algodón Premium', slug: 'camiseta-algodon-premium', description: 'Camiseta de algodón orgánico 100%, corte regular, suave al tacto.', price: 19.99, image: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=400', thumbnail: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=150', stock: 100, categoryId: categories[1].id },
    { name: 'Zapatillas Urbanas', slug: 'zapatillas-urbanas', description: 'Zapatillas casuales con suela ergonómica, transpirables y ligeras.', price: 59.99, image: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400', thumbnail: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=150', stock: 40, categoryId: categories[1].id },
    { name: 'Mochila Antirrobo', slug: 'mochila-antirrobo', description: 'Mochila de 25L con puerto USB, compartimento laptop 15.6" y cierre antirrobo.', price: 39.99, image: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=400', thumbnail: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=150', stock: 55, categoryId: categories[1].id },
    { name: 'Café Arábica Premium 500g', slug: 'cafe-arabica-premium', description: 'Granos de café 100% arábica de origen único, tostado medio.', price: 14.99, image: 'https://images.unsplash.com/photo-1559056199-641a0ac8b55e?w=400', thumbnail: 'https://images.unsplash.com/photo-1559056199-641a0ac8b55e?w=150', stock: 80, categoryId: categories[2].id },
    { name: 'Aceite de Oliva Extra Virgen', slug: 'aceite-oliva-extra-virgen', description: 'Aceite de oliva prensado en frío, de cultivos orgánicos. Botella de 750ml.', price: 18.50, image: 'https://images.unsplash.com/photo-1474979266404-7f28db3e3e6c?w=400', thumbnail: 'https://images.unsplash.com/photo-1474979266404-7f28db3e3e6c?w=150', stock: 65, categoryId: categories[2].id },
    { name: 'Miel Orgánica Natural 350g', slug: 'miel-organica-natural', description: 'Miel cruda 100% natural, sin aditivos ni procesamiento.', price: 12.99, image: 'https://images.unsplash.com/photo-1587049352846-4a222e784d38?w=400', thumbnail: 'https://images.unsplash.com/photo-1587049352846-4a222e784d38?w=150', stock: 90, categoryId: categories[2].id },
    { name: 'Lámpara LED de Escritorio', slug: 'lampara-led-escritorio', description: 'Lámpara regulable con 5 niveles de brillo, luz cálida y fría, brazo flexible.', price: 29.99, image: 'https://images.unsplash.com/photo-1507473885765-e6ed057ab6fe?w=400', thumbnail: 'https://images.unsplash.com/photo-1507473885765-e6ed057ab6fe?w=150', stock: 50, categoryId: categories[3].id },
    { name: 'Set de Organizadores 3 piezas', slug: 'set-organizadores-3-piezas', description: 'Cajas organizadoras de tela resistente en 3 tamaños.', price: 22.99, image: 'https://images.unsplash.com/photo-1581783898377-1c85bf937427?w=400', thumbnail: 'https://images.unsplash.com/photo-1581783898377-1c85bf937427?w=150', stock: 70, categoryId: categories[3].id },
    { name: 'Botella Térmica 1L', slug: 'botella-termica-1l', description: 'Mantiene bebidas frías 24h y calientes 12h. Acero inoxidable doble pared.', price: 27.99, image: 'https://images.unsplash.com/photo-1602143407151-7111542de6e8?w=400', thumbnail: 'https://images.unsplash.com/photo-1602143407151-7111542de6e8?w=150', stock: 75, categoryId: categories[4].id },
    { name: 'Esterilla de Yoga Antideslizante', slug: 'esterilla-yoga-antideslizante', description: 'Esterilla de 6mm con textura antideslizante doble cara, material TPE ecológico.', price: 21.99, image: 'https://images.unsplash.com/photo-1601925260368-ae2f83cf8b7f?w=400', thumbnail: 'https://images.unsplash.com/photo-1601925260368-ae2f83cf8b7f?w=150', stock: 42, categoryId: categories[4].id },
    { name: 'Banda de Resistencia Set', slug: 'banda-resistencia-set', description: 'Set de 5 bandas elásticas con diferentes niveles de resistencia.', price: 16.99, image: 'https://images.unsplash.com/photo-1598289431512-b97b0917affc?w=400', thumbnail: 'https://images.unsplash.com/photo-1598289431512-b97b0917affc?w=150', stock: 85, categoryId: categories[4].id },
  ];

  const createdProducts = [];
  for (const product of productsData) {
    const created = await prisma.product.create({ data: product });
    createdProducts.push(created);
  }

  console.log(`✅ ${createdProducts.length} productos creados`);

  // ─── Resumen ──────────────────────────────────────────────────────────────
  const totalStock = createdProducts.reduce((sum, p) => sum + p.stock, 0);

  console.log(`\n📊 Resumen general:`);
  console.log(`   Roles: 3 (admin, customer, editor)`);
  console.log(`   Permisos: ${allPermissions.length} (${Object.keys(MODULES).length} módulos)`);
  console.log(`   Usuarios: 3`);
  console.log(`   Categorías: ${categories.length}`);
  console.log(`   Productos: ${createdProducts.length}`);
  console.log(`   Stock total: ${totalStock} unidades`);

  console.log(`\n🔐 Credenciales de prueba:`);
  console.log(`   ADMIN:   admin@joshop.com / Admin123 (acceso total)`);
  console.log(`   EDITOR:  editor@joshop.com / Editor123 (productos + categorías)`);
  console.log(`   CLIENTE: cliente@joshop.com / Cliente123 (solo compra)`);

  console.log(`\n📋 Módulos y permisos:`);
  for (const [module, config] of Object.entries(MODULES)) {
    console.log(`   ${config.name}: ${config.permissions.map(p => p.code).join(', ')}`);
  }

  console.log('\n✨ Seed completado exitosamente\n');
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (e) => {
    console.error('❌ Error en seed:', e);
    await prisma.$disconnect();
    process.exit(1);
  });

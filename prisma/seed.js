import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...\n');

  // Limpiar datos existentes
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();

  // Crear categorías
  const categories = await Promise.all([
    prisma.category.create({
      data: { name: 'Electrónica', slug: 'electronica' },
    }),
    prisma.category.create({
      data: { name: 'Ropa', slug: 'ropa' },
    }),
    prisma.category.create({
      data: { name: 'Alimentos', slug: 'alimentos' },
    }),
    prisma.category.create({
      data: { name: 'Hogar', slug: 'hogar' },
    }),
    prisma.category.create({
      data: { name: 'Deportes', slug: 'deportes' },
    }),
  ]);

  console.log(`✅ ${categories.length} categorías creadas`);

  // Crear productos
  const products = [
    // Electrónica
    {
      name: 'Auriculares Bluetooth Pro',
      slug: 'auriculares-bluetooth-pro',
      description: 'Auriculares inalámbricos con cancelación de ruido activa, batería de 30 horas y sonido Hi-Fi. Perfectos para música, llamadas y trabajo remoto.',
      price: 49.99,
      image: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=400',
      thumbnail: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=150',
      stock: 45,
      categoryId: categories[0].id,
    },
    {
      name: 'Smart Watch Fitness',
      slug: 'smart-watch-fitness',
      description: 'Reloj inteligente con monitor cardíaco, GPS integrado, resistencia al agua y más de 100 modos de deporte. Compatible con Android e iOS.',
      price: 129.99,
      image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400',
      thumbnail: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=150',
      stock: 28,
      categoryId: categories[0].id,
    },
    {
      name: 'Cargador Inalámbrico Rápido',
      slug: 'cargador-inalambrico-rapido',
      description: 'Cargador de escritorio con carga rápida de 15W, compatible con todos los dispositivos Qi. Diseño elegante LED.',
      price: 24.99,
      image: 'https://images.unsplash.com/photo-1586953208448-b95a79798f07?w=400',
      thumbnail: 'https://images.unsplash.com/photo-1586953208448-b95a79798f07?w=150',
      stock: 60,
      categoryId: categories[0].id,
    },
    {
      name: 'Speaker Portátil Mini',
      slug: 'speaker-portatil-mini',
      description: 'Altavoz Bluetooth compacto con sonido 360°, resistente al agua IPX7 y 12 horas de batería. Ideal para outdoor.',
      price: 34.99,
      image: 'https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?w=400',
      thumbnail: 'https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?w=150',
      stock: 35,
      categoryId: categories[0].id,
    },

    // Ropa
    {
      name: 'Camiseta Algodón Premium',
      slug: 'camiseta-algodon-premium',
      description: 'Camiseta de algodón orgánico 100%, corte regular, suave al tacto. Disponible en varios colores.',
      price: 19.99,
      image: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=400',
      thumbnail: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=150',
      stock: 100,
      categoryId: categories[1].id,
    },
    {
      name: 'Zapatillas Urbanas',
      slug: 'zapatillas-urbanas',
      description: 'Zapatillas casuales con suela ergonómica, transpirables y ligeras. Perfectas para el día a día.',
      price: 59.99,
      image: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400',
      thumbnail: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=150',
      stock: 40,
      categoryId: categories[1].id,
    },
    {
      name: 'Mochila Antirrobo',
      slug: 'mochila-antirrobo',
      description: 'Mochila de 25L con puerto USB, compartimento laptop 15.6", material impermeable y cierre antirrobo.',
      price: 39.99,
      image: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=400',
      thumbnail: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=150',
      stock: 55,
      categoryId: categories[1].id,
    },

    // Alimentos
    {
      name: 'Café Arábica Premium 500g',
      slug: 'cafe-arabica-premium',
      description: 'Granos de café 100% arábica de origen único, tostado medio. Notas de chocolate y caramelo.',
      price: 14.99,
      image: 'https://images.unsplash.com/photo-1559056199-641a0ac8b55e?w=400',
      thumbnail: 'https://images.unsplash.com/photo-1559056199-641a0ac8b55e?w=150',
      stock: 80,
      categoryId: categories[2].id,
    },
    {
      name: 'Aceite de Oliva Extra Virgen',
      slug: 'aceite-oliva-extra-virgen',
      description: 'Aceite de oliva prensado en frío, de cultivos orgánicos. Botella de 750ml con sabor intenso y afrutado.',
      price: 18.50,
      image: 'https://images.unsplash.com/photo-1474979266404-7f28db3e3e6c?w=400',
      thumbnail: 'https://images.unsplash.com/photo-1474979266404-7f28db3e3e6c?w=150',
      stock: 65,
      categoryId: categories[2].id,
    },
    {
      name: 'Miel Orgánica Natural 350g',
      slug: 'miel-organica-natural',
      description: 'Miel cruda 100% natural de abejas, sin aditivos ni procesamiento. Rica en antioxidantes.',
      price: 12.99,
      image: 'https://images.unsplash.com/photo-1587049352846-4a222e784d38?w=400',
      thumbnail: 'https://images.unsplash.com/photo-1587049352846-4a222e784d38?w=150',
      stock: 90,
      categoryId: categories[2].id,
    },

    // Hogar
    {
      name: 'Lámpara LED de Escritorio',
      slug: 'lampara-led-escritorio',
      description: 'Lámpara regulable con 5 niveles de brillo, luz cálida y fría, brazo flexible y base estable.',
      price: 29.99,
      image: 'https://images.unsplash.com/photo-1507473885765-e6ed057ab6fe?w=400',
      thumbnail: 'https://images.unsplash.com/photo-1507473885765-e6ed057ab6fe?w=150',
      stock: 50,
      categoryId: categories[3].id,
    },
    {
      name: 'Set de Organizadores 3 piezas',
      slug: 'set-organizadores-3-piezas',
      description: 'Cajas organizadoras de tela resistente en 3 tamaños. Ideales para armario, baño y escritorio.',
      price: 22.99,
      image: 'https://images.unsplash.com/photo-1581783898377-1c85bf937427?w=400',
      thumbnail: 'https://images.unsplash.com/photo-1581783898377-1c85bf937427?w=150',
      stock: 70,
      categoryId: categories[3].id,
    },

    // Deportes
    {
      name: 'Botella Térmica 1L',
      slug: 'botella-termica-1l',
      description: 'Mantiene bebidas frías 24h y calientes 12h. Acero inoxidable doble pared, libre de BPA.',
      price: 27.99,
      image: 'https://images.unsplash.com/photo-1602143407151-7111542de6e8?w=400',
      thumbnail: 'https://images.unsplash.com/photo-1602143407151-7111542de6e8?w=150',
      stock: 75,
      categoryId: categories[4].id,
    },
    {
      name: 'Esterilla de Yoga Antideslizante',
      slug: 'esterilla-yoga-antideslizante',
      description: 'Esterilla de 6mm con textura antideslizante doble cara, material TPE ecológico. Incluye correa de transporte.',
      price: 21.99,
      image: 'https://images.unsplash.com/photo-1601925260368-ae2f83cf8b7f?w=400',
      thumbnail: 'https://images.unsplash.com/photo-1601925260368-ae2f83cf8b7f?w=150',
      stock: 42,
      categoryId: categories[4].id,
    },
    {
      name: 'Banda de Resistencia Set',
      slug: 'banda-resistencia-set',
      description: 'Set de 5 bandas elásticas con diferentes niveles de resistencia. Incluye bolsa de transporte.',
      price: 16.99,
      image: 'https://images.unsplash.com/photo-1598289431512-b97b0917affc?w=400',
      thumbnail: 'https://images.unsplash.com/photo-1598289431512-b97b0917affc?w=150',
      stock: 85,
      categoryId: categories[4].id,
    },
  ];

  const createdProducts = [];
  for (const product of products) {
    const created = await prisma.product.create({ data: product });
    createdProducts.push(created);
  }

  console.log(`✅ ${createdProducts.length} productos creados`);
  console.log(`\n📊 Resumen:`);
  console.log(`   Categorías: ${categories.length}`);
  console.log(`   Productos: ${createdProducts.length}`);

  const totalStock = createdProducts.reduce((sum, p) => sum + p.stock, 0);
  console.log(`   Stock total: ${totalStock} unidades`);

  console.log('\n✨ Seed completado exitosamente\n');
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('❌ Error en seed:', e);
    await prisma.$disconnect();
    process.exit(1);
  });

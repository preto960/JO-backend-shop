# JO-backend-shop

Backend API para la app móvil JO-Shop. Desplegado en Vercel con base de datos PostgreSQL en Neon.

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Estado del servicio |
| GET | `/` | Información de la API |
| GET | `/products` | Listar productos |
| GET | `/products/:id` | Detalle de producto |
| GET | `/products/search?q=` | Buscar productos |
| GET | `/categories` | Listar categorías |
| GET | `/orders` | Listar pedidos |
| GET | `/orders/:id` | Detalle de pedido |
| POST | `/orders` | Crear pedido |

## Parámetros de consulta

### GET /products
- `page` - Número de página (default: 1)
- `limit` - Elementos por página (default: 20)
- `category` - Filtrar por ID de categoría
- `sort` - Ordenar: `newest`, `price_asc`, `price_desc`, `name`

### GET /products/search
- `q` - Término de búsqueda (requerido)
- `category` - Filtrar por categoría
- `page` - Número de página
- `limit` - Elementos por página

## Stack

- Node.js + Express
- Prisma ORM
- PostgreSQL (Neon)
- Vercel (deploy)

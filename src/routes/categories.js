import express from 'express';
import prisma from '../lib/prisma.js';

const router = express.Router();

// GET /categories - Listar categorías
router.get('/', async (req, res, next) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: { products: { where: { active: true } } },
        },
      },
    });

    res.json(categories);
  } catch (err) {
    next(err);
  }
});

export default router;

import express from 'express';
import prisma from '../lib/prisma.js';
import {
  hashPassword,
  comparePassword,
  generateToken,
  generateRefreshToken,
  isValidEmail,
  validatePassword,
  sanitize,
} from '../services/auth.js';

const router = express.Router();

// POST /auth/register - Registro
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, phone } = req.body;

    // Validaciones
    const sanitizedName = sanitize(name);
    const sanitizedEmail = sanitize(email)?.toLowerCase();

    if (!sanitizedName || sanitizedName.length < 2) {
      return res.status(400).json({
        error: 'El nombre es requerido (mínimo 2 caracteres)',
        field: 'name',
      });
    }

    if (!sanitizedEmail || !isValidEmail(sanitizedEmail)) {
      return res.status(400).json({
        error: 'Email inválido',
        field: 'email',
      });
    }

    if (!password) {
      return res.status(400).json({
        error: 'La contraseña es requerida',
        field: 'password',
      });
    }

    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({
        error: passwordValidation.message,
        field: 'password',
      });
    }

    // Verificar si el email ya existe
    const existingUser = await prisma.user.findUnique({
      where: { email: sanitizedEmail },
    });

    if (existingUser) {
      return res.status(409).json({
        error: 'Ya existe una cuenta con ese email',
        field: 'email',
      });
    }

    // Crear usuario
    const hashedPassword = await hashPassword(password);
    const user = await prisma.user.create({
      data: {
        name: sanitizedName,
        email: sanitizedEmail,
        password: hashedPassword,
        phone: phone ? sanitize(phone) : null,
        role: 'customer',
        emailVerified: new Date(),
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        phone: true,
        createdAt: true,
      },
    });

    // Generar tokens
    const token = generateToken(user);
    const refreshToken = generateRefreshToken(user);

    res.status(201).json({
      message: 'Cuenta creada exitosamente',
      user,
      token,
      refreshToken,
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/login - Inicio de sesión
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Email y contraseña son requeridos',
        field: !email ? 'email' : 'password',
      });
    }

    const sanitizedEmail = sanitize(email)?.toLowerCase();

    // Buscar usuario
    const user = await prisma.user.findUnique({
      where: { email: sanitizedEmail },
    });

    if (!user) {
      return res.status(401).json({
        error: 'Credenciales inválidas',
        code: 'INVALID_CREDENTIALS',
      });
    }

    if (!user.active) {
      return res.status(403).json({
        error: 'Tu cuenta ha sido desactivada',
        code: 'ACCOUNT_DISABLED',
      });
    }

    // Verificar contraseña
    const isMatch = await comparePassword(password, user.password);
    if (!isMatch) {
      return res.status(401).json({
        error: 'Credenciales inválidas',
        code: 'INVALID_CREDENTIALS',
      });
    }

    // Generar tokens
    const token = generateToken(user);
    const refreshToken = generateRefreshToken(user);

    res.json({
      message: 'Inicio de sesión exitoso',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone,
      },
      token,
      refreshToken,
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/refresh - Renovar token
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken: token } = req.body;

    if (!token) {
      return res.status(400).json({
        error: 'Refresh token requerido',
      });
    }

    const decoded = verifyToken(token);
    if (!decoded || decoded.valid === false || decoded.type !== 'refresh') {
      return res.status(401).json({
        error: 'Refresh token inválido o expirado',
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, role: true, name: true, active: true },
    });

    if (!user || !user.active) {
      return res.status(401).json({
        error: 'Usuario no encontrado o inactivo',
      });
    }

    const newToken = generateToken(user);
    const newRefreshToken = generateRefreshToken(user);

    res.json({
      message: 'Token renovado',
      token: newToken,
      refreshToken: newRefreshToken,
    });
  } catch (err) {
    next(err);
  }
});

// GET /auth/me - Perfil del usuario autenticado
router.get('/me', async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token requerido' });
    }

    const { verifyToken } = await import('../services/auth.js');
    const decoded = verifyToken(authHeader.split(' ')[1]);

    if (!decoded || decoded.valid === false) {
      return res.status(401).json({ error: 'Token inválido' });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        phone: true,
        active: true,
        emailVerified: true,
        createdAt: true,
        _count: {
          select: { orders: true },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json(user);
  } catch (err) {
    next(err);
  }
});

// PUT /auth/profile - Actualizar perfil
router.put('/profile', async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token requerido' });
    }

    const { verifyToken } = await import('../services/auth.js');
    const decoded = verifyToken(authHeader.split(' ')[1]);
    if (!decoded || decoded.valid === false) {
      return res.status(401).json({ error: 'Token inválido' });
    }

    const { name, phone, currentPassword, newPassword } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const updateData = {};

    if (name) {
      updateData.name = sanitize(name);
    }

    if (phone !== undefined) {
      updateData.phone = sanitize(phone) || null;
    }

    // Cambiar contraseña
    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({
          error: 'Contraseña actual requerida para cambiarla',
          field: 'currentPassword',
        });
      }

      const isMatch = await comparePassword(currentPassword, user.password);
      if (!isMatch) {
        return res.status(401).json({
          error: 'Contraseña actual incorrecta',
          field: 'currentPassword',
        });
      }

      const passwordValidation = validatePassword(newPassword);
      if (!passwordValidation.valid) {
        return res.status(400).json({
          error: passwordValidation.message,
          field: 'newPassword',
        });
      }

      updateData.password = await hashPassword(newPassword);
    }

    const updatedUser = await prisma.user.update({
      where: { id: decoded.id },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        phone: true,
        createdAt: true,
      },
    });

    res.json({
      message: 'Perfil actualizado',
      user: updatedUser,
    });
  } catch (err) {
    next(err);
  }
});

export default router;

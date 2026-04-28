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
import { getUserPermissions } from '../middleware/auth.js';
import { sendWelcomeEmail, sendOtpEmail, isEmailConfigured } from '../services/email.js';

const router = express.Router();

// Helper: Formatear respuesta del usuario
const formatUserResponse = async (user) => {
  const { roles, permissions } = await getUserPermissions(user.id);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    birthdate: user.birthdate,
    active: user.active,
    twoFactorEnabled: user.twoFactorEnabled || false,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
    roles,
    permissions,
  };
};

// POST /auth/register - Registro
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, phone, birthdate, role } = req.body;

    const sanitizedName = sanitize(name);
    const sanitizedEmail = sanitize(email)?.toLowerCase();
    const sanitizedRole = sanitize(role)?.toLowerCase();

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
        birthdate: birthdate ? sanitize(birthdate) : null,
        emailVerified: new Date(),
      },
    });

    // Asignar rol: delivery o customer (por defecto)
    const allowedRoles = ['customer', 'delivery'];
    const targetRole = allowedRoles.includes(sanitizedRole) ? sanitizedRole : 'customer';
    const assignedRole = await prisma.role.findUnique({ where: { name: targetRole } });
    if (assignedRole) {
      await prisma.userRole.create({
        data: { userId: user.id, roleId: assignedRole.id },
      });
    }

    // Obtener permisos del usuario
    const { roles, permissions } = await getUserPermissions(user.id);

    const token = generateToken(user, roles, permissions);
    const refreshToken = generateRefreshToken(user);

    res.status(201).json({
      message: 'Cuenta creada exitosamente',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        roles,
        permissions,
      },
      token,
      refreshToken,
    });

    // Enviar correo de bienvenida (fire & forget)
    sendWelcomeEmail({ name: user.name, email: user.email }).catch(() => {});
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

    const isMatch = await comparePassword(password, user.password);
    if (!isMatch) {
      return res.status(401).json({
        error: 'Credenciales inválidas',
        code: 'INVALID_CREDENTIALS',
      });
    }

    // === 2FA: Solo si el usuario lo tiene activado ===
    if (user.twoFactorEnabled) {
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

      // Eliminar OTPs anteriores para este email+tipo
      await prisma.otpVerification.deleteMany({
        where: { email: user.email, type: 'login' },
      });

      // Crear nuevo OTP
      await prisma.otpVerification.create({
        data: {
          userId: user.id,
          email: user.email,
          code: otpCode,
          type: 'login',
          expiresAt,
        },
      });

      // Enviar OTP por email
      if (isEmailConfigured()) {
        await sendOtpEmail({ to: user.email, code: otpCode, type: 'login' });
      } else {
        console.log(`[2FA] SMTP no configurado. Codigo para ${user.email}: ${otpCode}`);
      }

      return res.json({
        requiresOtp: true,
        email: user.email,
        message: isEmailConfigured()
          ? 'Codigo de verificacion enviado a tu email'
          : 'Codigo generado (SMTP no configurado)',
        ...(process.env.NODE_ENV !== 'production' && { code: otpCode }),
      });
    }

    // === Login normal (sin 2FA) ===
    const { roles, permissions } = await getUserPermissions(user.id);
    const token = generateToken(user, roles, permissions);
    const refreshToken = generateRefreshToken(user);

    res.json({
      message: 'Inicio de sesion exitoso',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        twoFactorEnabled: user.twoFactorEnabled || false,
        roles,
        permissions,
      },
      token,
      refreshToken,
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/login-verify - Verificar OTP y completar login
router.post('/login-verify', async (req, res, next) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({
        error: 'Email y codigo son requeridos',
      });
    }

    const sanitizedEmail = sanitize(email)?.toLowerCase();

    // Buscar OTP valido
    const otp = await prisma.otpVerification.findFirst({
      where: {
        email: sanitizedEmail,
        code,
        type: 'login',
        verified: false,
        expiresAt: { gt: new Date() },
      },
    });

    if (!otp) {
      return res.status(400).json({
        error: 'Codigo invalido, expirado o ya verificado',
        code: 'INVALID_OTP',
      });
    }

    // Marcar OTP como verificado
    await prisma.otpVerification.update({
      where: { id: otp.id },
      data: { verified: true },
    });

    // Buscar usuario
    const user = await prisma.user.findUnique({
      where: { email: sanitizedEmail },
    });

    if (!user || !user.active) {
      return res.status(401).json({
        error: 'Usuario no encontrado o inactivo',
      });
    }

    // Obtener roles y permisos
    const { roles, permissions } = await getUserPermissions(user.id);

    const token = generateToken(user, roles, permissions);
    const refreshToken = generateRefreshToken(user);

    res.json({
      message: 'Inicio de sesión exitoso',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        roles,
        permissions,
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

    const { verifyToken } = await import('../services/auth.js');
    const decoded = verifyToken(token);
    if (!decoded || decoded.valid === false || decoded.type !== 'refresh') {
      return res.status(401).json({
        error: 'Refresh token inválido o expirado',
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, active: true },
    });

    if (!user || !user.active) {
      return res.status(401).json({
        error: 'Usuario no encontrado o inactivo',
      });
    }

    // Obtener permisos actualizados
    const { roles, permissions } = await getUserPermissions(user.id);

    const newToken = generateToken(user, roles, permissions);
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

// GET /auth/me - Perfil del usuario autenticado (con roles y permisos)
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
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const userResponse = await formatUserResponse(user);

    // Agregar conteo de pedidos
    const orderCount = await prisma.order.count({
      where: { userId: user.id },
    });

    res.json({
      ...userResponse,
      _count: { orders: orderCount },
    });
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

    const { name, phone, birthdate, currentPassword, newPassword } = req.body;

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

    if (birthdate !== undefined) {
      updateData.birthdate = sanitize(birthdate) || null;
    }

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

    await prisma.user.update({
      where: { id: decoded.id },
      data: updateData,
    });

    const updatedUser = await prisma.user.findUnique({ where: { id: decoded.id } });
    const userResponse = await formatUserResponse(updatedUser);

    res.json({
      message: 'Perfil actualizado',
      user: userResponse,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /auth/two-factor - Activar/desactivar autenticacion en 2 pasos
router.put('/two-factor', async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token requerido' });
    }

    const { verifyToken } = await import('../services/auth.js');
    const decoded = verifyToken(authHeader.split(' ')[1]);
    if (!decoded || decoded.valid === false) {
      return res.status(401).json({ error: 'Token invalido' });
    }

    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        error: 'El campo "enabled" es requerido (true/false)',
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, twoFactorEnabled: true },
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Si esta activando 2FA y SMTP no esta configurado, avisar
    if (enabled && !isEmailConfigured()) {
      return res.status(400).json({
        error: 'No se puede activar la autenticacion en 2 pasos. El servidor de correos no esta configurado. Contacta al administrador.',
        code: 'SMTP_NOT_CONFIGURED',
      });
    }

    await prisma.user.update({
      where: { id: decoded.id },
      data: { twoFactorEnabled: enabled },
    });

    res.json({
      message: enabled
        ? 'Autenticacion en 2 pasos activada'
        : 'Autenticacion en 2 pasos desactivada',
      twoFactorEnabled: enabled,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 2FA ENDPOINTS - Autenticacion en dos pasos con verificacion por email
// ═══════════════════════════════════════════════════════════════════════

// Helper: Extraer usuario del token JWT (reutilizable)
const getAuthenticatedUser = async (authHeader) => {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const { verifyToken } = await import('../services/auth.js');
  const decoded = verifyToken(authHeader.split(' ')[1]);
  if (!decoded || decoded.valid === false) return null;
  return decoded;
};

// POST /auth/2fa/send-code - Enviar codigo para activar/desactivar 2FA
router.post('/2fa/send-code', async (req, res, next) => {
  try {
    const decoded = await getAuthenticatedUser(req.headers.authorization);
    if (!decoded) {
      return res.status(401).json({ error: 'Token requerido', code: 'AUTH_REQUIRED' });
    }

    const { action } = req.body;
    if (action !== 'enable' && action !== 'disable') {
      return res.status(400).json({
        error: 'Accion invalida. Usa "enable" o "disable"',
        code: 'INVALID_ACTION',
      });
    }

    // Verificar email configurado
    if (!isEmailConfigured()) {
      return res.status(400).json({
        error: 'No se puede configurar 2FA. El servidor de correos no esta configurado.',
        code: 'EMAIL_NOT_CONFIGURED',
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, twoFactorEnabled: true, active: true },
    });

    if (!user || !user.active) {
      return res.status(404).json({ error: 'Usuario no encontrado o inactivo' });
    }

    // Validar accion vs estado actual
    if (action === 'enable' && user.twoFactorEnabled) {
      return res.status(400).json({
        error: 'La autenticacion en dos pasos ya esta activada',
        code: 'ALREADY_ENABLED',
      });
    }
    if (action === 'disable' && !user.twoFactorEnabled) {
      return res.status(400).json({
        error: 'La autenticacion en dos pasos ya esta desactivada',
        code: 'ALREADY_DISABLED',
      });
    }

    // Generar OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const otpType = `2fa-${action}`;

    // Eliminar OTPs anteriores para este tipo
    await prisma.otpVerification.deleteMany({
      where: { userId: user.id, type: otpType },
    });

    // Crear nuevo OTP
    await prisma.otpVerification.create({
      data: {
        userId: user.id,
        email: user.email,
        code: otpCode,
        type: otpType,
        expiresAt,
      },
    });

    // Enviar OTP por email
    await sendOtpEmail({ to: user.email, code: otpCode, type: otpType });

    res.json({
      message: action === 'enable'
        ? 'Codigo de verificacion enviado para activar 2FA'
        : 'Codigo de verificacion enviado para desactivar 2FA',
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/2fa/verify-setup - Verificar codigo y activar/desactivar 2FA
router.post('/2fa/verify-setup', async (req, res, next) => {
  try {
    const decoded = await getAuthenticatedUser(req.headers.authorization);
    if (!decoded) {
      return res.status(401).json({ error: 'Token requerido', code: 'AUTH_REQUIRED' });
    }

    const { code, action } = req.body;

    if (!code || code.length !== 6) {
      return res.status(400).json({
        error: 'Codigo de 6 digitos requerido',
        code: 'INVALID_CODE',
      });
    }

    if (action !== 'enable' && action !== 'disable') {
      return res.status(400).json({
        error: 'Accion invalida. Usa "enable" o "disable"',
        code: 'INVALID_ACTION',
      });
    }

    const otpType = `2fa-${action}`;

    // Buscar OTP valido
    const otp = await prisma.otpVerification.findFirst({
      where: {
        userId: decoded.id,
        code,
        type: otpType,
        verified: false,
        expiresAt: { gt: new Date() },
      },
    });

    if (!otp) {
      return res.status(400).json({
        error: 'Codigo invalido, expirado o ya verificado',
        code: 'INVALID_OTP',
      });
    }

    // Marcar OTP como verificado
    await prisma.otpVerification.update({
      where: { id: otp.id },
      data: { verified: true },
    });

    // Actualizar estado 2FA del usuario
    const new2FAState = action === 'enable';
    await prisma.user.update({
      where: { id: decoded.id },
      data: { twoFactorEnabled: new2FAState },
    });

    // Obtener usuario actualizado con roles y permisos
    const updatedUser = await prisma.user.findUnique({ where: { id: decoded.id } });
    const userResponse = await formatUserResponse(updatedUser);

    res.json({
      message: new2FAState
        ? 'Autenticacion en dos pasos activada exitosamente'
        : 'Autenticacion en dos pasos desactivada exitosamente',
      twoFactorEnabled: new2FAState,
      user: userResponse,
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/2fa/resend-code - Reenviar codigo OTP durante login 2FA
router.post('/2fa/resend-code', async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        error: 'Email valido es requerido',
        code: 'INVALID_EMAIL',
      });
    }

    const sanitizedEmail = sanitize(email)?.toLowerCase();

    // Buscar usuario con 2FA activado
    const user = await prisma.user.findUnique({
      where: { email: sanitizedEmail },
      select: { id: true, email: true, twoFactorEnabled: true, active: true },
    });

    if (!user || !user.active) {
      // No revelar si el usuario existe por seguridad
      return res.json({ message: 'Si el email esta registrado, se enviara un nuevo codigo' });
    }

    if (!user.twoFactorEnabled) {
      return res.json({ message: 'Si el email esta registrado, se enviara un nuevo codigo' });
    }

    // Verificar email configurado
    if (!isEmailConfigured()) {
      console.log(`[2FA-Resend] Email no configurado. Codigo para ${sanitizedEmail} no enviado.`);
      return res.json({ message: 'Si el email esta registrado, se enviara un nuevo codigo' });
    }

    // Generar nuevo OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    // Eliminar OTPs anteriores para login
    await prisma.otpVerification.deleteMany({
      where: { email: sanitizedEmail, type: 'login' },
    });

    // Crear nuevo OTP
    await prisma.otpVerification.create({
      data: {
        userId: user.id,
        email: user.email,
        code: otpCode,
        type: 'login',
        expiresAt,
      },
    });

    // Enviar OTP por email
    await sendOtpEmail({ to: user.email, code: otpCode, type: 'login-2fa' });

    res.json({
      message: 'Codigo de verificacion reenviado a tu correo',
    });
  } catch (err) {
    next(err);
  }
});

export default router;

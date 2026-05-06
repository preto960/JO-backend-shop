import express from 'express';
import prisma, { ensureColumns } from '../lib/prisma.js';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import crypto from 'crypto';
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

// ─── Auto-migration: asegurar columnas 2FA existan en la DB ──────────────
ensureColumns().catch(() => {});

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
    isOnline: user.isOnline || false,
    twoFactorEnabled: user.twoFactorEnabled || false,
    twoFactorType: user.twoFactorType || null,
    hasBackupCodes: !!(user.twoFactorBackupCodes && JSON.parse(user.twoFactorBackupCodes).length > 0),
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

    // Asignar rol: delivery o customer (por defecto)
    const allowedRoles = ['customer', 'delivery'];
    const targetRole = allowedRoles.includes(sanitizedRole) ? sanitizedRole : 'customer';

    if (existingUser) {
      // ── Email ya registrado: agregar el nuevo rol al usuario existente ──
      const assignedRole = await prisma.role.findUnique({ where: { name: targetRole } });
      if (!assignedRole) {
        return res.status(400).json({
          error: 'Rol no valido',
          field: 'role',
        });
      }

      // Verificar si ya tiene este rol asignado
      const existingRole = await prisma.userRole.findFirst({
        where: { userId: existingUser.id, roleId: assignedRole.id },
      });

      if (existingRole) {
        // Ya tiene el rol: verificar contraseña para hacer login automático
        const isMatch = await comparePassword(password, existingUser.password);
        if (!isMatch) {
          return res.status(401).json({
            error: 'Contraseña incorrecta',
            code: 'WRONG_PASSWORD',
          });
        }
      } else {
        // No tiene el rol: verificar contraseña antes de agregarlo
        const isMatch = await comparePassword(password, existingUser.password);
        if (!isMatch) {
          return res.status(401).json({
            error: 'Contraseña incorrecta',
            code: 'WRONG_PASSWORD',
          });
        }

        // Agregar el nuevo rol
        await prisma.userRole.create({
          data: { userId: existingUser.id, roleId: assignedRole.id },
        });
      }

      // Obtener permisos actualizados (con el nuevo rol)
      const { roles, permissions } = await getUserPermissions(existingUser.id);
      const token = generateToken(existingUser, roles, permissions);
      const refreshToken = generateRefreshToken(existingUser);

      return res.status(200).json({
        message: `Rol '${targetRole}' asignado a tu cuenta existente`,
        user: {
          id: existingUser.id,
          name: existingUser.name,
          email: existingUser.email,
          phone: existingUser.phone,
          roles,
          permissions,
        },
        token,
        refreshToken,
      });
    }

    // ── Nuevo usuario: crear cuenta con el rol indicado ──
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
    const { email, password, role } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Email y contraseña son requeridos',
        field: !email ? 'email' : 'password',
      });
    }

    const sanitizedEmail = sanitize(email)?.toLowerCase();
    // role puede ser string o array de strings
    let sanitizedRoles = null;
    if (role) {
      sanitizedRoles = Array.isArray(role)
        ? role.map(r => sanitize(r)?.toLowerCase()).filter(Boolean)
        : [sanitize(role)?.toLowerCase()].filter(Boolean);
    }

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

    // === Validar rol si la app lo requiere (admin tiene acceso total) ===
    if (sanitizedRoles && sanitizedRoles.length > 0) {
      const { roles } = await getUserPermissions(user.id);
      const userRoleNames = roles.map(r => (typeof r === 'string' ? r : r.name));
      // Admin tiene acceso a cualquier app sin restricción
      const isAdmin = userRoleNames.includes('admin');
      if (!isAdmin) {
        const hasRequiredRole = sanitizedRoles.some(r => userRoleNames.includes(r));
        if (!hasRequiredRole) {
          const roleLabels = { customer: 'cliente', delivery: 'repartidor', admin: 'admin', editor: 'editor' };
          if (sanitizedRoles.length === 1) {
            const label = roleLabels[sanitizedRoles[0]] || sanitizedRoles[0];
            return res.status(403).json({
              error: `No tienes acceso como ${label}. Debes registrarte.`,
              code: 'ROLE_NOT_FOUND',
            });
          }
          return res.status(403).json({
            error: 'No tienes acceso a esta aplicación.',
            code: 'ROLE_NOT_FOUND',
          });
        }
      }
    }

    // === 2FA: Solo si el usuario lo tiene activado ===
    if (user.twoFactorEnabled) {
      const twoFactorType = user.twoFactorType || 'email';

      if (twoFactorType === 'totp') {
        // TOTP: el usuario debe ingresar el código de su app authenticator
        return res.json({
          requiresOtp: true,
          email: user.email,
          twoFactorType: 'totp',
          message: 'Ingresa el codigo de tu aplicacion authenticator',
        });
      }

      // Email: enviar código OTP por correo (flujo existente)
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
        twoFactorType: 'email',
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

// POST /auth/login-verify - Verificar OTP y completar login (email o TOTP o backup code)
router.post('/login-verify', async (req, res, next) => {
  try {
    const { email, code, type, role } = req.body;

    if (!email || !code) {
      return res.status(400).json({
        error: 'Email y codigo son requeridos',
      });
    }

    const sanitizedEmail = sanitize(email)?.toLowerCase();
    const verifyType = type || 'email'; // 'email' | 'totp' | 'backup'

    // Buscar usuario
    const user = await prisma.user.findUnique({
      where: { email: sanitizedEmail },
    });

    if (!user || !user.active) {
      return res.status(401).json({
        error: 'Usuario no encontrado o inactivo',
      });
    }

    if (verifyType === 'totp') {
      // Verificar código TOTP de la app authenticator
      if (!user.twoFactorSecret) {
        return res.status(400).json({
          error: 'TOTP no configurado para este usuario',
          code: 'TOTP_NOT_CONFIGURED',
        });
      }

      const verified = speakeasy.totp.verify({
        secret: user.twoFactorSecret,
        encoding: 'base32',
        token: code,
        window: 1, // Permite 1 periodo antes/después
      });

      if (!verified) {
        return res.status(400).json({
          error: 'Codigo TOTP invalido',
          code: 'INVALID_TOTP',
        });
      }
    } else if (verifyType === 'backup') {
      // Verificar código de recuperación (backup code)
      if (!user.twoFactorBackupCodes) {
        return res.status(400).json({
          error: 'No hay codigos de recuperacion configurados',
          code: 'NO_BACKUP_CODES',
        });
      }

      const backupCodes = JSON.parse(user.twoFactorBackupCodes);
      const codeIndex = backupCodes.indexOf(code);

      if (codeIndex === -1) {
        return res.status(400).json({
          error: 'Codigo de recuperacion invalido',
          code: 'INVALID_BACKUP_CODE',
        });
      }

      // Remover el código usado (cada código es de un solo uso)
      backupCodes.splice(codeIndex, 1);
      await prisma.user.update({
        where: { id: user.id },
        data: { twoFactorBackupCodes: JSON.stringify(backupCodes) },
      });
    } else {
      // Email OTP (flujo existente)
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
    }

    // Obtener roles y permisos
    const { roles, permissions } = await getUserPermissions(user.id);

    // === Validar rol si la app lo requiere (admin tiene acceso total) ===
    let sanitizedRoles = null;
    if (role) {
      sanitizedRoles = Array.isArray(role)
        ? role.map(r => sanitize(r)?.toLowerCase()).filter(Boolean)
        : [sanitize(role)?.toLowerCase()].filter(Boolean);
    }
    if (sanitizedRoles && sanitizedRoles.length > 0) {
      const userRoleNames = roles.map(r => (typeof r === 'string' ? r : r.name));
      // Admin tiene acceso a cualquier app sin restricción
      const isAdmin = userRoleNames.includes('admin');
      if (!isAdmin) {
        const hasRequiredRole = sanitizedRoles.some(r => userRoleNames.includes(r));
        if (!hasRequiredRole) {
          const roleLabels = { customer: 'cliente', delivery: 'repartidor', admin: 'admin', editor: 'editor' };
          if (sanitizedRoles.length === 1) {
            const label = roleLabels[sanitizedRoles[0]] || sanitizedRoles[0];
            return res.status(403).json({
              error: `No tienes acceso como ${label}. Debes registrarte.`,
              code: 'ROLE_NOT_FOUND',
            });
          }
          return res.status(403).json({
            error: 'No tienes acceso a esta aplicación.',
            code: 'ROLE_NOT_FOUND',
            });
        }
      }
    }

    const token = generateToken(user, roles, permissions);
    const refreshToken = generateRefreshToken(user);

    res.json({
      message: 'Inicio de sesión exitoso',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        twoFactorEnabled: user.twoFactorEnabled || false,
        twoFactorType: user.twoFactorType || null,
        hasBackupCodes: !!(user.twoFactorBackupCodes && JSON.parse(user.twoFactorBackupCodes).length > 0),
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

// PATCH /auth/profile/status - Cambiar estado conectado/desconectado (delivery)
router.patch('/profile/status', async (req, res, next) => {
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

    const { isOnline } = req.body;

    if (typeof isOnline !== 'boolean') {
      return res.status(400).json({
        error: 'El campo "isOnline" es requerido (true/false)',
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, active: true, roles: { select: { roleId: true, role: { select: { name: true } } } } },
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const roleNames = user.roles.map(r => r.role.name);

    // Solo deliverys pueden cambiar su estado online
    if (!roleNames.includes('delivery') && !roleNames.includes('admin')) {
      return res.status(403).json({
        error: 'Solo los repartidores pueden cambiar su estado de conexion',
      });
    }

    await prisma.user.update({
      where: { id: decoded.id },
      data: { isOnline },
    });

    res.json({
      message: isOnline ? 'Ahora estas conectado' : 'Ahora estas desconectado',
      isOnline,
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
      data: {
        twoFactorEnabled: enabled,
        // Al desactivar, limpiar tipo, secret y backup codes
        ...(!enabled && {
          twoFactorType: null,
          twoFactorSecret: null,
          twoFactorBackupCodes: null,
        }),
      },
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

// ═══════════════════════════════════════════════════════════════════════
// 2FA TOTP ENDPOINTS - Authenticator App (Google Auth / Authy)
// ═══════════════════════════════════════════════════════════════════════

// Helper: Generar códigos de recuperación
const generateBackupCodes = (count = 10) => {
  const codes = [];
  for (let i = 0; i < count; i++) {
    codes.push(
      crypto.randomBytes(4).toString('hex').toUpperCase().match(/.{1,4}/g).join('-')
    );
  }
  return codes;
};

// GET /auth/2fa/totp/setup - Genera secret TOTP + QR code
router.get('/2fa/totp/setup', async (req, res, next) => {
  try {
    const decoded = await getAuthenticatedUser(req.headers.authorization);
    if (!decoded) {
      return res.status(401).json({ error: 'Token requerido', code: 'AUTH_REQUIRED' });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, twoFactorEnabled: true, twoFactorType: true, active: true },
    });

    if (!user || !user.active) {
      return res.status(404).json({ error: 'Usuario no encontrado o inactivo' });
    }

    // Si ya tiene TOTP activo, no permitir regenerar sin desactivar primero
    if (user.twoFactorEnabled && user.twoFactorType === 'totp') {
      return res.status(400).json({
        error: 'TOTP ya esta activado. Desactiva primero para configurar uno nuevo.',
        code: 'TOTP_ALREADY_ENABLED',
      });
    }

    // Generar secret TOTP
    const secret = speakeasy.generateSecret({
      name: `JO-Shop (${user.email})`,
      issuer: 'JO-Shop',
    });

    // Generar QR code como data URI
    const qrDataUri = await QRCode.toDataURL(secret.otpauth_url);

    // Guardar el secret temporalmente (sin activar 2FA aún)
    await prisma.user.update({
      where: { id: user.id },
      data: { twoFactorSecret: secret.base32 },
    });

    res.json({
      message: 'Escanea este codigo QR con tu app authenticator',
      secret: secret.base32,
      qrCode: qrDataUri,
      otpauthUrl: secret.otpauth_url,
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/2fa/totp/enable - Verifica que el usuario escaneó el QR correctamente
router.post('/2fa/totp/enable', async (req, res, next) => {
  try {
    const decoded = await getAuthenticatedUser(req.headers.authorization);
    if (!decoded) {
      return res.status(401).json({ error: 'Token requerido', code: 'AUTH_REQUIRED' });
    }

    const { code } = req.body;

    if (!code || code.length !== 6) {
      return res.status(400).json({
        error: 'Codigo de 6 digitos requerido',
        code: 'INVALID_CODE',
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, twoFactorSecret: true, twoFactorEnabled: true },
    });

    if (!user || !user.twoFactorSecret) {
      return res.status(400).json({
        error: 'Primero debes generar el secret TOTP (GET /auth/2fa/totp/setup)',
        code: 'TOTP_NOT_SETUP',
      });
    }

    // Verificar el código TOTP
    const verified = speakeasy.totp.verify({
      secret: user.twoFactorSecret,
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (!verified) {
      return res.status(400).json({
        error: 'Codigo invalido. Verifica que tu app authenticator este configurada correctamente.',
        code: 'INVALID_TOTP',
      });
    }

    // Generar códigos de recuperación
    const backupCodes = generateBackupCodes(10);

    // Activar 2FA con TOTP
    await prisma.user.update({
      where: { id: decoded.id },
      data: {
        twoFactorEnabled: true,
        twoFactorType: 'totp',
        twoFactorBackupCodes: JSON.stringify(backupCodes),
      },
    });

    // Obtener usuario actualizado
    const updatedUser = await prisma.user.findUnique({ where: { id: decoded.id } });
    const userResponse = await formatUserResponse(updatedUser);

    res.json({
      message: 'Autenticacion con app authenticator activada exitosamente',
      twoFactorEnabled: true,
      twoFactorType: 'totp',
      backupCodes, // Solo se muestran UNA VEZ
      user: userResponse,
    });
  } catch (err) {
    next(err);
  }
});

// GET /auth/2fa/backup-codes - Generar nuevos códigos de recuperación
router.get('/2fa/backup-codes', async (req, res, next) => {
  try {
    const decoded = await getAuthenticatedUser(req.headers.authorization);
    if (!decoded) {
      return res.status(401).json({ error: 'Token requerido', code: 'AUTH_REQUIRED' });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, twoFactorEnabled: true, twoFactorType: true, active: true },
    });

    if (!user || !user.active) {
      return res.status(404).json({ error: 'Usuario no encontrado o inactivo' });
    }

    if (!user.twoFactorEnabled) {
      return res.status(400).json({
        error: 'Debes tener 2FA activado para generar codigos de recuperacion',
        code: '2FA_NOT_ENABLED',
      });
    }

    // Generar nuevos códigos de recuperación
    const backupCodes = generateBackupCodes(10);

    // Guardar en la BD (reemplaza los anteriores)
    await prisma.user.update({
      where: { id: decoded.id },
      data: { twoFactorBackupCodes: JSON.stringify(backupCodes) },
    });

    res.json({
      message: 'Nuevos codigos de recuperacion generados. Guardalos en un lugar seguro.',
      backupCodes,
    });
  } catch (err) {
    next(err);
  }
});

export default router;

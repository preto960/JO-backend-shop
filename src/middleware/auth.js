import { verifyToken } from '../services/auth.js';
import prisma from '../lib/prisma.js';

const SERVICE_PASSWORD = process.env.BACKEND_SERVICE_PASSWORD || 'Joshop2024!BridgeSec#Xk9';

// Middleware de autenticación - Extrae user con roles y permisos
// Soporta: (1) JWT Bearer token, (2) X-Service-Password para server-to-server (ej. landingpage bridge)
export const authenticate = async (req, res, next) => {
  try {
    // Service-to-service auth: X-Service-Password header
    const servicePassword = req.headers['x-service-password'];
    if (servicePassword && servicePassword === SERVICE_PASSWORD) {
      const userEmail = req.headers['x-service-user-email'];
      let serviceUser;

      if (userEmail) {
        // Look up real user by email
        serviceUser = await prisma.user.findUnique({
          where: { email: userEmail },
          include: {
            roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
            permissions: { include: { permission: true } },
          },
        });
      }

      if (serviceUser) {
        const roleNames = serviceUser.roles.map(ur => ur.role.name);
        const allPerms = [];
        for (const ur of serviceUser.roles) {
          for (const rp of ur.role.permissions) allPerms.push(rp.permission.code);
        }
        for (const up of serviceUser.permissions) allPerms.push(up.permission.code);

        req.user = {
          id: serviceUser.id,
          email: serviceUser.email,
          roles: roleNames,
          permissions: [...new Set(allPerms)],
        };
      } else {
        // Email not found in backend — look up first admin user as fallback
        const adminUser = await prisma.user.findFirst({
          where: { roles: { some: { role: { name: 'admin' } } } },
          include: {
            roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
            permissions: { include: { permission: true } },
          },
        });

        if (adminUser) {
          const roleNames = adminUser.roles.map(ur => ur.role.name);
          const allPerms = [];
          for (const ur of adminUser.roles) {
            for (const rp of ur.role.permissions) allPerms.push(rp.permission.code);
          }
          for (const up of adminUser.permissions) allPerms.push(up.permission.code);

          req.user = {
            id: adminUser.id,
            email: adminUser.email,
            name: adminUser.name,
            roles: roleNames,
            permissions: [...new Set(allPerms)],
          };
        } else {
          return res.status(401).json({ error: 'No admin user found for service bridge' });
        }
      }
      return next();
    }

    // Standard JWT auth
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Token de autenticación requerido',
        code: 'AUTH_REQUIRED',
      });
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyToken(token);

    if (!decoded || decoded.valid === false) {
      return res.status(401).json({
        error: decoded?.error || 'Token inválido',
        code: decoded?.expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
      });
    }

    req.user = {
      id: decoded.id,
      email: decoded.email,
      roles: decoded.roles || [],
      permissions: decoded.permissions || [],
    };

    next();
  } catch (error) {
    return res.status(401).json({
      error: 'Error de autenticación',
      code: 'AUTH_ERROR',
    });
  }
};

// Middleware de autorización por rol (compatibilidad)
export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Autenticación requerida',
        code: 'AUTH_REQUIRED',
      });
    }

    if (!req.user.roles.some(r => roles.includes(r))) {
      return res.status(403).json({
        error: 'No tienes permisos para realizar esta acción',
        code: 'FORBIDDEN',
        requiredRoles: roles.join(' o '),
        userRoles: req.user.roles,
      });
    }

    next();
  };
};

// Middleware de verificación de permiso específico
export const requirePermission = (...permissionCodes) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Autenticación requerida',
        code: 'AUTH_REQUIRED',
      });
    }

    const hasPermission = permissionCodes.some(code =>
      req.user.permissions.includes(code)
    );

    if (!hasPermission) {
      return res.status(403).json({
        error: 'No tienes el permiso necesario para realizar esta acción',
        code: 'PERMISSION_DENIED',
        requiredPermissions: permissionCodes,
      });
    }

    next();
  };
};

// Middleware opcional: si hay token lo procesa, si no continúa como anónimo
export const optionalAuth = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const decoded = verifyToken(token);

      if (decoded && decoded.valid !== false) {
        req.user = {
          id: decoded.id,
          email: decoded.email,
          roles: decoded.roles || [],
          permissions: decoded.permissions || [],
        };
      }
    }

    next();
  } catch {
    next();
  }
};

// Helper: Obtener todos los permisos de un usuario (roles + directos)
export const getUserPermissions = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: {
        include: {
          role: {
            include: {
              permissions: {
                include: {
                  permission: true,
                },
              },
            },
          },
        },
      },
      permissions: {
        include: {
          permission: true,
        },
      },
    },
  });

  if (!user) return { roles: [], permissions: [] };

  // Permisos via roles
  const roleNames = user.roles.map(ur => ur.role.name);
  const rolePermissions = [];
  for (const ur of user.roles) {
    for (const rp of ur.role.permissions) {
      rolePermissions.push(rp.permission);
    }
  }

  // Permisos directos (no duplicar)
  const directPermissions = user.permissions.map(up => up.permission);
  const allPermissionCodes = [...new Set([
    ...rolePermissions.map(p => p.code),
    ...directPermissions.map(p => p.code),
  ])];

  const allPermissions = [
    ...rolePermissions,
    ...directPermissions.filter(dp => !rolePermissions.some(rp => rp.code === dp.code)),
  ];

  return {
    roles: user.roles.map(ur => ({ id: ur.role.id, name: ur.role.name, description: ur.role.description })),
    permissions: allPermissions.map(p => ({
      id: p.id,
      code: p.code,
      name: p.name,
      module: p.module,
      description: p.description,
    })),
    permissionCodes: allPermissionCodes,
  };
};

// Helper: Verificar si usuario tiene permiso específico (para uso en controladores)
export const hasPermission = (user, code) => {
  if (!user) return false;
  return user.permissions.includes(code);
};

// Helper: Verificar si usuario tiene rol específico
export const hasRole = (user, roleName) => {
  if (!user) return false;
  return user.roles.includes(roleName);
};

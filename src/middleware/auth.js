import { verifyToken } from '../services/auth.js';

// Middleware de autenticación
export const authenticate = (req, res, next) => {
  try {
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
      role: decoded.role,
    };

    next();
  } catch (error) {
    return res.status(401).json({
      error: 'Error de autenticación',
      code: 'AUTH_ERROR',
    });
  }
};

// Middleware de autorización por rol
export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Autenticación requerida',
        code: 'AUTH_REQUIRED',
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'No tienes permisos para realizar esta acción',
        code: 'FORBIDDEN',
        requiredRole: roles.join(' o '),
        userRole: req.user.role,
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
          role: decoded.role,
        };
      }
    }

    next();
  } catch {
    next();
  }
};

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'jo-shop-secret-key-2024';
const JWT_EXPIRES = '24h';
const JWT_REFRESH_EXPIRES = '7d';

// Hash contraseña
export const hashPassword = async (password) => {
  return await bcrypt.hash(password, 12);
};

// Comparar contraseña
export const comparePassword = async (password, hash) => {
  return await bcrypt.compare(password, hash);
};

// Generar token de acceso con roles y permisos
export const generateToken = (user, roles = [], permissions = []) => {
  const payload = {
    id: user.id,
    email: user.email,
    roles: roles.map(r => r.name),
    permissions: permissions.map(p => p.code),
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
};

// Generar refresh token
export const generateRefreshToken = (user) => {
  const payload = {
    id: user.id,
    type: 'refresh',
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_REFRESH_EXPIRES });
};

// Verificar token
export const verifyToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return { valid: false, expired: true, error: 'Token expirado' };
    }
    return { valid: false, expired: false, error: 'Token inválido' };
  }
};

// Validar formato de email
export const isValidEmail = (email) => {
  const pattern = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return pattern.test(email);
};

// Validar fortaleza de contraseña
export const validatePassword = (password) => {
  if (!password || password.length < 6) {
    return { valid: false, message: 'La contraseña debe tener al menos 6 caracteres' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, message: 'La contraseña debe tener al menos una mayúscula' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, message: 'La contraseña debe tener al menos un número' };
  }
  return { valid: true, message: '' };
};

// Sanitizar string
export const sanitize = (str) => {
  if (typeof str !== 'string') return '';
  return str.trim().replace(/[<>]/g, '');
};

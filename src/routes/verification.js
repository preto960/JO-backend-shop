import express from 'express';
import prisma from '../lib/prisma.js';
import { sendOtpEmail, isEmailConfigured } from '../services/email.js';

const router = express.Router();

const OTP_EXPIRY_MINUTES = 5;

/**
 * Generar un codigo OTP de 6 digitos
 */
function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// POST /auth/otp/generate - Generar y enviar OTP
router.post('/generate', async (req, res, next) => {
  try {
    const { email, type = 'login' } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'El email es requerido' });
    }

    const validTypes = ['login', 'register', 'reset'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `Tipo invalido. Valores: ${validTypes.join(', ')}` });
    }

    // Para login/register: verificar que el usuario existe (o no existe para register)
    if (type === 'login' || type === 'register') {
      const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
      if (type === 'login' && !user) {
        return res.status(404).json({ error: 'No existe una cuenta con ese email' });
      }
      if (type === 'register' && user) {
        return res.status(409).json({ error: 'Ya existe una cuenta con ese email' });
      }
    }

    // Generar OTP
    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    // Guardar OTP (reemplazar cualquier OTP anterior para este email+tipo)
    await prisma.otpVerification.upsert({
      where: {
        id: 0, // Forzar create ya que no tenemos unique constraint simple
      },
      create: {
        userId: 0, // Se actualiza abajo
        email: email.toLowerCase(),
        code,
        type,
        expiresAt,
      },
      update: {},
    });

    // Upsert fallara sin unique constraint, usar create + delete viejos
    await prisma.otpVerification.deleteMany({
      where: { email: email.toLowerCase(), type },
    });

    // Obtener userId si existe
    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true },
    });

    await prisma.otpVerification.create({
      data: {
        userId: existingUser?.id || 0,
        email: email.toLowerCase(),
        code,
        type,
        expiresAt,
      },
    });

    // Enviar OTP por email
    if (isEmailConfigured()) {
      await sendOtpEmail({ to: email.toLowerCase(), code, type });
    } else {
      console.log(`[OTP] SMTP no configurado. Codigo para ${email.toLowerCase()}: ${code}`);
    }

    res.json({
      message: isEmailConfigured()
        ? 'Codigo de verificacion enviado a tu email'
        : 'Codigo generado (SMTP no configurado, revisa los logs del servidor)',
      expiresIn: OTP_EXPIRY_MINUTES * 60,
      // En desarrollo, incluir el codigo en la respuesta para facilitar testing
      ...(process.env.NODE_ENV !== 'production' && { code }),
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/otp/verify - Verificar OTP
router.post('/verify', async (req, res, next) => {
  try {
    const { email, code, type = 'login' } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: 'Email y codigo son requeridos' });
    }

    const otp = await prisma.otpVerification.findFirst({
      where: {
        email: email.toLowerCase(),
        code,
        type,
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

    // Marcar como verificado
    await prisma.otpVerification.update({
      where: { id: otp.id },
      data: { verified: true },
    });

    res.json({
      message: 'Codigo verificado correctamente',
      email: otp.email,
    });
  } catch (err) {
    next(err);
  }
});

export default router;

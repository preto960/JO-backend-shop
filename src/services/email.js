import nodemailer from 'nodemailer';
import { Resend } from 'resend';

// ─── Transporter Nodemailer (SMTP - fallback) ───────────────────────────
let transporter = null;

function getSmtpTransporter() {
  if (transporter) return transporter;

  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT || 587;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpHost || !smtpUser || !smtpPass) {
    return null;
  }

  transporter = nodemailer.createTransport({
    host: smtpHost,
    port: parseInt(smtpPort),
    secure: parseInt(smtpPort) === 465,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });

  return transporter;
}

// ─── Resend Client ──────────────────────────────────────────────────────
let resendClient = null;

function getResendClient() {
  if (resendClient) return resendClient;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;

  resendClient = new Resend(apiKey);
  return resendClient;
}

// ─── Config Check ───────────────────────────────────────────────────────

/**
 * Retorna el proveedor activo: 'resend', 'smtp', o null
 */
export function getEmailProvider() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) return 'smtp';
  return null;
}

/**
 * Indica si hay algún proveedor de email configurado
 */
export function isEmailConfigured() {
  return getEmailProvider() !== null;
}

// ─── Send Email (dispatch al proveedor activo) ──────────────────────────

export async function sendEmail({ to, subject, html, text }) {
  const provider = getEmailProvider();

  if (provider === 'resend') {
    return sendViaResend({ to, subject, html, text });
  }

  if (provider === 'smtp') {
    return sendViaSmtp({ to, subject, html, text });
  }

  // Ninguno configurado
  console.log(`[Email] No hay proveedor configurado. Correo NO enviado: "${subject}" -> ${to}`);
  console.log('[Email] Configura RESEND_API_KEY o SMTP_HOST/SMTP_USER/SMTP_PASS en .env');
  return { success: false, reason: 'no_provider_configured' };
}

// ─── Resend Provider ────────────────────────────────────────────────────

async function sendViaResend({ to, subject, html, text }) {
  const client = getResendClient();
  if (!client) {
    console.log(`[Email-Resend] API Key no configurada. Correo NO enviado: "${subject}" -> ${to}`);
    return { success: false, reason: 'resend_not_configured' };
  }

  try {
    const fromAddress = process.env.RESEND_FROM || process.env.SMTP_FROM || 'onboarding@resend.dev';
    const fromName = process.env.SMTP_FROM_NAME || 'JO-Shop';

    const { data, error } = await client.emails.send({
      from: `${fromName} <${fromAddress}>`,
      to: [to],
      subject,
      html,
      text: text || html?.replace(/<[^>]*>/g, ''),
    });

    if (error) {
      console.error(`[Email-Resend] Error:`, error.message);
      return { success: false, error: error.message };
    }

    console.log(`[Email-Resend] Correo enviado: "${subject}" -> ${to} (ID: ${data?.id})`);
    return { success: true, messageId: data?.id };
  } catch (err) {
    console.error(`[Email-Resend] Error enviando correo:`, err.message);
    return { success: false, error: err.message };
  }
}

// ─── SMTP Provider (nodemailer) ────────────────────────────────────────

async function sendViaSmtp({ to, subject, html, text }) {
  const transport = getSmtpTransporter();
  if (!transport) {
    console.log(`[Email-SMTP] SMTP no configurado. Correo NO enviado: "${subject}" -> ${to}`);
    return { success: false, reason: 'smtp_not_configured' };
  }

  try {
    const fromAddress = process.env.SMTP_FROM || process.env.SMTP_USER;
    const fromName = process.env.SMTP_FROM_NAME || 'JO-Shop';

    const info = await transport.sendMail({
      from: `"${fromName}" <${fromAddress}>`,
      to,
      subject,
      html,
      text: text || html?.replace(/<[^>]*>/g, ''),
    });

    console.log(`[Email-SMTP] Correo enviado: "${subject}" -> ${to} (ID: ${info.messageId})`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[Email-SMTP] Error enviando correo:`, err.message);
    return { success: false, error: err.message };
  }
}

// ─── Email Templates ────────────────────────────────────────────────────

/**
 * Enviar correo de bienvenida al registrarse
 */
export async function sendWelcomeEmail({ name, email }) {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #E94560, #0F3460); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 28px;">JO-Shop</h1>
        <p style="color: rgba(255,255,255,0.9); margin: 8px 0 0; font-size: 16px;">Tu tienda de confianza</p>
      </div>
      <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 12px 12px;">
        <h2 style="color: #333; margin-top: 0;">Bienvenido/a, ${name}!</h2>
        <p style="color: #555; font-size: 16px; line-height: 1.6;">
          Tu cuenta ha sido creada exitosamente en <strong>JO-Shop</strong>.
          Ya puedes explorar nuestra tienda, hacer pedidos y mucho mas.
        </p>
        <div style="background: #f8f9fa; padding: 16px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #E94560;">
          <p style="margin: 0; color: #555; font-size: 14px;">
            <strong>Tu correo registrado:</strong> ${email}
          </p>
        </div>
        <p style="color: #555; font-size: 16px; line-height: 1.6;">
          Si no creaste esta cuenta, puedes ignorar este correo.
        </p>
        <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
          <p style="color: #999; font-size: 13px; margin: 0;">
            JO-Shop &copy; ${new Date().getFullYear()} - Todos los derechos reservados
          </p>
        </div>
      </div>
    </div>
  `;

  return sendEmail({
    to: email,
    subject: 'Bienvenido/a a JO-Shop',
    html,
  });
}

/**
 * Enviar codigo OTP por email
 */
export async function sendOtpEmail({ to, code, type = 'login' }) {
  const typeLabels = {
    login: 'Inicio de sesion',
    'login-2fa': 'Verificacion de inicio de sesion',
    register: 'Verificacion de registro',
    reset: 'Restablecimiento de contrasena',
    '2fa-setup': 'Configuracion de autenticacion en dos pasos',
    '2fa-enable': 'Activacion de autenticacion en dos pasos',
    '2fa-disable': 'Desactivacion de autenticacion en dos pasos',
  };

  const typeLabel = typeLabels[type] || 'Verificacion';
  const expiresIn = '5 minutos';

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #E94560, #0F3460); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 28px;">JO-Shop</h1>
      </div>
      <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 12px 12px;">
        <h2 style="color: #333; margin-top: 0;">${typeLabel}</h2>
        <p style="color: #555; font-size: 16px; line-height: 1.6;">
          Tu codigo de verificacion es:
        </p>
        <div style="text-align: center; margin: 25px 0;">
          <div style="display: inline-block; background: #f0f0f0; padding: 16px 32px; border-radius: 12px; letter-spacing: 8px; font-size: 36px; font-weight: bold; color: #0F3460; border: 2px dashed #E94560;">
            ${code}
          </div>
        </div>
        <p style="color: #555; font-size: 14px; line-height: 1.6; text-align: center;">
          Este codigo expira en <strong>${expiresIn}</strong>. No lo compartas con nadie.
        </p>
        <div style="background: #fff3cd; padding: 12px 16px; border-radius: 8px; margin-top: 20px;">
          <p style="margin: 0; color: #856404; font-size: 13px;">
            Si no solicitaste este codigo, puedes ignorar este correo. Alguien quizas intento acceder a tu cuenta.
          </p>
        </div>
        <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
          <p style="color: #999; font-size: 13px; margin: 0;">
            JO-Shop &copy; ${new Date().getFullYear()} - Todos los derechos reservados
          </p>
        </div>
      </div>
    </div>
  `;

  return sendEmail({
    to,
    subject: `JO-Shop - Codigo de verificacion: ${code}`,
    html,
  });
}

export default {
  sendEmail,
  sendWelcomeEmail,
  sendOtpEmail,
  isEmailConfigured,
  getEmailProvider,
};

import nodemailer from 'nodemailer';

// Crear transporter reutilizable
let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT || 587;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpHost || !smtpUser || !smtpPass) {
    console.warn('[Email] SMTP no configurado. Los correos no se enviaran.');
    console.warn('[Email] Configura SMTP_HOST, SMTP_USER, SMTP_PASS en .env');
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

export function isEmailConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

/**
 * Enviar correo electronico
 */
export async function sendEmail({ to, subject, html, text }) {
  const transport = getTransporter();
  if (!transport) {
    console.log(`[Email] Correo NO enviado (SMTP no configurado): "${subject}" → ${to}`);
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

    console.log(`[Email] Correo enviado: "${subject}" → ${to} (ID: ${info.messageId})`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[Email] Error enviando correo:`, err.message);
    return { success: false, error: err.message };
  }
}

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
    register: 'Verificacion de registro',
    reset: 'Restablecimiento de contraseña',
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
            Si no solicitaste este codigo, puedes ignorar este correo. Alguien quizo iniciar sesion con tu correo.
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
};

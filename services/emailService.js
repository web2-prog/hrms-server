import nodemailer from 'nodemailer';

/**
 * SMTP mail service for salary slip delivery.
 * Default: Gmail (smtp.gmail.com) with a Google App Password.
 */
function smtpConfig() {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT) || 465;
  const secure =
    process.env.SMTP_SECURE === 'true' || (process.env.SMTP_SECURE !== 'false' && port === 465);
  const user = String(process.env.SMTP_USER || '').trim();
  // App/mailbox passwords sometimes get pasted with spaces
  const pass = String(process.env.SMTP_PASS || '').replace(/\s+/g, '');
  return { host, port, secure, user, pass };
}

function mailFrom() {
  const { user } = smtpConfig();
  const from = String(process.env.MAIL_FROM || user || '').trim();
  const name = String(process.env.MAIL_FROM_NAME || 'KriraAI HR').trim();
  return { from, name };
}

let transporter;
let transporterKey = '';

function getTransporter() {
  const cfg = smtpConfig();
  const key = `${cfg.host}|${cfg.port}|${cfg.secure}|${cfg.user}|${cfg.pass}`;
  if (!transporter || key !== transporterKey) {
    transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: {
        user: cfg.user,
        pass: cfg.pass,
      },
      tls: {
        minVersion: 'TLSv1.2',
      },
    });
    transporterKey = key;
  }
  return transporter;
}

export function isEmailConfigured() {
  const { user, pass } = smtpConfig();
  return Boolean(
    user &&
      pass &&
      pass !== 'your-mailbox-password' &&
      pass !== 'your-gmail-app-password'
  );
}

function friendlySmtpError(err) {
  const raw = String(err?.response || err?.message || err || '');
  if (/535|BadCredentials|Username and Password not accepted/i.test(raw)) {
    const { host, user } = smtpConfig();
    return (
      `Email login failed for ${user || '(no SMTP_USER)'} via ${host}. ` +
      `Check SMTP_USER / SMTP_PASS in backend .env. ` +
      `For Gmail use smtp.gmail.com and a Google App Password (2FA required).`
    );
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(raw)) {
    return `Cannot reach mail server (${smtpConfig().host}). Check SMTP_HOST / SMTP_PORT / network.`;
  }
  return raw || 'Failed to send email';
}

/**
 * Send salary slip email with the same PDF used for View / Download PDF.
 */
export async function sendSalarySlipEmail({
  to,
  employeeName,
  monthLabel,
  year,
  companyName,
  netPay,
  pdfBuffer,
  filename,
}) {
  if (!isEmailConfigured()) {
    throw new Error(
      'Email is not configured. Set SMTP_USER and SMTP_PASS in backend .env (Gmail App Password).'
    );
  }

  const formattedNet = Number(netPay || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const { from, name } = mailFrom();

  try {
    const info = await getTransporter().sendMail({
      from: `"${name}" <${from}>`,
      to,
      subject: `Salary Slip — ${monthLabel} ${year} | ${companyName || 'KriraAI'}`,
      text: `Dear ${employeeName || 'Team Member'},

Please find attached your salary slip for ${monthLabel} ${year}.
Net pay: ₹${formattedNet}

If you have any questions, please contact HR.

Regards,
${name}
${companyName || 'KriraAI Pvt. Ltd.'}`,
      html: `
      <p>Dear ${employeeName || 'Team Member'},</p>
      <p>Please find attached your salary slip for <strong>${monthLabel} ${year}</strong>.</p>
      <p>Net pay: <strong>₹${formattedNet}</strong></p>
      <p>If you have any questions, please contact HR.</p>
      <p>Regards,<br/>${name}<br/>${companyName || 'KriraAI Pvt. Ltd.'}</p>
    `,
      attachments: [
        {
          filename,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    return { messageId: info.messageId, to };
  } catch (err) {
    const error = new Error(friendlySmtpError(err));
    error.cause = err;
    throw error;
  }
}

/** Optional startup / health check — does not send mail. */
export async function verifySmtpConnection() {
  if (!isEmailConfigured()) {
    return { ok: false, message: 'SMTP not configured' };
  }
  try {
    await getTransporter().verify();
    return { ok: true, message: `SMTP OK (${smtpConfig().host})` };
  } catch (err) {
    return { ok: false, message: friendlySmtpError(err) };
  }
}

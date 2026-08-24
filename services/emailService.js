import nodemailer from 'nodemailer';

/**
 * SMTP mail service for salary slip delivery.
 * Defaults use Chandrika Dholakiya's KriraAI email — replace env vars for production.
 */
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = process.env.SMTP_USER || 'chandrika.dholakiya@krira.ai';
const SMTP_PASS = process.env.SMTP_PASS || 'your-gmail-app-password';
const MAIL_FROM = process.env.MAIL_FROM || 'chandrika.dholakiya@krira.ai';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'Chandrika Dholakiya - KriraAI HR';

let transporter;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    });
  }
  return transporter;
}

/**
 * Send salary slip email with PDF attachment.
 */
export async function sendSalarySlipEmail({ to, employeeName, monthLabel, year, companyName, netPay, pdfBuffer, filename }) {
  const formattedNet = Number(netPay || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const info = await getTransporter().sendMail({
    from: `"${MAIL_FROM_NAME}" <${MAIL_FROM}>`,
    to,
    subject: `Salary Slip — ${monthLabel} ${year} | ${companyName || 'KriraAI'}`,
    html: `
      <p>Dear ${employeeName || 'Team Member'},</p>
      <p>Please find attached your salary slip for <strong>${monthLabel} ${year}</strong>.</p>
      <p>Net pay: <strong>₹${formattedNet}</strong></p>
      <p>If you have any questions, please contact HR.</p>
      <p>Regards,<br/>${MAIL_FROM_NAME}<br/>${companyName || 'KriraAI Pvt. Ltd.'}</p>
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
}

export function isEmailConfigured() {
  return Boolean(SMTP_USER && SMTP_PASS && SMTP_PASS !== 'your-gmail-app-password');
}

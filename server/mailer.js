import nodemailer from 'nodemailer';

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env;
const transport = SMTP_HOST
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT) || 465,
      secure: Number(SMTP_PORT || 465) === 465,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    })
  : null;

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export async function sendPasswordReset(user, link) {
  if (!transport) {
    // No email configured (local development): print the link so it can still be used
    console.log(`\n[password reset] No SMTP configured. Reset link for ${user.email}:\n${link}\n`);
    return;
  }
  await transport.sendMail({
    from: MAIL_FROM || SMTP_USER,
    to: user.email,
    subject: 'Reset your Jarvis password',
    text: `Hi ${user.name},\n\nUse this link to set a new password (valid for 1 hour):\n${link}\n\nIf you didn't ask for this, you can ignore this email.`,
    html: `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:auto;padding:24px;color:#1d1b2e">
      <h2 style="font-weight:500">Reset your password</h2>
      <p>Hi ${escape(user.name)}, tap the button to set a new password. The link is valid for 1 hour.</p>
      <p style="margin:28px 0"><a href="${escape(link)}" style="background:linear-gradient(135deg,#a78bfa,#f472b6);color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none">Set a new password</a></p>
      <p style="color:#777;font-size:13px">If you didn't ask for this, you can ignore this email.</p></div>`,
  });
}

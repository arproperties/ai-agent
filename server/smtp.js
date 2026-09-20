import nodemailer from 'nodemailer';

// Sending, for a mailbox that is already connected over IMAP. The address and the
// password are the ones already stored — connecting a mailbox never asks twice.

// Nearly every provider mirrors imap.X with smtp.X on 465. These are the ones that do not.
const OVERRIDES = [
  [/^outlook\.office365\.com$/, 'smtp.office365.com', 587],
  [/^imap\.mail\.me\.com$/, 'smtp.mail.me.com', 587],
  [/^imap\.secureserver\.net$/, 'smtpout.secureserver.net', 465],
];

/**
 * The SMTP server for a mailbox, derived from the IMAP host the connector already found.
 * That host came from a real MX lookup, so it knows the provider behind a custom domain —
 * a Titan mailbox on acme.ae is imap.titan.email, and so smtp.titan.email.
 * port 465 = TLS from the first byte; 587 = STARTTLS.
 */
export function smtpDefaults(imapHost) {
  const host = String(imapHost || '').trim().toLowerCase();
  const hit = OVERRIDES.find(([re]) => re.test(host));
  if (hit) return { host: hit[1], port: hit[2], secure: hit[2] === 465 };
  if (host.startsWith('imap.')) return { host: `smtp.${host.slice(5)}`, port: 465, secure: true };
  return { host, port: 465, secure: true };
}

export function transportFor(acc, password) {
  return nodemailer.createTransport({
    host: acc.smtp_host,
    port: acc.smtp_port,
    secure: !!acc.smtp_secure,   // 465: encrypted from the first byte
    requireTLS: !acc.smtp_secure, // 587: refuse to carry on if the server will not upgrade
    auth: { user: acc.username, pass: password },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  });
}

// Building the MIME once, here, and then sending those exact bytes means the copy filed in
// Sent is byte-identical to what the recipient got — same Message-ID — so their reply
// threads against it. A second compile would generate a second Message-ID and break that.
const composer = nodemailer.createTransport({ streamTransport: true, buffer: true });

export async function compose({ from, to, cc = [], subject = '', text = '', inReplyTo, references }) {
  const info = await composer.sendMail({
    from, to, subject, text,
    ...(cc.length ? { cc } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references ? { references } : {}),
  });
  return { raw: info.message, messageId: info.messageId, envelope: info.envelope };
}

export async function sendRaw(acc, password, { raw, envelope }) {
  const t = transportFor(acc, password);
  try {
    await t.sendMail({ envelope, raw });
  } finally {
    t.close();
  }
}

export function friendlySmtp(e, host) {
  const code = e.responseCode || e.code || '';
  if (code === 'EAUTH' || code === 535) return 'The mail server rejected the email password. Check it under Email, and that SMTP is allowed for this mailbox.';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return `Couldn't find the sending server ${host}. Check the SMTP server under Advanced.`;
  if (/ETIMEDOUT|ECONNREFUSED|ESOCKET|timeout/i.test(code)) return `Couldn't reach ${host}. Check the SMTP server and port under Advanced.`;
  if (code === 550 || code === 553) return `The mail server refused the message: ${e.response || e.message}`;
  if (code === 421 || code === 450 || code === 452) return `The mail server is throttling this mailbox: ${e.response || e.message}`;
  return e.response || e.message;
}

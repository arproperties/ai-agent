// AOL Connector — a small remote MCP server.
// Lets Claude list, search, read and send AOL Mail through IMAP/SMTP using an
// AOL app password. Transport: Streamable HTTP (stateless). Listens on
// 127.0.0.1 only; nginx proxies https://<site>/aol-mcp/<token> to /mcp/<token>
// here and provides TLS.
//
// The login is set by the master in Reem (Settings → Apps), not here: for each
// call this asks Reem, over the machine's own loopback, which mailbox the token
// opens. A wrong or replaced token gets a 404, like any unknown page.

import express from "express";
import { z } from "zod";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const REEM_URL = process.env.REEM_URL || "http://127.0.0.1:3001";
const PORT = Number(process.env.PORT || 3002);
const MAX_BODY_CHARS = 20000; // long newsletters would otherwise flood the chat
const MAX_ATTACHMENT_CHARS = 60000; // text pulled out of a PDF/Word/Excel file
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // larger pictures are too big to hand to Claude
const MAX_SCAN_PAGES = 5; // scanned PDFs are sent as page pictures; cap how many
const MAX_SEND_BYTES = 20 * 1024 * 1024; // AOL refuses emails much bigger than ~25 MB

// ── mail helpers ─────────────────────────────────────────────
// The login behind a link, from Reem; null when the link is wrong or old. Kept for a
// minute so one chat's burst of tool calls asks Reem once, while "New link" or a
// changed password in Reem still takes effect within the minute.
const logins = new Map(); // token → { login, until }
async function loginFor(token) {
  const hit = logins.get(token);
  if (hit && hit.until > Date.now()) return hit.login;
  const r = await fetch(`${REEM_URL}/api/connector/aol/${encodeURIComponent(token)}`);
  if (r.status !== 200 && r.status !== 404) throw new Error(`Reem answered ${r.status}`);
  const login = r.status === 200 ? await r.json() : null;
  logins.set(token, { login, until: Date.now() + 60_000 });
  return login;
}

// One short IMAP session per tool call: AOL drops idle connections anyway,
// and calls are rare enough that reconnecting costs nothing noticeable.
async function withImap(login, fn) {
  const client = new ImapFlow({
    host: "imap.aol.com",
    port: 993,
    secure: true,
    auth: { user: login.email, pass: login.password },
    logger: false,
  });
  try {
    await client.connect();
  } catch (e) {
    if (e?.authenticationFailed) throw new Error("AOL turned down the login. Set the email and app password again in Reem → Settings → Apps.");
    throw e;
  }
  try { return await fn(client); } finally { await client.logout().catch(() => {}); }
}

async function inFolder(client, folder, fn) {
  const lock = await client.getMailboxLock(folder || "INBOX");
  try { return await fn(); } finally { lock.release(); }
}

function addr(list) {
  return (list || []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");
}

function summary(msg) {
  const env = msg.envelope || {};
  return {
    uid: msg.uid,
    date: env.date ? new Date(env.date).toISOString() : null,
    from: addr(env.from),
    to: addr(env.to),
    subject: env.subject || "(no subject)",
    unread: !msg.flags?.has("\\Seen"),
  };
}

// Download and parse one whole email. fetchOne reads with BODY.PEEK, so the
// email stays unread in AOL.
async function loadMail(client, uid, folder) {
  return inFolder(client, folder, async () => {
    const msg = await client.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
    if (!msg) throw new Error(`No email with uid ${uid} in ${folder || "INBOX"}.`);
    return { msg, mail: await simpleParser(msg.source) };
  });
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n\n[…cut at ${max} characters]` : text;
}

// Turn an attachment into something Claude can read: pictures go back as
// images it can look at, documents as their text.
async function attachmentContent(a) {
  const name = (a.filename || "").toLowerCase();
  const type = (a.contentType || "").toLowerCase();
  const head = `Attachment: ${a.filename || "(unnamed)"} (${type || "unknown type"}, ${a.size} bytes)`;

  if (type.startsWith("image/") && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(type)) {
    if (a.content.length > MAX_IMAGE_BYTES) return [{ type: "text", text: `${head}\nThis picture is too big to show (over 5 MB).` }];
    return [{ type: "text", text: head }, { type: "image", data: a.content.toString("base64"), mimeType: type }];
  }

  let text = null;
  if (type === "application/pdf" || name.endsWith(".pdf")) {
    const parser = new PDFParse({ data: a.content });
    try {
      text = (await parser.getText()).text;
      // Scanned PDFs have no text layer (only "-- 1 of 1 --" page markers), so
      // show Claude the first pages as pictures it can read instead.
      if (!text.replace(/--\s*\d+\s+of\s+\d+\s*--/g, "").trim()) {
        const shots = await parser.getScreenshot({ scale: 1.5, first: MAX_SCAN_PAGES });
        const pages = shots.pages.map((p) => ({ type: "image", data: Buffer.from(p.data).toString("base64"), mimeType: "image/png" }));
        const more = shots.total > pages.length ? ` Showing the first ${pages.length} of ${shots.total} pages.` : "";
        return [{ type: "text", text: `${head}\nThis PDF is a scan, so here are its pages as pictures.${more}` }, ...pages];
      }
    } finally { await parser.destroy().catch(() => {}); }
  } else if (name.endsWith(".docx") || type.includes("wordprocessingml")) {
    text = (await mammoth.extractRawText({ buffer: a.content })).value;
  } else if (name.endsWith(".xlsx") || type.includes("spreadsheetml")) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(a.content);
    const parts = [];
    wb.eachSheet((ws) => {
      const rows = [];
      ws.eachRow((row) => rows.push(row.values.slice(1).map((v) => (v && typeof v === "object" ? v.text ?? v.result ?? JSON.stringify(v) : v ?? "")).join("\t")));
      parts.push(`## Sheet: ${ws.name}\n${rows.join("\n")}`);
    });
    text = parts.join("\n\n");
  } else if (type.startsWith("text/") || /\.(txt|csv|tsv|md|json|xml|html?|ics|log)$/.test(name)) {
    text = a.content.toString("utf8");
  }

  if (text === null) return [{ type: "text", text: `${head}\nThis file type can't be opened here (only PDF, Word .docx, Excel .xlsx, text/CSV and pictures).` }];
  return [{ type: "text", text: `${head}\n\n${clip(text, MAX_ATTACHMENT_CHARS)}` }];
}

function asText(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function asError(e) {
  return { isError: true, content: [{ type: "text", text: String(e?.message || e) }] };
}

// Wrap a tool so mail errors come back to Claude as a readable message
// instead of a broken call.
const safe = (fn) => async (args) => { try { return await fn(args); } catch (e) { return asError(e); } };

// ── MCP server definition ────────────────────────────────────
function buildServer(login) {
  const server = new McpServer({ name: "aol-mail", version: "1.0.0" });
  const imap = (fn) => withImap(login, fn);

  server.registerTool(
    "list_folders",
    {
      title: "List mail folders",
      description: "All folders in the AOL mailbox (Inbox, Sent, Spam, custom folders) with total and unread counts.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () => imap(async (client) => {
      const folders = await client.list({ statusQuery: { messages: true, unseen: true } });
      return asText(folders.map((f) => ({
        path: f.path,
        special: f.specialUse || null,
        total: f.status?.messages ?? null,
        unread: f.status?.unseen ?? null,
      })));
    }))
  );

  server.registerTool(
    "search_emails",
    {
      title: "Search emails",
      description: "Find emails in one folder, newest first. With no filters it returns the latest emails. Returns uid, date, from, to, subject and unread; use read_email with the uid to get the body.",
      inputSchema: {
        folder: z.string().optional().describe("Folder path from list_folders (default INBOX)."),
        query: z.string().optional().describe("Words to look for in the subject, sender or body."),
        from: z.string().optional().describe("Only emails from this address or name."),
        subject: z.string().optional().describe("Only emails whose subject contains this."),
        since: z.string().optional().describe("Only emails on or after this date, YYYY-MM-DD."),
        before: z.string().optional().describe("Only emails before this date, YYYY-MM-DD."),
        unread_only: z.boolean().optional().describe("Only unread emails."),
        limit: z.number().int().min(1).max(100).optional().describe("How many to return (default 20)."),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ folder, query, from, subject, since, before, unread_only, limit }) => imap((client) => inFolder(client, folder, async () => {
      const criteria = {};
      if (query) criteria.or = [{ subject: query }, { from: query }, { body: query }];
      if (from) criteria.from = from;
      if (subject) criteria.subject = subject;
      if (since) criteria.since = new Date(since);
      if (before) criteria.before = new Date(before);
      if (unread_only) criteria.seen = false;
      if (!Object.keys(criteria).length) criteria.all = true;

      const uids = (await client.search(criteria, { uid: true })) || [];
      const pick = uids.sort((a, b) => b - a).slice(0, limit || 20);
      const out = [];
      if (pick.length) {
        for await (const msg of client.fetch(pick, { envelope: true, flags: true }, { uid: true })) out.push(summary(msg));
      }
      out.sort((a, b) => b.uid - a.uid);
      return asText({ folder: folder || "INBOX", matched: uids.length, returned: out.length, emails: out });
    })))
  );

  server.registerTool(
    "read_email",
    {
      title: "Read an email",
      description: "The full email for a uid from search_emails: sender, recipients, date, subject, plain-text body and its attachments (numbered by index). Use read_attachment to open one. Reading does not mark it as read.",
      inputSchema: {
        uid: z.number().int().describe("The email's uid from search_emails."),
        folder: z.string().optional().describe("Folder the email is in (default INBOX)."),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ uid, folder }) => imap(async (client) => {
      const { msg, mail } = await loadMail(client, uid, folder);
      const body = mail.text || (mail.html ? mail.html.replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, " ").replace(/\s+/g, " ") : "");
      return asText({
        uid,
        folder: folder || "INBOX",
        date: mail.date ? mail.date.toISOString() : null,
        from: mail.from?.text || "",
        to: mail.to?.text || "",
        cc: mail.cc?.text || "",
        subject: mail.subject || "(no subject)",
        unread: !msg.flags?.has("\\Seen"),
        body: clip(body, MAX_BODY_CHARS),
        attachments: (mail.attachments || []).map((a, index) => ({ index, name: a.filename || "(unnamed)", type: a.contentType, size: a.size })),
      });
    }))
  );

  server.registerTool(
    "read_attachment",
    {
      title: "Open an attachment",
      description: "Open one attachment of an email (index from read_email). Pictures come back as images; PDF, Word (.docx), Excel (.xlsx), CSV and text files come back as their text.",
      inputSchema: {
        uid: z.number().int().describe("The email's uid."),
        index: z.number().int().min(0).describe("The attachment's index from read_email."),
        folder: z.string().optional().describe("Folder the email is in (default INBOX)."),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ uid, index, folder }) => imap(async (client) => {
      const { mail } = await loadMail(client, uid, folder);
      const a = (mail.attachments || [])[index];
      if (!a) throw new Error(`Email ${uid} has no attachment ${index} (it has ${(mail.attachments || []).length}).`);
      return { content: await attachmentContent(a) };
    }))
  );

  server.registerTool(
    "mark_email",
    {
      title: "Mark email read or unread",
      description: "Mark one email as read or unread.",
      inputSchema: {
        uid: z.number().int().describe("The email's uid."),
        folder: z.string().optional().describe("Folder the email is in (default INBOX)."),
        read: z.boolean().describe("true = mark read, false = mark unread."),
      },
      annotations: { idempotentHint: true },
    },
    safe(async ({ uid, folder, read }) => imap((client) => inFolder(client, folder, async () => {
      if (read) await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
      else await client.messageFlagsRemove(String(uid), ["\\Seen"], { uid: true });
      return asText({ ok: true, uid, read });
    })))
  );

  server.registerTool(
    "send_email",
    {
      title: "Send an email",
      description: "Send an email from the AOL account. To reply, pass reply_to_uid (and its folder) so it threads with the original. To forward files, pass forward_attachments_from_uid. Always show the user the draft and get their OK before calling this.",
      inputSchema: {
        to: z.string().describe("Recipient(s), comma separated."),
        subject: z.string().describe("Subject line."),
        body: z.string().describe("Plain-text body."),
        cc: z.string().optional().describe("Cc recipient(s), comma separated."),
        bcc: z.string().optional().describe("Bcc recipient(s), comma separated."),
        reply_to_uid: z.number().int().optional().describe("uid of the email being replied to."),
        reply_to_folder: z.string().optional().describe("Folder of the email being replied to (default INBOX)."),
        forward_attachments_from_uid: z.number().int().optional().describe("Attach files from this existing email (forwarding)."),
        forward_attachments_folder: z.string().optional().describe("Folder of that email (default INBOX)."),
        forward_attachment_indexes: z.array(z.number().int().min(0)).optional().describe("Which of its attachments to include (default all)."),
        attachments: z.array(z.object({
          filename: z.string().describe("File name, e.g. report.pdf."),
          content_base64: z.string().describe("The file's bytes, base64-encoded."),
          content_type: z.string().optional().describe("MIME type, e.g. application/pdf."),
        })).optional().describe("New files to attach."),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    safe(async ({ to, subject, body, cc, bcc, reply_to_uid, reply_to_folder, forward_attachments_from_uid, forward_attachments_folder, forward_attachment_indexes, attachments }) => {
      const from = login.email;
      const message = { from, to, cc, bcc, subject, text: body, attachments: [] };

      for (const f of attachments || []) {
        message.attachments.push({ filename: f.filename, content: Buffer.from(f.content_base64, "base64"), contentType: f.content_type });
      }
      if (forward_attachments_from_uid) {
        const { mail } = await imap((client) => loadMail(client, forward_attachments_from_uid, forward_attachments_folder));
        const all = mail.attachments || [];
        const picked = forward_attachment_indexes ? forward_attachment_indexes.map((i) => all[i]).filter(Boolean) : all;
        if (!picked.length) throw new Error(`Email ${forward_attachments_from_uid} has no matching attachments to forward.`);
        for (const a of picked) message.attachments.push({ filename: a.filename, content: a.content, contentType: a.contentType });
      }
      const totalBytes = message.attachments.reduce((n, a) => n + a.content.length, 0);
      if (totalBytes > MAX_SEND_BYTES) throw new Error(`Attachments total ${(totalBytes / 1048576).toFixed(1)} MB; AOL only takes about 20 MB per email.`);

      if (reply_to_uid) {
        const orig = await imap((client) => inFolder(client, reply_to_folder, () =>
          client.fetchOne(String(reply_to_uid), { envelope: true, headers: ["references"] }, { uid: true })));
        const msgId = orig?.envelope?.messageId;
        if (msgId) {
          const refs = orig.headers ? orig.headers.toString().replace(/^references:\s*/i, "").replace(/\s+/g, " ").trim() : "";
          message.inReplyTo = msgId;
          message.references = refs ? `${refs} ${msgId}` : msgId;
        }
      }

      const transport = nodemailer.createTransport({
        host: "smtp.aol.com",
        port: 465,
        secure: true,
        auth: { user: login.email, pass: login.password },
      });
      const info = await transport.sendMail(message);

      // AOL's SMTP doesn't file a copy in Sent, so add one ourselves so the
      // email shows up there like one sent from the AOL app. Best effort.
      let savedToSent = false;
      try {
        const raw = await new Promise((resolve, reject) => {
          nodemailer.createTransport({ streamTransport: true, buffer: true })
            .sendMail({ ...message, messageId: info.messageId }, (err, out) => (err ? reject(err) : resolve(out.message)));
        });
        await imap(async (client) => {
          const folders = await client.list();
          const sent = folders.find((f) => f.specialUse === "\\Sent")?.path || "Sent";
          await client.append(sent, raw, ["\\Seen"]);
        });
        savedToSent = true;
      } catch { /* the email still went out */ }

      return asText({ ok: true, message_id: info.messageId, accepted: info.accepted, rejected: info.rejected, attachments: message.attachments.map((a) => a.filename), saved_to_sent: savedToSent });
    })
  );

  return server;
}

// ── HTTP transport (stateless Streamable HTTP) ───────────────
const app = express();
app.use(express.json({ limit: "1mb" }));

const notFound = (res) => res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Not found." }, id: null });

app.post("/mcp/:token", async (req, res) => {
  try {
    const login = await loginFor(req.params.token);
    if (!login) return notFound(res);
    const server = buildServer(login);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { try { transport.close(); } catch {} try { server.close(); } catch {} });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(e) }, id: null });
    }
  }
});

// Stateless server: no SSE stream / session teardown needed.
app.get("/mcp/:token", (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
app.delete("/mcp/:token", (_req, res) => res.status(200).end());

// Plain health check, on this machine only (nginx sends only /mcp/<token> here).
app.get("/healthz", (_req, res) => res.json({ ok: true, reem: REEM_URL }));

app.listen(PORT, "127.0.0.1", () => console.log(`aol-connector MCP listening on 127.0.0.1:${PORT}`));

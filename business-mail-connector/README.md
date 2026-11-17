# Business Mail Connector — remote MCP server

A custom Claude connector for **each person's work mailbox** (Titan, ainalreempro.com):
read and search mail, open attachments, and send email (with attachments), over IMAP/SMTP.

Copied from `aol-connector/` and kept separate on purpose: own folder, own pm2 process,
own port. It only shares the server and domain.

## Connector link

Each person makes their own, in **Reem → Settings → Email in Claude.ai** (module
`claude_mail`, ticked per person by the master on their People profile). The mailbox is the
one they already connected under **Email** in Reem, so there is no password to type again.
They paste the link into Claude.ai → Settings → Connectors → Add custom connector:

```
https://ainalreemproaiagent.fun/mail-mcp/<token>
```

The token is the key: anyone with the link can read that mail. **New link** replaces it at
once. The master sees who has a link in **Settings → Apps** and can switch any of them off.
A link also stops working when the module is unticked, the person is switched off or made
external, or their mailbox under Email is disconnected.

The login lives in Reem's database (encrypted), not here; this server asks Reem for it per
token over loopback (`GET 127.0.0.1:3001/api/connector/business/<token>`, refused from
outside the machine), and keeps it for a minute.

## Tools

| Tool | What it does |
|------|--------------|
| `list_folders` | Folders with total/unread counts |
| `search_emails` | Newest first; filter by words, sender, subject, dates, unread |
| `read_email` | Full email + numbered attachment list (doesn't mark as read) |
| `read_attachment` | Opens one attachment: pictures as images; PDF (scans as page pictures, first 5), Word .docx, Excel .xlsx, CSV/text as text |
| `mark_email` | Mark read / unread — only with "Allow sending and actions" on under Email |
| `send_email` | Send, reply (threads), forward attachments, attach new files; copies to Sent — only with "Allow sending and actions" on |

## How it runs

- **Code:** `/var/www/business-mail-connector/` on the Reem EC2 (`ssh reem-live`).
- **Runtime:** Node + `@modelcontextprotocol/sdk` (Streamable HTTP, stateless) on
  `127.0.0.1:3003`, pm2 process `business-mail-connector`.
- **Edge:** a `location /mail-mcp/` block in Reem's nginx site (`/etc/nginx/sites-enabled/jarvis`)
  proxies `/mail-mcp/<token>` to `127.0.0.1:3003/mcp/<token>`.
- **Settings:** `/var/www/business-mail-connector/.env` holds only `REEM_URL` and `PORT`.

## First install on the server

```bash
ssh reem-live "mkdir -p /var/www/business-mail-connector"
scp server.js package.json package-lock.json .env.example reem-live:/var/www/business-mail-connector/
ssh reem-live "cd /var/www/business-mail-connector && cp .env.example .env && npm ci --omit=dev && pm2 start npm --name business-mail-connector -- start && pm2 save"
```

(`npm start` reads `.env`. Check `pm2 describe aol-connector` first and start it the same way.)

Then add to Reem's nginx site, next to the `/aol-mcp/` block (back the file up first), and
`sudo nginx -t && sudo systemctl reload nginx`:

```nginx
location /mail-mcp/ {
    proxy_pass http://127.0.0.1:3003/mcp/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 300s;
    client_max_body_size 30m;
}
```

Copy the AOL block's settings if they differ; the `/.well-known/oauth-` 404 block that
AOL needed already covers this one too.

## Redeploy after editing server.js

```bash
scp server.js package.json package-lock.json reem-live:/var/www/business-mail-connector/
ssh reem-live "cd /var/www/business-mail-connector && npm ci --omit=dev && pm2 restart business-mail-connector"
```

## Logs

```bash
ssh reem-live "pm2 logs business-mail-connector --lines 50"
```

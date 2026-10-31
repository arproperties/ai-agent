# AOL Connector — remote MCP server

A custom Claude connector for **AOL Mail**: read and search mail, open attachments,
and send email (with attachments), over IMAP/SMTP using an AOL **app password**.

Separate from Reem: own folder, own pm2 process, own port. It only shares the server
and domain.

## Connector link

Set in **Reem → Settings → Apps** (master only): type the AOL email and an AOL app
password; Reem checks the login and shows the link to paste into Claude.ai →
Settings → Connectors → Add custom connector. It looks like:

```
https://ainalreemproaiagent.fun/aol-mcp/<token>
```

The token is the key: anyone with the link can read and send that mail. **New link** in
Reem replaces it at once. The login lives in Reem's database (sealed), not here; this
server asks Reem for it per token over loopback (`GET 127.0.0.1:3001/api/connector/aol/<token>`,
refused from outside the machine), and keeps it for a minute.

## Tools

| Tool | What it does |
|------|--------------|
| `list_folders` | Folders with total/unread counts |
| `search_emails` | Newest first; filter by words, sender, subject, dates, unread |
| `read_email` | Full email + numbered attachment list (doesn't mark as read) |
| `read_attachment` | Opens one attachment: pictures as images; PDF (scans as page pictures, first 5), Word .docx, Excel .xlsx, CSV/text as text |
| `mark_email` | Mark read / unread |
| `send_email` | Send, reply (threads), forward attachments from an email, or attach new files; copies to Sent |

## How it runs

- **Code:** `/var/www/aol-connector/` on the Reem EC2 (`ssh reem-live`).
- **Runtime:** Node + `@modelcontextprotocol/sdk` (Streamable HTTP, stateless) on
  `127.0.0.1:3002`, pm2 process `aol-connector`.
- **Edge:** a `location /aol-mcp/` block in Reem's nginx site (`/etc/nginx/sites-enabled/jarvis`)
  proxies `/aol-mcp/<token>` to `127.0.0.1:3002/mcp/<token>`. Backup from before it was added:
  `~/jarvis-nginx.bak-before-aol`.
- **Settings:** `/var/www/aol-connector/.env` holds only `REEM_URL` and `PORT`.

## Redeploy after editing server.js

```bash
scp server.js package.json package-lock.json reem-live:/var/www/aol-connector/
ssh reem-live "cd /var/www/aol-connector && npm ci --omit=dev && pm2 restart aol-connector"
```

## Logs

```bash
ssh reem-live "pm2 logs aol-connector --lines 50"
```

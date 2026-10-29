# CLAUDE.md

Context for working in this folder. Francis prefers short, plain-step answers; detail only when asked.

**This folder lives inside the Reem repo** (`arproperties/ai-agent`, folder `aol-connector/`)
only for storage on GitHub. It is its own program with its own `package.json` and its own
deploy; Reem's build, tests and deploy never touch it, and its deploy never touches Reem.
Git works as in Reem: branch from `main`, PR to `main`, merge. Francis's personal GitHub
must not be used for it (an old copy at `francisgill1000/aol-connector` is to be deleted).

## What this is

A small **remote MCP server** that lets Claude.ai read and send **AOL Mail** as a custom
connector. One file: `server.js` (Node ESM, no build step). Built 2026-10-29; connected and
working in Claude.ai.

Tools: `list_folders`, `search_emails`, `read_email`, `read_attachment` (pictures as images;
PDF text, scanned PDFs as page pictures (first 5); Word .docx; Excel .xlsx; CSV/text),
`mark_email`, `send_email` (new, reply in thread, forward attachments, attach new files;
copies to Sent). It makes **no AI calls**: Claude.ai does the thinking on Francis's Claude
plan, so it never uses Reem's AI credit.

## Where it runs

- Same EC2 as Reem (ssh host `reem-live`, site https://ainalreemproaiagent.fun), but kept
  **separate from Reem's code** on purpose (Francis didn't want a new server/domain, and
  didn't want it mixed into Reem).
- Live folder `/var/www/aol-connector`, pm2 process `aol-connector`, `127.0.0.1:3002`.
- nginx (Reem's site file `/etc/nginx/sites-enabled/jarvis`):
  - `location /aol-mcp/` → `http://127.0.0.1:3002/mcp/` (so `/aol-mcp/<token>` → `/mcp/<token>`).
  - `location ^~ /.well-known/oauth-` → `return 404`. **Needed**: without it Reem's SPA
    answers those paths with HTML 200, Claude.ai thinks an OAuth sign-in is required,
    `/register` fails, and the connector shows "not connected".
  - Backups: `~/jarvis-nginx.bak-before-aol`, `~/jarvis-nginx.bak-before-aol-v2`,
    `~/jarvis-nginx.bak-before-wellknown`.
- `.env` here holds only `REEM_URL=http://127.0.0.1:3001` and `PORT=3002`.

## Where the AOL login lives (not in .env)

Francis explicitly **does not want the login in .env**. It is set in **Reem → Settings →
Tools → Apps** (master only), in the reem-app repo:
- `server/apps.js` (routes `/api/apps`, master only), table `app_connectors` in `server/db.js`
  (password sealed with `seal()` from `aiKeys.js`; `token` = end of the connector link),
  screen `client/src/components/Apps.jsx`, tests `tests/apps.test.js`. Shipped as PR #58.
- Reem checks the login against imap.aol.com before saving, then shows the link
  `https://ainalreemproaiagent.fun/aol-mcp/<token>`. **Change login** keeps the link;
  **New link** kills the old one at once; **Disconnect** removes it.
- This server asks Reem for the login per token: `GET 127.0.0.1:3001/api/connector/aol/<token>`.
  Reem answers only from loopback without `X-Forwarded-For` (i.e. not through nginx);
  anything else is 404. Answers are cached here for 60 s.
- AOL needs an **app password** (AOL → Account Security → Generate app password), not the
  normal password. IMAP `imap.aol.com:993`, SMTP `smtp.aol.com:465`.

## Deploy (no script; Francis has said merge + deploy finished work without asking)

From this folder (`reem-app/aol-connector`):
```bash
scp server.js package.json package-lock.json reem-live:/var/www/aol-connector/
ssh reem-live "cd /var/www/aol-connector && npm ci --omit=dev && pm2 restart aol-connector"
```
Changing the Reem side (`server/apps.js` etc., one folder up) is a normal Reem deploy
(`pg_dump` first; see `../CLAUDE.md`).

Logs: `ssh reem-live "pm2 logs aol-connector --lines 50"`. nginx access log shows Claude.ai
as `python-httpx` hitting `/aol-mcp/<token>`.

## Testing locally

No test suite. Run with a stand-in for Reem:
```bash
node -e "require('http').createServer((q,s)=>{if(q.url==='/api/connector/aol/good'){s.setHeader('content-type','application/json');s.end(JSON.stringify({email:'x@aol.com',password:'pw'}))}else{s.statusCode=404;s.end('{}')}}).listen(3097)" &
REEM_URL=http://127.0.0.1:3097 PORT=3096 node server.js
curl -s -H Content-Type:application/json -H "Accept: application/json, text/event-stream" -X POST localhost:3096/mcp/good -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
Don't call tools against Francis's real mailbox without asking.

## State / not done

- GitHub: inside `arproperties/ai-agent` (this folder). That repo is **public**, so never
  commit a password, token or connector link here.
- Only AOL is supported; `APPS` in Reem's `server/apps.js` is the place to add another
  mailbox type (it would also need its own connector path/server).
- Francis does not want Mailopoly suggested; use this connector instead.
- Server RAM is tight (~1.9 GB, Reem ~650 MB); this process is ~50–80 MB.

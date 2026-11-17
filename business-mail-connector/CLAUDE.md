# CLAUDE.md

Context for working in this folder. Francis prefers short, plain-step answers; detail only when asked.

**This folder lives inside the Reem repo** only for storage on GitHub. It is its own program
with its own `package.json` and its own deploy; Reem's build, tests and deploy never touch it,
and its deploy never touches Reem. Git works as in Reem: branch from `main`, PR to `main`.

## What this is

A small **remote MCP server** that lets **each person's** Claude.ai read and send their own
work mail (Titan, ainalreempro.com) as a custom connector. A copy of `../aol-connector/`
(built 2026-11-17), kept separate so a fault in one never stops the other. One file:
`server.js` (Node ESM, no build step). Makes **no AI calls**.

Differences from AOL:
- One link **per person**, not one master login. The mailbox is the one the person connected
  under Email in Reem (`imap_accounts`), so host/port/username/SMTP all come from Reem.
- `send_email` and `mark_email` are only offered when the person's "Allow sending and
  actions" switch under Email is on (Reem sends `smtp: null` otherwise).

## Reem's side (one folder up)

- `server/mailConnector.js`: table `mail_connectors` (user_id → token), module `claude_mail`
  (company, ticked per person), routes `/api/mail-connector` (the person's own screen),
  `/api/apps/mail-people` (master's list + switch off), and the loopback door
  `/api/connector/business/<token>` (404 from anywhere but this machine without nginx).
- Screens: `client/src/components/ClaudeMail.jsx` (Settings → Email in Claude.ai) and the
  "Email in Claude.ai" list at the bottom of `Apps.jsx` (master).
- Tests: `tests/mail-connector.test.js`.
- A link opens nothing once the module is unticked, the person is disabled or external, or
  their mailbox under Email is removed.

## Where it runs

Same EC2 as Reem (`reem-live`), `/var/www/business-mail-connector`, pm2
`business-mail-connector`, `127.0.0.1:3003`, nginx `location /mail-mcp/` →
`http://127.0.0.1:3003/mcp/`. `.env` holds only `REEM_URL` and `PORT`. See README for the
first install and redeploy. Deploy only when Francis says so.

## Testing locally

No test suite here. Run with a stand-in for Reem that answers
`/api/connector/business/<token>` with `{ email, password, imap: { host, port, username }, smtp: null | { host, port, secure } }`,
then POST `tools/list` to `/mcp/<token>` (see `../aol-connector/CLAUDE.md`). Don't call
tools against anyone's real mailbox without asking.

## Notes

- This repo is **public**: never commit a password, token or connector link.
- Each person needs their own Claude.ai account on a plan that allows custom connectors.
- Server RAM is tight (~1.9 GB); this process is ~50–80 MB.

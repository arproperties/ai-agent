# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Express 5 API (`server/`, plain ESM JavaScript, no build step) and a React 19 + Vite + Tailwind v4 PWA (`client/`). The app was renamed from Jarvis to **Reem**; the old name survives only in live identifiers that must not change without coordinated work: the deploy host `jarvis.eloquentservice.com`, `/var/www/jarvis` and the pm2 process `jarvis`, the session cookie `jarvis_sid`, the `jarvis:*` localStorage keys and `jarvis:signedout` event, and the saifsys door `api/jarvis/v1` with its `X-Jarvis-Key` / `X-Jarvis-Action-Key` headers. Use "Reem" for anything new. It is an AI assistant for a UAE property company (Saif Holding): chats with agents, a document Shelf with RAG, email, to-dos, lease renewals, legal cases, Document Renewals, case folders for external users, and live reads from the company system **saifsys**. README.md describes each feature and lists the `.env` keys.

## Commands

```bash
npm run setup          # first time: installs root and client deps
npm run dev            # API on :3001 (node --watch) + Vite on :5173 (proxies /api)
npm run build          # builds client/dist
npm start              # production: serves client/dist + API on :3001 (sets NODE_ENV inline, so run it from bash, not PowerShell)
./deploy.ps1           # build, tar, scp to the droplet, npm install, pm2 restart jarvis, then curls the site
```

There is no linter or type checker.

### Tests

`node:test` against a **real Postgres** database (with the `vector` extension). There are no mocks for SQL; the tests exist to check SQL scoping.

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/jarvis_test npm test          # all
TEST_DATABASE_URL=... npm test -- tests/case-folders.test.js                        # one file
TEST_DATABASE_URL=... npm test -- --test-name-pattern="shares by link" tests/case-share.test.js
```

PowerShell: `$env:TEST_DATABASE_URL='postgres://...'; npm test -- tests/todos.test.js`.

- Every test file must import `tests/helpers/db.js` **first**: it sets `DATABASE_URL` from `TEST_DATABASE_URL` before `server/db.js` loads (that module connects and runs its DDL at import time).
- `reset()` truncates every table, so the helper refuses any database whose name doesn't end in `_test`. Never point it at the live DB.
- **When you add a table, add it to `TABLES` in `tests/helpers/db.js`**, or rows leak between tests.
- Tests run serially (`--test-concurrency=1`). Factories (`makeUser`, `makeAgent`, `makeDoc`, …) live in `tests/helpers/db.js`; case-folder fixtures in `tests/helpers/cases.js`.

## Architecture

### Server boot and routing (`server/index.js`)
One file wires everything: public routes first (auth, error reports, saifsys's own inbound door `/api/from-saifsys/*` guarded by `fromSaifsys.js`, public case-share links), then `requireUser` → `externalFence` → `billingContext` for all of `/api`, then each feature router. `app.listen` starts the background timers (outbox, import queue, reminders, tenant care, lease renewals, legal cases, mail routing, case folders, buildings, recurring payments, saifsys doc sync, document alerts). Document alerts only run in production with `DOC_RENEWALS_SEND=on` (or `DOCUMENT_ALERTS=on`), because a local copy of the live DB holds real people's phones.

### Database (`server/db.js`)
- Postgres via `pg`, but queries are written with **SQLite-style `?` placeholders** through `db.prepare(sql).get/all/run(...params)` — compiled to `$1…`. `.run()` on `INSERT … RETURNING id` returns `{ changes, id }`. int8/numeric come back as JS numbers.
- `tx(fn)` uses AsyncLocalStorage so every `db` call inside the callback runs on the transaction's connection automatically.
- **No migration files.** The whole schema is idempotent DDL (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`) run at import time in `db.js`. Schema changes go there.
- Embeddings are 384-dim (`EMBED_DIMS`), from a local multilingual model (`EMBED_MODEL` in `config.js`); changing the model clears stored vectors at boot and `npm run backfill-embeddings` rebuilds them.

### Access control
- `server/access.js` holds every cross-user rule (master vs. normal vs. **external** users, agent assignments, `masterReach`). Each rule narrows, none widens; keep new boundaries there so they're testable without HTTP.
- Roles: the **master** owns agents and sees everything except external users' data; others reach agents through `agent_assignments`. External users (ticked External) get only their own things and private agents.
- `server/modules.js`: Reem's own feature modules (`shelf`, `legal`, `todos`, `renewals`, `document_renewals`, `email`, …), granted per person in `module_access`. Gate a screen's routes with `needsModule(key)`; `company: true` modules are never given to external users. What a chat needs of the same data stays open, so removing a module never breaks chats. Adding a module = an entry in `MODULES`, its routes behind `needsModule`, and a row in the client settings menu. These are distinct from saifsys modules (`server/saifsys/index.js`), which decide what agents may look up in saifsys.

### Chat pipeline (`server/chat.js`)
- `router.js` picks the agent per message with a fast model (or `@Name` forces one); follow-ups stay with the same agent.
- `chat()` builds the system prompt (persona, team, memories, recalled RAG chunks from `knowledge.js`, library catalog, mailbox, carried context from `chatRecap.js`), then runs a tool loop over **kits**.
- A **kit** is how a feature exposes tools to the model: `xxxKit(user, ctx)` returns `{ definitions, status, run(block) }` (see `todoKit` in `todos.js`, `caseKit`, `shelfKit`, `saifsysKit`, …). Kits that propose something for a person to confirm call `onCard(...)`, which streams a card to the client via `send('<cardType>', payload)`. Kits are included conditionally by role/modules (e.g. `caseKit` only for external users).
- Model choice lives in `config.js`: `auto` = Haiku 5.5 executor with Sonnet 5.5 as an advisor; the master's Auto uses `MASTER_MODEL`; work filed as fact uses `CAREFUL_MODEL`.

### AI calls and billing
All Claude calls go through the single client in `server/ai.js`; voice (OpenAI) and pictures go through helpers beside it. `billing.js` wraps them and records cost per person/job using AsyncLocalStorage — HTTP requests get context from `billingContext`, background timers from `billAs({ userId, job }, fn)`. New background jobs should be started under `billAs` so their cost is attributed.

### Feature modules
Each feature is usually one server file exporting `xxxRoutes` (an Express Router, handlers wrapped with a local `wrap()` for async errors), a `startXxx()` timer if it polls, and a `xxxKit` for chat. Larger features split across files, e.g. case folders: `caseFolders.js` (timer/intake), `caseMail.js`, `caseMatch.js`, `casePdf.js`, `caseShare.js`, `caseWatch.js`, `caseRoutes.js`, `caseKit.js`.

### saifsys integration
- Outbound: `server/saifsys/client.js` `askSaifsys(module, action, params)` calls the read-only `api/jarvis/v1` door on saifholdinggroup.com/sys with `SAIFSYS_API_KEY`. Each saifsys-side module file has a matching file here (`ars.js`, `booking.js`, `hr.js`). That PHP side lives in a separate repo (`saifsys/api/jarvis/v1`).
- Inbound: saifsys screens call `/api/from-saifsys/*` with their own key (`fromSaifsys.js`).
- Dates: the server runs on UTC; use `dubaiDate()` / `dubaiHour()` from `saifsys/client.js` for anything user-facing.

### Client
`client/src/App.jsx` is the shell; screens and sheets are in `client/src/components/`, API wrapper and helpers in `client/src/lib/` (`api.js`, `push.js`, `voice.js`, …). `client/src/sw.js` is the custom service worker (vite-plugin-pwa injectManifest) handling web push. Arabic content is common: PDFs use the bundled fonts in `server/fonts/` with RTL handling.

### Data on disk
`data/` holds uploaded originals (`data/uploads/`) and the embedding model cache; it is never deployed or overwritten. The server's `.env` is likewise never shipped by `deploy.ps1`.

## Conventions

- Comments explain *why* in plain language, often describing the user-visible behaviour; match that style.
- Design specs and implementation plans go in `docs/superpowers/specs/` and `docs/superpowers/plans/` (dated filenames).
- Feature flags are env vars read in `config.js` (e.g. `DOC_RENEWALS_SEND=on`); keep anything that emails or pushes to real people off by default locally.
- Branch `deploy/reem-cases` is what is live on the server; `main` is the PR base.

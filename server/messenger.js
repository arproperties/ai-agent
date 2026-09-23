// Messages between people: one-to-one and group chats, delivered live.
//
// Kept apart from the AI chats on purpose — its own tables (dm_*), its own routes
// (/api/messenger), and none of it reaches Claude on its own. The single exception is
// asked for by hand: a member tapping "Summarise" sends that one chat to the model, in
// dmSummary.js and nowhere else.
//
// "Live" is one Server-Sent Events stream per open app (GET /events). Sending, reading
// and typing are ordinary POSTs; the server then pushes the result down the streams of
// everyone it concerns. The list of open streams lives in this process's memory, which
// is right for the single PM2 process this runs as. Running several would need the hub
// to go through Postgres LISTEN/NOTIFY instead.
import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { extname } from 'node:path';
import { db, tx } from './db.js';
import { summarise, forget } from './dmSummary.js';
import { DATA_DIR } from './config.js';

const FILE_DIR = `${DATA_DIR}/messenger`;
const MAX_TEXT = 4000;
const PAGE = 50;
const IMAGE = /^image\/(png|jpe?g|gif|webp)$/; // shown in the chat; anything else is a download
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
const now = () => Math.floor(Date.now() / 1000);

// ---------- the hub: who has the app open ----------
const streams = new Map(); // userId -> Set<res>

export const isOnline = (userId) => streams.has(userId);

/** Push one event to every open app of these users. */
export function emit(userIds, event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const id of new Set(userIds)) for (const res of streams.get(id) || []) res.write(frame);
}
const everyone = () => [...streams.keys()];

const memberIds = async (chatId) =>
  (await db.prepare('SELECT user_id FROM dm_members WHERE chat_id = ?').all(chatId)).map((r) => r.user_id);

// ---------- shapes sent to the app ----------
// Exported so the master's oversight routes in admin.js can shape a transcript the
// same way this file does. Reading it from there is deliberate: the cross-user read
// lives behind requireMaster, not as a widening of the membership checks below.
export const MSG_SELECT = `SELECT m.*, r.user_id r_user_id, r.kind r_kind, r.body r_body, r.file_name r_file_name, r.deleted r_deleted
  FROM dm_messages m LEFT JOIN dm_messages r ON r.id = m.reply_to_id`;

export function messageOut(m) {
  return {
    id: m.id,
    chatId: m.chat_id,
    userId: m.user_id,
    kind: m.kind,
    body: m.deleted ? '' : m.body,
    deleted: m.deleted,
    createdAt: m.created_at,
    file: m.file_name && !m.deleted
      ? { name: m.file_name, mime: m.file_mime, size: m.file_size, url: `/api/messenger/files/${m.id}` }
      : null,
    replyTo: m.reply_to_id
      ? { id: m.reply_to_id, userId: m.r_user_id, kind: m.r_kind, deleted: !!m.r_deleted, body: m.r_deleted ? '' : (m.r_body || '').slice(0, 200), fileName: m.r_deleted ? null : m.r_file_name }
      : null,
  };
}

const getMessage = async (id) => {
  const m = await db.prepare(`${MSG_SELECT} WHERE m.id = ?`).get(id);
  return m && messageOut(m);
};

/** One chat as `userId` sees it: a direct chat is named after the other person. */
async function chatsFor(userId, chatId = null) {
  const rows = await db.prepare(`
    SELECT c.*, me.last_read_id my_read,
      (SELECT COUNT(*) FROM dm_messages m WHERE m.chat_id = c.id AND m.id > me.last_read_id
         AND m.user_id IS DISTINCT FROM me.user_id AND m.kind <> 'system')::int unread,
      l.id last_id
    FROM dm_chats c
    JOIN dm_members me ON me.chat_id = c.id AND me.user_id = ?
    LEFT JOIN LATERAL (SELECT id, created_at FROM dm_messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) l ON true
    -- In the list, an empty one-to-one chat only shows for whoever opened it, as in
    -- WhatsApp. Asked for by id it is always there: the other person may be opening it too.
    WHERE (?::int IS NULL AND (c.kind = 'group' OR l.id IS NOT NULL OR c.created_by = me.user_id) OR c.id = ?)
    ORDER BY COALESCE(l.created_at, c.created_at) DESC, c.id DESC`).all(userId, chatId, chatId);
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const members = await db.prepare(`SELECT mb.chat_id, mb.user_id, mb.role, mb.last_read_id, mb.last_delivered_id, u.name
    FROM dm_members mb JOIN users u ON u.id = mb.user_id WHERE mb.chat_id = ANY(?::int[]) ORDER BY mb.joined_at, u.name`).all(ids);
  const lastIds = rows.map((r) => r.last_id).filter(Boolean);
  const lasts = lastIds.length ? await db.prepare(`${MSG_SELECT} WHERE m.id = ANY(?::int[])`).all(lastIds) : [];
  const lastById = Object.fromEntries(lasts.map((m) => [m.id, messageOut(m)]));

  return rows.map((c) => {
    const ms = members.filter((m) => m.chat_id === c.id).map((m) => ({
      id: m.user_id, name: m.name, role: m.role, read: m.last_read_id, delivered: m.last_delivered_id,
    }));
    const peer = c.kind === 'direct' ? ms.find((m) => m.id !== userId) : null;
    return {
      id: c.id,
      kind: c.kind,
      name: c.kind === 'direct' ? peer?.name || 'Deleted user' : c.name,
      peerId: peer?.id ?? null,
      createdBy: c.created_by,
      members: ms,
      unread: c.unread,
      last: c.last_id ? lastById[c.last_id] : null,
      createdAt: c.created_at,
    };
  });
}
export const chatFor = async (userId, chatId) => (await chatsFor(userId, chatId))[0] || null;

const membership = (chatId, userId) => db.prepare(`SELECT mb.*, c.kind, c.name FROM dm_members mb JOIN dm_chats c ON c.id = mb.chat_id
  WHERE mb.chat_id = ? AND mb.user_id = ?`).get(Number(chatId), userId);

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// ---------- delivery and read pointers ----------
async function announcePointers(rows) {
  for (const r of rows) {
    emit(await memberIds(r.chat_id), 'receipt', { chatId: r.chat_id, userId: r.user_id, read: r.last_read_id, delivered: r.last_delivered_id });
  }
}

/** Everything waiting for this user has now reached their phone: the second grey tick. */
export async function markDelivered(userId) {
  const rows = await db.prepare(`UPDATE dm_members mb SET last_delivered_id = t.max_id
    FROM (SELECT chat_id, MAX(id) max_id FROM dm_messages
          WHERE chat_id IN (SELECT chat_id FROM dm_members WHERE user_id = ?) GROUP BY chat_id) t
    WHERE mb.chat_id = t.chat_id AND mb.user_id = ? AND t.max_id > mb.last_delivered_id
    RETURNING mb.chat_id, mb.user_id, mb.last_read_id, mb.last_delivered_id`).all(userId, userId);
  await announcePointers(rows);
}

async function postSystem(chatId, body) {
  const { id } = await db.prepare(`INSERT INTO dm_messages (chat_id, user_id, kind, body) VALUES (?, NULL, 'system', ?) RETURNING id`).run(chatId, body);
  await db.prepare('UPDATE dm_chats SET updated_at = ? WHERE id = ?').run(now(), chatId);
  emit(await memberIds(chatId), 'message', await getMessage(id));
}

// ---------- handlers (exported for the tests, the router below wires them up) ----------
export const messengerHandlers = {
  /** The live stream. Stays open; the app reconnects by itself if it drops. */
  events(req, res) {
    const userId = req.user.id;
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');

    const first = !streams.has(userId);
    if (first) streams.set(userId, new Set());
    streams.get(userId).add(res);
    res.write(`event: ready\ndata: ${JSON.stringify({ online: everyone() })}\n\n`);
    if (first) emit(everyone(), 'presence', { userId, online: true });
    markDelivered(userId).catch((e) => console.error('[messenger]', e.message));

    // nginx closes a quiet connection after 60s; a comment line every 25s keeps it open
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      const set = streams.get(userId);
      set?.delete(res);
      if (set && !set.size) {
        streams.delete(userId);
        const seen = now();
        db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(seen, userId).catch(() => {});
        emit(everyone(), 'presence', { userId, online: false, lastSeen: seen });
      }
    });
  },

  /** Everyone who can be messaged. It is a team app: every active account. */
  async people(req, res) {
    const rows = await db.prepare('SELECT id, name, email, last_seen_at FROM users WHERE id <> ? AND NOT disabled ORDER BY lower(name)').all(req.user.id);
    res.json(rows.map((u) => ({ id: u.id, name: u.name, email: u.email, online: isOnline(u.id), lastSeen: u.last_seen_at })));
  },

  async list(req, res) {
    res.json(await chatsFor(req.user.id));
  },

  async get(req, res) {
    const chat = await chatFor(req.user.id, Number(req.params.id));
    if (!chat) throw bad('Not found', 404);
    res.json(chat);
  },

  /** { userId } opens (or reuses) a one-to-one chat; { name, members } starts a group. */
  async create(req, res) {
    const me = req.user.id;
    if (req.body.userId) {
      const other = Number(req.body.userId);
      if (other === me) throw bad('You cannot message yourself');
      if (!await db.prepare('SELECT 1 FROM users WHERE id = ? AND NOT disabled').get(other)) throw bad('That person was not found', 404);
      const key = `${Math.min(me, other)}:${Math.max(me, other)}`;
      const id = await tx(async () => {
        const made = await db.prepare(`INSERT INTO dm_chats (kind, direct_key, created_by) VALUES ('direct', ?, ?)
          ON CONFLICT (direct_key) DO NOTHING RETURNING id`).run(key, me);
        if (made.id) {
          await db.prepare('INSERT INTO dm_members (chat_id, user_id) VALUES (?, ?), (?, ?)').run(made.id, me, made.id, other);
          return made.id;
        }
        return (await db.prepare('SELECT id FROM dm_chats WHERE direct_key = ?').get(key)).id;
      });
      return res.json(await chatFor(me, id));
    }

    const name = String(req.body.name || '').trim().slice(0, 60);
    if (!name) throw bad('Give the group a name');
    const wanted = [...new Set((Array.isArray(req.body.members) ? req.body.members : []).map(Number).filter((id) => id && id !== me))].slice(0, 255);
    const valid = wanted.length
      ? (await db.prepare('SELECT id FROM users WHERE id = ANY(?::int[]) AND NOT disabled').all(wanted)).map((r) => r.id)
      : [];
    if (!valid.length) throw bad('Add at least one person to the group');
    const id = await tx(async () => {
      const { id } = await db.prepare(`INSERT INTO dm_chats (kind, name, created_by) VALUES ('group', ?, ?) RETURNING id`).run(name, me);
      await db.prepare(`INSERT INTO dm_members (chat_id, user_id, role) VALUES (?, ?, 'admin')`).run(id, me);
      for (const u of valid) await db.prepare('INSERT INTO dm_members (chat_id, user_id) VALUES (?, ?)').run(id, u);
      return id;
    });
    await postSystem(id, `${req.user.name} created the group "${name}"`);
    emit(valid, 'chat', { id });
    res.json(await chatFor(me, id));
  },

  /** 50 at a time: ?before=<id> scrolls back, ?after=<id> catches up after a reconnect. */
  async messages(req, res) {
    const chatId = Number(req.params.id);
    if (!await membership(chatId, req.user.id)) throw bad('Not found', 404);
    const before = Number(req.query.before) || null;
    const after = Number(req.query.after) || null;
    const rows = after
      ? await db.prepare(`${MSG_SELECT} WHERE m.chat_id = ? AND m.id > ? ORDER BY m.id LIMIT 500`).all(chatId, after)
      : (await db.prepare(`${MSG_SELECT} WHERE m.chat_id = ? AND (?::int IS NULL OR m.id < ?) ORDER BY m.id DESC LIMIT ${PAGE}`)
        .all(chatId, before, before)).reverse();
    res.json({ messages: rows.map(messageOut), more: !after && rows.length === PAGE });
  },

  async send(req, res) {
    const me = req.user.id;
    const chatId = Number(req.params.id);
    if (!await membership(chatId, me)) throw bad('Not found', 404);
    const body = String(req.body.body || '').trim().slice(0, MAX_TEXT);
    const f = req.file;
    if (!body && !f) throw bad('The message is empty');

    let replyTo = Number(req.body.replyTo) || null;
    if (replyTo && !await db.prepare('SELECT 1 FROM dm_messages WHERE id = ? AND chat_id = ?').get(replyTo, chatId)) replyTo = null;

    const kind = f ? (IMAGE.test(f.mimetype) ? 'image' : 'file') : 'text';
    const name = f ? Buffer.from(f.originalname, 'latin1').toString('utf8').replace(/[/\\]/g, '_').slice(0, 200) : null;
    const { id } = await db.prepare(`INSERT INTO dm_messages (chat_id, user_id, kind, body, reply_to_id, file_name, file_mime, file_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).run(chatId, me, kind, body, replyTo, name, f?.mimetype ?? null, f?.size ?? null);
    if (f) {
      mkdirSync(`${FILE_DIR}/${chatId}`, { recursive: true });
      const path = `${FILE_DIR}/${chatId}/${id}${extname(name).toLowerCase().replace(/[^.\w]/g, '')}`;
      writeFileSync(path, f.buffer);
      await db.prepare('UPDATE dm_messages SET file_path = ? WHERE id = ?').run(path, id);
    }
    // Sending means the sender has read everything up to here.
    await db.prepare('UPDATE dm_members SET last_read_id = ?, last_delivered_id = ? WHERE chat_id = ? AND user_id = ?').run(id, id, chatId, me);
    await db.prepare('UPDATE dm_chats SET updated_at = ? WHERE id = ?').run(now(), chatId);

    // `nonce` lets the sender's app swap its "sending…" bubble for the real one.
    const msg = { ...await getMessage(id), nonce: String(req.body.nonce || '').slice(0, 40) || undefined };
    const members = await memberIds(chatId);
    emit(members, 'message', msg);

    // Whoever has the app open has it now: the second grey tick, straight away.
    const online = members.filter((u) => u !== me && isOnline(u));
    if (online.length) {
      const rows = await db.prepare(`UPDATE dm_members SET last_delivered_id = GREATEST(last_delivered_id, ?)
        WHERE chat_id = ? AND user_id = ANY(?::int[]) RETURNING chat_id, user_id, last_read_id, last_delivered_id`).all(id, chatId, online);
      await announcePointers(rows);
    }
    res.json(msg);
  },

  /** { upTo: <message id> } — the blue ticks. */
  async read(req, res) {
    const chatId = Number(req.params.id);
    if (!await membership(chatId, req.user.id)) throw bad('Not found', 404);
    const upTo = Number(req.body.upTo) || 0;
    const rows = await db.prepare(`UPDATE dm_members mb SET
        last_read_id = t.v, last_delivered_id = GREATEST(mb.last_delivered_id, t.v)
      FROM (SELECT LEAST(?::int, COALESCE(MAX(id), 0)) v FROM dm_messages WHERE chat_id = ?) t
      WHERE mb.chat_id = ? AND mb.user_id = ? AND t.v > mb.last_read_id
      RETURNING mb.chat_id, mb.user_id, mb.last_read_id, mb.last_delivered_id`).all(upTo, chatId, chatId, req.user.id);
    await announcePointers(rows);
    res.json({ ok: true });
  },

  async typing(req, res) {
    const chatId = Number(req.params.id);
    if (!await membership(chatId, req.user.id)) throw bad('Not found', 404);
    emit((await memberIds(chatId)).filter((u) => u !== req.user.id), 'typing', { chatId, userId: req.user.id });
    res.json({ ok: true });
  },

  /** Delete for everyone. Only your own messages; the bubble stays as "deleted". */
  async remove(req, res) {
    const m = await db.prepare('SELECT * FROM dm_messages WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
    if (!m || m.deleted) throw bad('Not found', 404);
    await db.prepare(`UPDATE dm_messages SET deleted = true, body = '', file_path = NULL, file_name = NULL, file_mime = NULL, file_size = NULL WHERE id = ?`).run(m.id);
    if (m.file_path) rmSync(m.file_path, { force: true });
    forget(m.chat_id); // deleting does not move the last id, so the cached summary has to go by hand
    emit(await memberIds(m.chat_id), 'message', await getMessage(m.id));
    res.json({ ok: true });
  },

  async file(req, res) {
    const m = await db.prepare('SELECT * FROM dm_messages WHERE id = ?').get(Number(req.params.id));
    if (!m?.file_path || !await membership(m.chat_id, req.user.id)) throw bad('Not found', 404);
    const inline = IMAGE.test(m.file_mime || '') && !req.query.download;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(m.file_name)}`);
    res.type(inline ? m.file_mime : 'application/octet-stream').sendFile(m.file_path);
  },

  /** "Summarise": what was said, and what it came to. Members only, and asked for by hand. */
  async summarise(req, res) {
    const chatId = Number(req.params.id);
    if (!await membership(chatId, req.user.id)) throw bad('Not found', 404);
    res.json(await summarise(chatId, req.user.id, { fresh: !!req.body?.fresh }));
  },

  // ---------- groups ----------
  /** Any member may rename a group, as in WhatsApp's default. */
  async rename(req, res) {
    const mine = await membership(req.params.id, req.user.id);
    if (!mine) throw bad('Not found', 404);
    if (mine.kind !== 'group') throw bad('Only groups have a name');
    const name = String(req.body.name || '').trim().slice(0, 60);
    if (!name) throw bad('Give the group a name');
    if (name !== mine.name) {
      await db.prepare('UPDATE dm_chats SET name = ? WHERE id = ?').run(name, mine.chat_id);
      await postSystem(mine.chat_id, `${req.user.name} renamed the group to "${name}"`);
      emit(await memberIds(mine.chat_id), 'chat', { id: mine.chat_id });
    }
    res.json(await chatFor(req.user.id, mine.chat_id));
  },

  /** Admins add people. They start from now: earlier messages count as already read. */
  async addMembers(req, res) {
    const mine = await membership(req.params.id, req.user.id);
    if (!mine) throw bad('Not found', 404);
    if (mine.kind !== 'group') throw bad('People can only be added to a group');
    if (mine.role !== 'admin') throw bad('Only group admins can add people', 403);
    const chatId = mine.chat_id;
    const ids = [...new Set((Array.isArray(req.body.userIds) ? req.body.userIds : []).map(Number).filter(Boolean))];
    const added = ids.length ? await db.prepare(`SELECT u.id, u.name FROM users u WHERE u.id = ANY(?::int[]) AND NOT u.disabled
      AND NOT EXISTS (SELECT 1 FROM dm_members mb WHERE mb.chat_id = ? AND mb.user_id = u.id) ORDER BY u.name`).all(ids, chatId) : [];
    if (added.length) {
      const top = (await db.prepare('SELECT COALESCE(MAX(id), 0) id FROM dm_messages WHERE chat_id = ?').get(chatId)).id;
      for (const u of added) {
        await db.prepare('INSERT INTO dm_members (chat_id, user_id, last_read_id, last_delivered_id) VALUES (?, ?, ?, ?)').run(chatId, u.id, top, top);
      }
      await postSystem(chatId, `${req.user.name} added ${added.map((u) => u.name).join(', ')}`);
      emit(await memberIds(chatId), 'chat', { id: chatId });
    }
    res.json(await chatFor(req.user.id, chatId));
  },

  /** An admin removes someone, or anyone removes themselves (leaving). */
  async removeMember(req, res) {
    const mine = await membership(req.params.id, req.user.id);
    if (!mine) throw bad('Not found', 404);
    if (mine.kind !== 'group') throw bad('You can only leave a group');
    const chatId = mine.chat_id;
    const target = Number(req.params.userId);
    const leaving = target === req.user.id;
    if (!leaving && mine.role !== 'admin') throw bad('Only group admins can remove people', 403);
    const gone = await db.prepare(`DELETE FROM dm_members mb USING users u WHERE u.id = mb.user_id AND mb.chat_id = ? AND mb.user_id = ?
      RETURNING u.name, mb.role`).get(chatId, target);
    if (!gone) throw bad('Not found', 404);
    emit([target], 'removed', { chatId });

    const left = await db.prepare('SELECT user_id, role FROM dm_members WHERE chat_id = ? ORDER BY joined_at, user_id').all(chatId);
    if (!left.length) {
      // the last person out takes the group, and its files, with them
      await db.prepare('DELETE FROM dm_chats WHERE id = ?').run(chatId);
      rmSync(`${FILE_DIR}/${chatId}`, { recursive: true, force: true });
      return res.json({ ok: true });
    }
    // a group always keeps an admin, or nobody could add people to it again
    if (!left.some((m) => m.role === 'admin')) {
      await db.prepare(`UPDATE dm_members SET role = 'admin' WHERE chat_id = ? AND user_id = ?`).run(chatId, left[0].user_id);
    }
    await postSystem(chatId, leaving ? `${gone.name} left` : `${req.user.name} removed ${gone.name}`);
    emit(left.map((m) => m.user_id), 'chat', { id: chatId });
    res.json({ ok: true });
  },

  /** Admins can make someone else an admin too. */
  async makeAdmin(req, res) {
    const mine = await membership(req.params.id, req.user.id);
    if (!mine) throw bad('Not found', 404);
    if (mine.role !== 'admin') throw bad('Only group admins can do that', 403);
    const r = await db.prepare(`UPDATE dm_members SET role = 'admin' WHERE chat_id = ? AND user_id = ?`).run(mine.chat_id, Number(req.params.userId));
    if (!r.changes) throw bad('Not found', 404);
    emit(await memberIds(mine.chat_id), 'chat', { id: mine.chat_id });
    res.json(await chatFor(req.user.id, mine.chat_id));
  },
};

// ---------- routes: mounted at /api/messenger, after requireUser ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const h = messengerHandlers;

export const messengerRoutes = Router();
messengerRoutes.get('/events', h.events);
messengerRoutes.get('/people', wrap(h.people));
messengerRoutes.get('/chats', wrap(h.list));
messengerRoutes.post('/chats', wrap(h.create));
messengerRoutes.get('/chats/:id', wrap(h.get));
messengerRoutes.patch('/chats/:id', wrap(h.rename));
messengerRoutes.get('/chats/:id/messages', wrap(h.messages));
messengerRoutes.post('/chats/:id/messages', upload.single('file'), wrap(h.send));
messengerRoutes.post('/chats/:id/read', wrap(h.read));
messengerRoutes.post('/chats/:id/typing', wrap(h.typing));
messengerRoutes.post('/chats/:id/summary', wrap(h.summarise));
messengerRoutes.post('/chats/:id/members', wrap(h.addMembers));
messengerRoutes.delete('/chats/:id/members/:userId', wrap(h.removeMember));
messengerRoutes.post('/chats/:id/members/:userId/admin', wrap(h.makeAdmin));
messengerRoutes.delete('/messages/:id', wrap(h.remove));
messengerRoutes.get('/files/:id', wrap(h.file));

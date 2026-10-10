# Live Translator — design

Date: 2026-10-10 · App: Reem (branch from `main`; not the leasing app)

## The problem

Two people who share no language need to talk. Each should speak their own language, and
the app should say it to the other in theirs, and keep a written record of the conversation.

## Decisions already made

- **One shared phone, face to face.** The second person needs no account and no device.
- **Two mic buttons**, one per person. The app always knows which language to expect.
- **Reem only.** Built from `main`.
- **Text history only.** The audio is thrown away once it has been read, as in Transcribe.

## How it works for the user

1. Open **Live Translator** from the menu (the row just above Meetings).
2. Pick the two languages. The last pair used is remembered. A swap button switches sides.
3. Person A taps their button and speaks. Recording stops by itself after about 1.5 seconds
   of quiet, or on a second tap.
4. A bubble appears on A's side with what they said, and under it the translation. The
   translation is read aloud.
5. Person B taps their button and answers the same way.
6. The conversation is saved as it goes. It appears in the history list on the same page.

Controls on the conversation screen:

- **Mute** turns the spoken translation off (text only). Remembered per device.
- **Tapping a bubble** reads its translation again.
- While a translation is being read aloud, both mic buttons are disabled, so the phone
  never records its own voice.

Each mic button is labelled in its own language's native name (for example "العربية" and
"English"), so the second person can find theirs without help.

## History

- One list of past conversations, newest first: title, the two languages, date, number of turns.
- The default title is the language pair, for example "English ↔ Arabic". It can be renamed.
- Opening one shows every turn: who spoke (side A or B), the original, the translation, the time.
- A past conversation can be continued, copied as plain text, or deleted.
- History is private to the signed-in user. A master does not see other people's.
- A conversation is only saved once it has its first turn, so opening the page and leaving
  does not create empty entries.

## Approach

Reuse the chain the app already has. One turn is three calls:

| Step | What | Existing code |
|---|---|---|
| Speech to text | `gpt-4o-mini-transcribe`, with the speaker's language passed as a hint | `transcribe()` in `server/ai.js` (gains an optional `language`) |
| Translate | Claude fast model, one short call | `ask()` in `server/ai.js` |
| Text to speech | `gpt-4o-mini-tts`, streamed | `/api/voice/speak` and `speakText()` in `client/src/lib/voice.js`, unchanged |

Expected wait is 2–3 seconds from the end of speech to the start of the spoken translation.

Rejected:

- **Speech-to-speech realtime API.** Under a second, but needs new streaming plumbing,
  costs more per minute, and makes an accurate written record harder to keep.
- **Browser speech recognition.** Free, but unreliable on iPhone and weak in Arabic and Urdu.

## Server

New file `server/translate.js`, mounted at `/api/translate`. Same shape as
`server/transcripts.js`: a router, the row functions, and an `engine` object holding the
two paid calls so tests can replace them.

```js
export const engine = {
  transcribe: (buffer, mimetype, language) => transcribe(buffer, mimetype, { language }),
  translate: (text, from, to) => ask(...),
};
```

Routes (all require sign-in; every query is scoped to `req.user.id`):

| Route | Does |
|---|---|
| `GET /languages` | The language list |
| `GET /` | The user's conversations, newest first, with turn count |
| `GET /:id` | One conversation and its turns |
| `POST /turns` | Multipart: `audio`, `side` (`a`/`b`), and either `id` or `langA` + `langB`. Creates the conversation if there is no `id`. Returns the conversation id and the new turn |
| `POST /:id/turns/:turnId/retry` | Translates a turn again whose translation failed |
| `PATCH /:id` | Rename |
| `DELETE /:id` | Delete the conversation and its turns |

`POST /turns` step by step:

1. Reject a missing file, a bad `side`, or a language not in the list (400).
2. Transcribe with the speaker's language as the hint. Empty text: return `{ turn: null }`
   and save nothing.
3. Translate into the other language.
4. Save the turn and return it.

The translation prompt asks for the translation only: no notes, no quotation marks, names
and numbers kept as spoken, natural spoken register. The spoken words are passed as data,
never as instructions, so "ignore the above and…" is simply translated.

### Languages

The server owns one list, in `server/translate.js`, of about 25 languages: code, English
name, native name, and whether it reads right to left. It starts with the ones this office
meets: English, Arabic, Urdu, Hindi, Bengali, Malayalam, Tamil, Tagalog, Nepali, Pashto,
Persian, Russian, Chinese, French. `GET /languages` hands it to the page, and the server
validates every request against it.

### Tables

```sql
CREATE TABLE IF NOT EXISTS translations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title  TEXT NOT NULL DEFAULT '',
  lang_a TEXT NOT NULL,
  lang_b TEXT NOT NULL,
  created_at BIGINT DEFAULT ${NOW},
  updated_at BIGINT DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS idx_translations_user ON translations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS translation_turns (
  id SERIAL PRIMARY KEY,
  translation_id INTEGER NOT NULL REFERENCES translations(id) ON DELETE CASCADE,
  side TEXT NOT NULL,            -- 'a' or 'b': who spoke
  original   TEXT NOT NULL,
  translated TEXT NOT NULL DEFAULT '',
  error TEXT,                    -- set when the translation failed
  created_at BIGINT DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS idx_translation_turns ON translation_turns(translation_id, id);
```

The languages are fixed for a conversation once it has a turn. Changing the pair starts a
new conversation.

## Client

- `client/src/components/Translate.jsx`: the page, titled "Live Translator". Two views in one component file: the
  history list and an open conversation. It builds its own frame, as `Transcribe.jsx` does, because the two mic buttons need a footer that stays put.
- Recording reuses `listenUntilSilence` from `client/src/lib/voice.js`. It currently posts
  to `/api/voice/transcribe` itself; it gains an option to hand back the recorded blob
  instead, so Live Translator can post it to `/api/translate/turns`. Live voice mode is unchanged.
- Speaking reuses `speakText(text, null, onState)`: no agent, so the neutral default voice.
- Language pickers are searchable and themed. No native `<select>`. They use `Picker.jsx`.
- Right-to-left languages render their bubbles with `dir="rtl"`.
- `SettingsMenu.jsx`: a "Live Translator" row with the `Languages` icon, directly above Meetings.
  `Sidebar.jsx` and `App.jsx` pass `translateOpen` / `onTranslate` and render the panel,
  the same way Transcribe is wired.

## When things go wrong

| Case | What the user sees |
|---|---|
| Mic blocked | "Microphone not available. Allow mic access in your browser settings." |
| Nothing was said | The button returns to idle. Nothing is saved |
| Transcription fails | A plain message under the buttons. Nothing is saved |
| Translation fails | The turn is saved with the original words and a **Try again** button |
| Speech fails | The text translation still shows; the bubble can be tapped to try again |
| Voice not configured | The page says so instead of showing mic buttons |

## Tests

`tests/translate.test.js`, with `engine` replaced so nothing is paid for:

- A turn on side A is transcribed with `lang_a` as the hint and translated into `lang_b`;
  side B is the reverse.
- The first turn creates the conversation; the second is added to it.
- No speech heard saves nothing.
- A failed translation saves the turn with its error; retry fills it in.
- Another user cannot read, add to, rename or delete a conversation (404).
- Deleting a conversation removes its turns.
- A language outside the list, or a bad `side`, is refused.
- Signed out is refused by where the router is mounted (below `requireUser`), as for every other router; checked by hand, since the suite has no HTTP harness.

The suite runs in `/root/jarvis-dev` on the droplet, never against production.

## Left out on purpose

- Hands-free mode that works out the language by itself.
- A second device joining the same conversation.
- Keeping the audio.
- Flipping the far side of the screen for the person opposite.
- Searching across history.

## Rollout

Built on a new branch from `main`. Nothing is deployed until Francis says so.

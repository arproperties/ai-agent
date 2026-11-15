// Spans: the tracker's memory of the day, built from a glance every five seconds.
//
// A glance says which window is in front, how long since the last key or mouse movement,
// and whether the screen is locked. Rather than keep every glance (17,000 a day), the book
// keeps spans: "this window, from–to". A new span starts only when something changes, so a
// day is a few hundred rows and the laptop barely notices.
//
// Kinds: active (someone is working in that window), idle (no input for IDLE_AFTER seconds,
// still unlocked: a phone call, a meeting at the desk), away (locked or asleep).

/** Seconds without mouse or keyboard before a stretch counts as idle, not work. */
export const IDLE_AFTER = 180;

const same = (a, b) => a.app === b.app && a.title === b.title && a.kind === b.kind;

export class SpanBook {
  constructor() {
    this.open = null; // the span being lived right now
    this.running = []; // [[from, to|null], …]: when the tracker itself was on, so HR sees gaps as gaps
  }

  /** The tracker is on from `at`. Marking while already on opens nothing new. */
  markRunning(at) {
    const last = this.running.at(-1);
    if (last && last[1] === null) return;
    this.running.push([at, null]);
  }

  /** The tracker stops at `at` (shutdown, sign-out). */
  stopRunning(at) {
    const last = this.running.at(-1);
    if (last && last[1] === null) last[1] = at;
  }

  /**
   * One glance. Returns the span it closed, if any, so the caller can keep it; null when the
   * day simply carries on. `app` null means nothing is focused (the desktop).
   */
  observe({ at, app, title, idleSeconds = 0, locked = false }) {
    const seen = { app: app || 'Desktop', title: app ? String(title || '') : '' };
    if (locked) return this.#move(at, { ...seen, kind: 'away' });
    if (idleSeconds >= IDLE_AFTER) {
      if (this.open?.kind === 'idle') return null; // still idle: nothing changed
      // Idle began when the hands left, not when we noticed: the active span ends there and
      // the idle span keeps the window the person idled on.
      const idleStart = Math.max(at - idleSeconds, this.open?.startedAt ?? at - idleSeconds);
      const idleOn = this.open ? { app: this.open.app, title: this.open.title } : seen;
      return this.#move(idleStart, { ...idleOn, kind: 'idle' });
    }
    return this.#move(at, { ...seen, kind: 'active' });
  }

  /** Close whatever is open at `at` (day end, shutdown). Null when nothing was open. */
  close(at) {
    const open = this.open;
    this.open = null;
    if (!open || at <= open.startedAt) return null;
    return { ...open, endedAt: at };
  }

  // Switch to `next` at `at`: close the open span there and start the new one.
  #move(at, next) {
    if (this.open && same(this.open, next)) return null;
    const closed = this.close(at);
    this.open = { startedAt: at, ...next };
    return closed;
  }
}

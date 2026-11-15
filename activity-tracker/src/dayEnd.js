// When the PC sends its day to Reem. Pure rules, so they can be tested without a clock.
//
// The day goes at the end time Reem gave us (half an hour before HR's email), once. If the
// PC is shut down earlier in the afternoon, that is the end of the day. Work done after the
// day was sent goes again at shutdown, so HR's next email lists the day as updated. After a
// failed try we wait fifteen minutes rather than hammer a Reem that is down.

const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

/** Earliest a shutdown counts as "going home" rather than a lunchtime restart. */
export const HOME_AFTER = '15:00';
/** Seconds to wait after a failed send before trying again. */
export const RETRY_AFTER = 900;

export function shouldSend({ nowDubai, dayEnd, sentAt, shuttingDown, lastTry, now, lastSpanAt }) {
  if (!shuttingDown && lastTry != null && now - lastTry < RETRY_AFTER) return false;
  const newSinceSend = sentAt != null && lastSpanAt != null && lastSpanAt > sentAt;
  if (shuttingDown) {
    if (toMin(nowDubai) < toMin(HOME_AFTER)) return false;
    return sentAt == null || newSinceSend;
  }
  if (sentAt != null) return false; // sent today; any later work waits for the shutdown
  return toMin(nowDubai) >= toMin(dayEnd);
}

/** Dates before `today` that have spans but never reached Reem: sent when the app starts. */
export const yesterdayUnsent = (store, today) => store.unsentDates().filter((d) => d < today);

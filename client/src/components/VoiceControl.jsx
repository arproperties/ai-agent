import { useEffect, useRef, useState } from 'react';
import { Mic } from 'lucide-react';
import { api } from '../lib/api';
import { listenUntilSilence, stopListening, micTaken } from '../lib/voice';
import { scan, act, risk, wait } from '../lib/voiceControl';

// Voice control: the app worked by speaking, from the Tour and in every screen opened over it. Switched on, it listens, does
// what was said, and listens again, until it is switched off or told to stop.
// It is not Riley. It presses and fills what is on the screen, and answers small talk; a
// real question about the business it hands to Riley, the words put in Riley's box as if typed. It
// wears its own colour so the two are never taken for each other, and it gives the
// microphone up the moment Riley's own is used, staying off until it is switched on again:
// two listeners taking turns would have each one hearing what was meant for the other.
// Only a press that cannot be taken back (a delete, a payment, signing out) waits for a yes.

const ROUNDS = 4; // screens gone through for one sentence: a menu, a tab, a button, and one to spare
const HINT = 'Just speak, in any language: "open leasing", "go back", or ask anything, like "who is behind on rent?". Say "stop listening" to end.';

export default function VoiceControl({ onOpenRiley }) {
  const [on, setOn] = useState(false);
  const [phase, setPhase] = useState('listening'); // 'listening' | 'working'
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState('');
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState(null); // the name of the press that is waiting for a yes
  const waiting = useRef(null); // { label, actions, list }: what a yes lets through
  const openRiley = useRef(onOpenRiley);
  openRiley.current = onOpenRiley;

  const hold = (label, actions, list) => { waiting.current = { label, actions, list }; setAsking(label); };
  const drop = () => { const w = waiting.current; waiting.current = null; setAsking(null); return w; };

  /** Does a run of actions. `free` of them, from the front, have been said yes to. False if it stopped to ask, or was told to stop. */
  const perform = async (actions, list, steps, free = 0) => {
    for (let k = 0; k < actions.length; k++) {
      const a = actions[k];
      if (a.do === 'stop') { setOn(false); return false; }
      if (a.do === 'yes' || a.do === 'no') continue;
      const label = k < free ? null : risk(a, list);
      if (label) { hold(label, actions.slice(k), list); return false; }
      steps.push(await act(a, list, { openRiley: () => openRiley.current?.() }));
      await wait(a.do === 'click' ? 350 : 120); // the screen is given time to answer
    }
    return true;
  };

  const obey = async (said, alive) => {
    const steps = [];
    let held = drop();
    for (let round = 0; round < ROUNDS && alive(); round++) {
      const view = scan();
      const res = await api.post('/voice/command', {
        text: said, steps, pending: held?.label,
        screen: { title: view.title, items: view.list.map(({ el, ...it }) => it) },
      });
      if (!alive()) return;
      setNote(res.say || (res.actions.length ? '' : 'I did not catch something to do. Try "open leasing", "go back", or just ask your question.'));
      if (held) {
        const answer = res.actions[0]?.do;
        if (answer === 'yes') { await perform(held.actions, held.list, steps, 1); return; }
        if (answer === 'no') { setNote(res.say || 'Left as it was.'); return; }
        held = null; // something else was said: the question is dropped, and this is done instead
      }
      if (!(await perform(res.actions, view.list, steps)) || !res.more) return;
      await wait(450);
    }
  };

  /** Yes or no, tapped rather than spoken. */
  const answer = async (yes) => {
    const held = drop();
    if (!held) return;
    if (yes) await perform(held.actions, held.list, [], 1);
    else setNote('Left as it was.');
  };

  useEffect(() => {
    if (!on) return undefined;
    let alive = true;
    let mine = false; // the microphone is ours to give up
    (async () => {
      while (alive) {
        setPhase('listening');
        const began = Date.now();
        let said = '';
        mine = true;
        try {
          said = await listenUntilSilence({ onLevel: (l) => alive && setLevel(l), onCaptured: () => alive && setPhase('working') });
        } catch (e) {
          mine = false;
          if (alive) { setNote(e.message); setOn(false); }
          return;
        }
        mine = false;
        if (!alive) return;
        if (!said) {
          // Cut off by Riley's own microphone: it is Riley being spoken to now.
          if (micTaken()) { setNote("Riley's microphone is in use, so voice control is off. Tap to turn it back on."); setOn(false); return; }
          if (Date.now() - began < 400) await wait(400);
          continue;
        }
        setHeard(said);
        setPhase('working');
        try { await obey(said, () => alive); } catch (e) { if (alive) setNote(e.message); }
      }
    })();
    return () => { alive = false; drop(); if (mine) stopListening(); };
  }, [on]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = () => { setNote(''); setHeard(''); setLevel(0); setOn(!on); };

  // Beside Riley's orb and made like it, so the two things that can be spoken to are found in one corner:
  // the same round button, this one green with a microphone. What it heard and did is said to its left.
  return (
    <div data-voice-control className="pointer-events-none fixed bottom-5 right-24 z-[60] flex max-w-[calc(100vw-7rem)] flex-row-reverse items-end gap-2">
      <button onClick={toggle} aria-pressed={on} aria-label={on ? 'Turn voice control off' : 'Turn voice control on'} title={on ? 'Voice control is on. Tap to turn it off.' : 'Voice control: work the app by speaking'}
        className={`pointer-events-auto relative grid size-14 shrink-0 place-items-center rounded-full border bg-surface shadow-xl transition hover:scale-105 active:scale-95 ${on ? 'border-emerald-400/70 text-emerald-300' : 'border-stroke text-mute hover:text-txt'}`}>
        {on && <span className="absolute inset-1.5 rounded-full bg-emerald-400/25 transition-transform duration-100" style={{ transform: `scale(${phase === 'listening' ? 0.7 + Math.min(level * 10, 0.5) : 0.7})` }} />}
        <Mic size={22} className={`relative ${on && phase === 'working' ? 'animate-pulse' : ''}`} />
      </button>
      {(on || note) && (
        <div role="status" className="pointer-events-auto min-w-0 max-w-xs rounded-2xl border border-emerald-400/30 bg-surface/95 px-3.5 py-2.5 text-xs shadow-xl shadow-black/30 backdrop-blur">
          {on && <p className="font-medium text-emerald-300">{asking ? 'Waiting for your yes' : phase === 'listening' ? 'Listening…' : 'Working…'}</p>}
          {on && heard && <p className="mt-1 text-mute">“{heard}”</p>}
          {asking ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1">{asking}? Say yes or no.</p>
              <button onClick={() => answer(true)} className="rounded-full bg-emerald-400/20 px-3 py-1 font-medium text-emerald-300">Yes</button>
              <button onClick={() => answer(false)} className="rounded-full border border-stroke px-3 py-1 text-mute hover:text-txt">No</button>
            </div>
          ) : (
            (note || (on && !heard)) && <p className="mt-1">{note || HINT}</p>
          )}
        </div>
      )}
    </div>
  );
}

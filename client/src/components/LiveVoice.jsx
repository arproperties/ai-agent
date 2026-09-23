import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import Orb from './Orb';
import { listenUntilSilence, stopListening, stopSpeaking, speakAndWait, speakAsItArrives, unlockAudio } from '../lib/voice';

// Hands-free mode: listen → answer out loud → listen again, until it is ended.
// Every turn costs a reply, a transcription and speech, so the loop stops itself
// rather than running on in a pocket: after a few silent turns, after MAX_TURNS,
// or after MAX_MINUTES, whichever comes first.
const MAX_TURNS = 20;
const MAX_MINUTES = 15;
const MAX_SILENT = 2;

const LABEL = {
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  idle: 'Starting…',
};

export default function LiveVoice({ onAsk, onClose, onError }) {
  const [state, setState] = useState('idle');   // listening | thinking | speaking
  const [heard, setHeard] = useState('');       // what it understood, so he can check it
  const [reply, setReply] = useState('');
  const [turns, setTurns] = useState(0);
  const [ending, setEnding] = useState('');     // why the loop stopped
  const [level, setLevel] = useState(0);        // mic loudness, drives the ring
  const alive = useRef(true);
  const startedAt = useRef(Date.now());
  // The loop runs once, so it must not capture the first render's onAsk — that
  // copy still thinks there is no conversation yet and would start a new one
  // on every question.
  const ask = useRef(onAsk);
  ask.current = onAsk;

  useEffect(() => {
    unlockAudio(); // the tap that opened this screen is what lets iOS play audio later
    let silent = 0;
    let count = 0;

    (async () => {
      while (alive.current) {
        if (count >= MAX_TURNS) return finish(`Ended after ${MAX_TURNS} questions.`);
        if (Date.now() - startedAt.current > MAX_MINUTES * 60000) return finish(`Ended after ${MAX_MINUTES} minutes.`);

        setState('listening');
        setLevel(0);
        let said;
        try {
          said = await listenUntilSilence({ onLevel: setLevel });
        } catch (e) {
          onError(e.message);
          return finish('Microphone unavailable.');
        }
        if (!alive.current) return;

        if (!said) { // heard nothing
          if (++silent >= MAX_SILENT) return finish('Ended — nothing heard.');
          continue;
        }
        silent = 0;
        setHeard(said);
        setReply('');
        setState('thinking');

        // Read the reply out while it is still being written — waiting for the
        // last word before speaking the first is most of the delay in a turn.
        let speech = null;
        let answer;
        try {
          answer = await ask.current(said, (soFar, agentId) => {
            setReply(soFar);
            speech ??= speakAsItArrives(agentId, (s) => {
              if (s === 'speaking') setState('speaking');
            });
            speech.feed(soFar);
          });
        } catch (e) {
          speech && stopSpeaking();
          onError(e.message);
          return finish('Something went wrong.');
        }
        if (!alive.current) return;
        if (!answer?.reply) { if (++silent >= MAX_SILENT) return finish('Ended — no reply.'); continue; }

        setReply(answer.reply);
        setTurns(++count);
        setState('speaking');
        if (speech) {
          speech.end(answer.reply); // speak whatever was not read out yet
          await speech.done;
        } else {
          await speakAndWait(answer.reply, answer.agentId); // reply arrived all at once
        }
        if (!alive.current) return;
      }
    })();

    function finish(why) {
      if (!alive.current) return;
      setEnding(why);
      setState('idle');
      alive.current = false;
    }

    return () => { alive.current = false; stopListening(); stopSpeaking(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Skip: stop this answer early and get straight back to listening.
  const skip = () => stopSpeaking();
  const close = () => { alive.current = false; stopListening(); stopSpeaking(); onClose(); };

  const ring = state === 'listening' ? Math.min(1, level * 14) : 0;

  return (
    <div className="sky fixed inset-0 z-50 flex flex-col pt-safe pb-safe">
      <header className="flex items-center justify-between px-4 py-3">
        <span className="text-sm font-medium text-mute">Live voice</span>
        <span className="text-xs text-mute">{turns}/{MAX_TURNS} questions</span>
      </header>

      <div className="flex flex-1 flex-col items-center justify-center gap-7 px-7 text-center">
        <div className="relative grid place-items-center">
          {/* the ring grows with his voice, so he can see it is hearing him */}
          <span className="absolute rounded-full border border-p1/40 transition-all duration-75"
            style={{ width: 190 + ring * 70, height: 190 + ring * 70, opacity: 0.25 + ring * 0.75 }} />
          <Orb state={state === 'thinking' ? 'thinking' : state === 'speaking' ? 'speaking' : 'listening'} className="w-[min(46vw,190px)]" />
        </div>

        <p className="text-lg font-medium">{ending || LABEL[state]}</p>

        {heard && !ending && (
          <p className="max-w-md text-sm text-mute">“{heard}”</p>
        )}
        {reply && state === 'speaking' && (
          <p className="max-h-40 max-w-md overflow-y-auto text-[15px] leading-relaxed text-txt/90">{reply}</p>
        )}
        {ending && <p className="text-sm text-mute">Tap Close, or start live voice again.</p>}
      </div>

      <div className="flex items-center justify-center gap-3 px-6 pb-6">
        {state === 'speaking' && !ending && (
          <button onClick={skip}
            className="glass flex h-12 items-center gap-2 rounded-full px-5 text-sm hover:bg-white/10">
            <Icon name="send" size={16} /> Skip answer
          </button>
        )}
        <button onClick={close}
          className="flex h-12 items-center gap-2 rounded-full bg-bad px-7 font-medium text-white transition active:scale-95">
          <Icon name="stop" size={15} /> {ending ? 'Close' : 'End'}
        </button>
      </div>
    </div>
  );
}

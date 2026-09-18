import { useRef, useState } from 'react';
import Icon from './Icon';
import { startRecording, stopRecording, cancelRecording, unlockAudio } from '../lib/voice';

const ACCEPT = 'image/*,.pdf,.docx,.txt,.md,.csv,.json,.html,.xml,.yaml,.yml,.log,.tsv';

export default function Composer({ busy, voiceEnabled, onSend, onStop, onVoiceState, onError }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [rec, setRec] = useState(null); // null | 'recording' | 'transcribing'
  const fileRef = useRef();
  const areaRef = useRef();

  const grow = (el) => { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 160)}px`; };

  const submit = (e) => {
    e?.preventDefault();
    if (busy || (!text.trim() && !files.length)) return;
    unlockAudio();
    onSend(text.trim(), files);
    setText('');
    setFiles([]);
    if (areaRef.current) areaRef.current.style.height = 'auto';
  };

  const toggleMic = async () => {
    unlockAudio();
    if (rec === 'recording') {
      setRec('transcribing');
      onVoiceState('thinking');
      try {
        const said = await stopRecording();
        if (said) onSend([text, said].filter(Boolean).join(' '), files, { voice: true });
        setText('');
        setFiles([]);
      } catch (e) {
        onError(e.message);
      }
      setRec(null);
      onVoiceState('idle');
      return;
    }
    try {
      await startRecording();
      setRec('recording');
      onVoiceState('listening');
    } catch {
      cancelRecording();
      onError('Microphone not available. Allow mic access in your browser settings.');
    }
  };

  const onKey = (e) => {
    // Enter sends on desktop; on phones Enter makes a new line
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) submit(e);
  };

  return (
    <form onSubmit={submit} className="px-3 pb-safe pt-2 md:px-6">
      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {files.map((f, i) => (
            <span key={i} className="glass flex max-w-[240px] items-center gap-1.5 rounded-full py-1 pl-3 pr-1 text-xs">
              <span className="truncate">{f.name}</span>
              <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label="Remove"
                className="grid size-6 place-items-center rounded-full hover:bg-white/10"><Icon name="x" size={13} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="glass flex items-end gap-1 rounded-[26px] p-1.5 shadow-2xl shadow-black/30">
        <input ref={fileRef} type="file" multiple accept={ACCEPT} hidden
          onChange={(e) => { setFiles([...files, ...e.target.files].slice(0, 10)); e.target.value = ''; }} />
        <button type="button" onClick={() => fileRef.current.click()} aria-label="Attach files"
          className="grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt">
          <Icon name="clip" />
        </button>
        <textarea ref={areaRef} rows={1} value={text} onKeyDown={onKey}
          onChange={(e) => { setText(e.target.value); grow(e.target); }}
          placeholder={rec === 'recording' ? 'Listening… tap the mic to finish' : rec ? 'Transcribing…' : 'Message'}
          className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-1 py-2 leading-6 outline-none placeholder:text-mute/70" />
        {voiceEnabled && !busy && (
          <button type="button" onClick={toggleMic} disabled={rec === 'transcribing'} aria-label={rec ? 'Stop recording' : 'Speak'}
            className={`grid size-10 shrink-0 place-items-center rounded-full transition ${rec === 'recording' ? 'animate-pulse bg-bad text-white' : 'text-mute hover:bg-white/10 hover:text-txt'}`}>
            <Icon name={rec === 'recording' ? 'stop' : 'mic'} />
          </button>
        )}
        {busy ? (
          <button type="button" onClick={onStop} aria-label="Stop"
            className="grid size-10 shrink-0 place-items-center rounded-full bg-white/15 text-white"><Icon name="stop" size={18} /></button>
        ) : (
          <button type="submit" disabled={!text.trim() && !files.length} aria-label="Send"
            className="grid size-10 shrink-0 place-items-center rounded-full bg-gradient-to-br from-p1 to-p2 text-white transition active:scale-95 disabled:opacity-30">
            <Icon name="send" size={18} />
          </button>
        )}
      </div>
    </form>
  );
}

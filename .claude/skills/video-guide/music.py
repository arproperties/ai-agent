# Quiet background loop made from plain sine/triangle tones: 4 chords at 80 bpm, a soft
# pulse on the beat, 1 s fade in, 2 s fade out, peaks at a quarter of full scale.
import math, struct, sys, wave

out, seconds = sys.argv[1], float(sys.argv[2])
SR, BPM = 44100, 80
beat = 60 / BPM
bar = beat * 4
n = int(SR * seconds)
hz = lambda m: 440 * 2 ** ((m - 69) / 12)
CHORDS = [[48, 55, 60, 64, 71], [45, 52, 57, 60, 67], [41, 48, 57, 60, 64], [43, 50, 55, 59, 62]]  # Cmaj7 Am7 Fmaj7 G
tri = lambda x: 2 / math.pi * math.asin(math.sin(x))

samples = []
for i in range(n):
    t = i / SR
    ch = CHORDS[int(t / bar) % 4]
    tb = t % bar
    swell = min(1, tb / 0.4) * (1 - 0.25 * tb / bar)
    pad = sum((tri if k == 0 else math.sin)(2 * math.pi * hz(m) * t) for k, m in enumerate(ch)) / len(ch) * swell
    tp = t % beat
    pulse = math.sin(2 * math.pi * hz(ch[0] + 12) * t) * math.exp(-tp * 9) * 0.35
    v = pad * 0.7 + pulse
    v *= min(1, t / 1.0) * min(1, (seconds - t) / 2.0)
    samples.append(v)

peak = max(abs(s) for s in samples) or 1
scale = 0.25 * 32767 / peak
with wave.open(out, 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(b''.join(struct.pack('<h', int(s * scale)) for s in samples))

---
name: video-guide
description: Make a short (~30 s) captioned "how to use Reem" video guide for one section of the app (To-dos, Shelf, Lease renewals, …), drawn in code to look like the real screen, with code-made background music. No AI APIs. Use when asked for a video guide, tutorial video, or explainer clip of a Reem feature.
---

# Reem video guide

Makes a 1920×1080 MP4 of about 30 seconds. A phone on the left shows the screen being used: typing, a ring on each tap, and items moving. Big captions on the right explain each step. It all runs on this Mac with Chrome, Node, Python and ffmpeg. **Never call an AI API, voice or image service for this.**

`example/todos.html` is a finished guide for To-dos. Copy it and change it; don't start from scratch.

## Steps

1. **One section only.** Read its screen in `client/src/components/<Screen>.jsx` and the colours in `client/src/index.css`. Copy the real labels, buttons, group names and empty texts. Never show or claim something the code doesn't do (e.g. check what chat really replies via the feature's kit in `server/`).
2. **Storyboard, 4–6 parts, ~30 s total:** intro (what it is) → 2–4 steps (one action each) → optional "Or just tell Reem in chat" tip → short close. Captions: a kicker (`STEP 1`), a title of 2 lines at most, and one plain sentence under it.
3. **Build** `scene.html` in the scratchpad from the example:
   - `SCENES` = `[start, end, kicker, titleHtml, sub]`. Wrap the key word in `<em>` to colour it.
   - Write one function per phone screen (`listScreen(t)`, `chatScreen(t)`, …) that returns HTML for time `t`. Everything must depend only on `t`: no timers, no random numbers.
   - Use `typed()` for typing, `ramp()` for fades and slides, and `TAPS` plus `targets` (element ids) for the tap ring.
   - Use made-up but believable data (units, tenants, DEWA, cheques). Never use real people's names or phones.
4. **Check stills first** (a quick look for text running off the edge, overlaps or low contrast):
   ```bash
   node .claude/skills/video-guide/capture.mjs $V/scene.html $V/stills 30 1
   ffmpeg -y -pattern_type glob -i "$V/stills/f*.jpg" -vf "select='eq(n\,2)+eq(n\,6)+eq(n\,13)+eq(n\,18)+eq(n\,22)+eq(n\,26)',scale=640:-1,tile=2x3" -frames:v 1 $V/sheet.jpg
   ```
   Read `sheet.jpg`, fix what's wrong, then check again.
5. **Render** (about 1 minute):
   ```bash
   python3 .claude/skills/video-guide/music.py $V/music.wav 30
   node .claude/skills/video-guide/capture.mjs $V/scene.html $V/frames 30 25
   ffmpeg -y -framerate 25 -i $V/frames/f%05d.jpg -i $V/music.wav -c:v libx264 -pix_fmt yuv420p -crf 20 -c:a aac -b:a 128k -shortest -movflags +faststart ~/Desktop/reem-<section>-guide.mp4
   open ~/Desktop/reem-<section>-guide.mp4
   ```
   `$V` = a folder in the scratchpad. If you change the length, pass the same number of seconds to both scripts.
6. **Tell the user** in a few short lines: where the file is, the step list, and anything left out.

## Notes
- `capture.mjs` starts headless Chrome on port 9337, calls `render(t)` for each frame and saves JPEGs at 1.5× scale.
- `music.py` uses only the standard library: 4 soft chords at 80 bpm, peaks at ¼ of full volume, 1 s fade in, 2 s fade out.
- Arabic captions: add `dir="rtl"` on the caption block. The Mac system fonts include Geeza Pro.
- It's a drawing, not a screen recording, so redo the video if the screen changes.

Copied from hey-buddy-onnx 0.1.2 (https://github.com/painebenjamin/hey-buddy), Apache License 2.0,
by Benjamin Paine. The models in client/public/heybuddy/ come from the same project
(https://huggingface.co/benjamin-paine/hey-buddy) under the same licence.

Changes from upstream, all marked in the code:
- onnx.js: the runtime is handed in with useRuntime() instead of imported by name.
- audio.js / hey-buddy.js: stop() added, so the microphone can be let go; the batcher keeps
  its start-up promise (ready) so a refused microphone can be caught.
- index.js (the demo page) and mutex.js (unused) are left out.

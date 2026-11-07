import { parentPort, workerData } from 'node:worker_threads';
import { gather } from './dropboxFiles.js';

// A Dropbox link's file work, in a thread of its own (dropbox.js, dropboxFiles.js): its
// memory is capped, and all of it is given back to the server when it ends.

gather(workerData.link, workerData.dir, { known: workerData.known })
  .then((r) => parentPort.postMessage({ ok: r }))
  .catch((e) => parentPort.postMessage({ error: e.message }));

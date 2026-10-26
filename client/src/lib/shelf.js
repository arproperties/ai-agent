import { api } from './api.js';
import { startJob, updateJob, finishJob, failJob } from './jobs.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Send files to the Shelf, ten to a request (the server's limit): a folder of forty court
 * files is four uploads, and the queue files them all whichever request brought them.
 * Shows as a job on the pet while it runs. Returns what the server said about each file;
 * throws if a request fails.
 */
export async function sendToShelf(files, agentId = null) {
  const all = [...files];
  const name = all.length === 1 ? `Uploading ${all[0].name}` : `Uploading ${plural(all.length, 'file')}`;
  const job = startJob(name, ['Packing', 'Uploading', 'Handing over']);
  const res = [];
  try {
    const rounds = Math.ceil(all.length / 10);
    for (let i = 0; i < all.length; i += 10) {
      const round = i / 10;
      // `next` is where this request will leave the bar, so the pet can creep towards it
      updateJob(job, { progress: round / rounds, next: (round + 1) / rounds, step: round ? 1 : 0 });
      const form = new FormData();
      if (agentId) form.append('agent', agentId);
      all.slice(i, i + 10).forEach((f) => form.append('files', f));
      res.push(...await api.upload('/documents', form));
      updateJob(job, { step: round + 1 < rounds ? 1 : 2 });
    }
    const dup = res.filter((r) => r.duplicate).length;
    const added = res.length - dup;
    finishJob(job, added
      ? `${plural(added, 'file')} on the Shelf. I'm reading and filing ${added === 1 ? 'it' : 'them'} now.${dup ? ` ${dup} ${dup === 1 ? 'was' : 'were'} already there.` : ''}`
      : `Already on your Shelf, so nothing new to file.`);
    return res;
  } catch (e) {
    failJob(job, `Upload stopped: ${e.message}`);
    throw e;
  }
}

// Long jobs the pet shows while they run: an upload to the Shelf, a file dropped on the pet.
// Kept outside React, like the importer, so a job keeps its card when the screen changes.
//
//   const id = startJob('Uploading 4 files', ['Uploading', 'Reading', 'Filing']);
//   updateJob(id, { progress: 0.5, step: 1 });
//   finishJob(id, '4 files uploaded. I am filing them now.');   // or failJob(id, message)

let jobs = []; // { id, name, steps, step, progress, state: 'running' | 'done' | 'failed', message, started }
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn(jobs));
const patch = (id, changes) => { jobs = jobs.map((j) => (j.id === id ? { ...j, ...changes } : j)); emit(); };
let next = 1;

export const currentJobs = () => jobs;
export function onJobs(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function startJob(name, steps = ['Working']) {
  const id = next++;
  jobs = [...jobs, { id, name, steps, step: 0, progress: 0, state: 'running', message: '', started: Date.now() }];
  emit();
  return id;
}

// `next` is where the current piece of work will leave the bar, when that is known: the
// pet creeps towards it so a single slow request does not look stuck.
export const updateJob = (id, { progress, next, step }) => patch(id, {
  ...(progress != null ? { progress: Math.max(0, Math.min(1, progress)) } : {}),
  ...(next != null ? { next: Math.max(0, Math.min(1, next)) } : {}),
  ...(step != null ? { step } : {}),
});

// A finished job stays a few seconds, so the card can say how it went, then goes.
const settle = (id, changes) => {
  patch(id, changes);
  setTimeout(() => { jobs = jobs.filter((j) => j.id !== id); emit(); }, 6000);
};
export const finishJob = (id, message) => settle(id, { state: 'done', progress: 1, message });
export const failJob = (id, message) => settle(id, { state: 'failed', message });
export const dismissJob = (id) => { jobs = jobs.filter((j) => j.id !== id); emit(); };

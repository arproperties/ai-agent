// What the signed-in person may change (server/actions.js): 'add', 'edit', 'delete'. Set
// once from /auth/me and read wherever a button that adds, edits or deletes is offered.
// The server checks every request again; this only keeps what would be refused from
// being offered.
let held = new Set();

export const setActions = (list) => { held = new Set(list || []); };
export const canDo = (key) => held.has(key);

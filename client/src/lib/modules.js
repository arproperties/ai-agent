// The modules the signed-in person holds (server/modules.js): one per place in the left
// menu. Set once from /auth/me and read wherever a screen, or a button into one, is
// offered. The server checks every request again; this only keeps what would be refused
// from being offered.
let held = new Set();

export const setModules = (list) => { held = new Set(list || []); };
export const can = (key) => held.has(key);

// Which module each section of the Leasing page belongs to. Its three ways in are one module.
const TAB = { overview: 'overview', bookings: 'leasing', '3d': 'leasing', calendar: 'leasing', tenants: 'tenants',
  workorders: 'workorders', reports: 'reports', alerts: 'alerts', documents: 'documents' };

/** The module the open screen belongs to, or null when it is one everybody has. */
export const moduleOf = (panel, leasingTab) => (panel === 'leasing' ? TAB[leasingTab] || 'overview'
  : panel === 'properties' || panel === 'sources' ? panel : panel === 'activitylog' ? 'activity' : null);

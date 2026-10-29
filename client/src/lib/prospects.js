// Prospects (server/prospects.js): people interested in a unit, before they are tenants.

export const STATUSES = [['new', 'New'], ['viewing', 'Viewing booked'], ['applied', 'Applied'], ['lost', 'Lost']];

/** What the lease form starts from when Make lease is pressed: the prospect's details, and its id so the saved lease is tied to it. */
export const leasePreset = (p) => ({
  prospect_id: p.id,
  company_id: p.company_id ? String(p.company_id) : '', // as the form's pickers hold them
  building_id: p.building_id ? String(p.building_id) : '',
  unit_id: p.unit_id ?? '',
  start_date: p.move_in_date || '',
  source: p.source || '',
  tenant: { full_name: p.full_name, phone: p.phone || '', email: p.email || '' },
});

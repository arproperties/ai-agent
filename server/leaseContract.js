import { writeFileSync } from 'node:fs';
import { db } from './db.js';
import { DATA_DIR } from './config.js';
import { saveFile } from './properties.js';
import { bad, bookingRef, dayNo, getBooking, monthlyRent, money } from './leasing.js';
import { region } from './leasingRegion.js';
import { usDate, usPhone } from './usFormat.js';

// The lease contract for one lease, as a PDF on the owning company's name: the lease itself
// (the details page, then the terms, then the signatures), and after it the Bed Bug Addendum.
// It follows the layout of the lease forms the office used before (boxes A to N on the first
// page), but the wording is our own. What the lease knows is typed in; what it does not
// (occupants, notice days, reletting charge…) is left as a line to fill in by hand.
//
// A new lease gets one by itself, kept with its documents as a generated "Lease Contract",
// and that copy is made again when the lease is changed. The signed copy is added beside it.

const DOC_DIR = `${DATA_DIR}/leasing`;
const NOTE = 'Made by the system from the lease. Print it, have it signed, and add the signed copy.';

// The built-in PDF fonts only know Western letters; anything else would stop the page being made.
const plain = (v) => String(v ?? '').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
const ordinal = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
const FREQ = { monthly: 'every month', quarterly: 'every 3 months', every_6_months: 'every 6 months', yearly: 'once a year', upfront: 'in full on the first day' };

/** Everything the contract says, read from the lease, its unit, building, company and tenant. */
export async function contractRow(bookingId) {
  const b = await getBooking(bookingId);
  const place = await db.prepare(`SELECT bl.address, bl.city, bl.emirate AS state, bl.zip, c.address AS c_address, c.city AS c_city, c.state AS c_state, c.zip AS c_zip, c.phone AS c_phone, c.email AS c_email
    FROM prop_units u JOIN prop_buildings bl ON bl.id = u.building_id JOIN prop_companies c ON c.id = bl.company_id WHERE u.id = ?`).get(b.unit_id);
  const alerts = await db.prepare("SELECT value FROM lease_settings WHERE key = 'alerts'").get();
  const late = alerts && JSON.parse(alerts.value).latefee;
  return { ...b, ...place, latefee: late?.on && (late.amount > 0 || late.percent > 0) ? late : null };
}

/** The rent of the part first month, when the lease bills one: [amount, 'first' | 'second'], or null. */
function partMonth(b) {
  if (!b.prorate || b.payment_frequency !== 'monthly' || b.start_date.endsWith('-01')) return null;
  const days = new Date(Date.UTC(+b.start_date.slice(0, 4), +b.start_date.slice(5, 7), 0)).getUTCDate();
  const last = `${b.start_date.slice(0, 8)}${String(days).padStart(2, '0')}`;
  const upTo = b.end_date < last ? b.end_date : last;
  const amount = Number(b.part_month_amount) > 0 ? Number(b.part_month_amount) : money((monthlyRent(b) * (dayNo(upTo) - dayNo(b.start_date) + 1)) / days);
  return [amount, b.prorate];
}

// ---------- the wording ----------

// The lease's terms, in our own words. { bar } is a section heading; { n, h, t } a numbered paragraph,
// with `sub` for one under another.
const TERMS = [
  { bar: 'LEASE TERMS AND CONDITIONS' },
  { n: '1.', h: 'Words Used in This Lease.', t: '"Residents" are the people named as residents on page 1 who sign this Lease; each may live in the apartment. "Occupants" are the people named as occupants, who may live in the apartment but do not sign. "Owner," "we," "us" and "our" mean the owner named on page 1, acting itself or through its manager or agents. "Rent" means the monthly rent in Box C together with the monthly charges in Box L. "House Rules" are our written rules for the apartment, the building and the grounds. "Lease" means this contract, every addendum to it, the House Rules and the Special Provisions.' },
  { n: '2.', h: 'The Apartment.', t: 'We let you the apartment in Box A to live in as a private home, and for no other use. Only the residents and occupants named in this Lease may live there.' },
  { n: '2.1', sub: true, h: 'Keys and Access.', t: 'You will receive keys or access devices for the apartment, the mailbox and any other locks we list on the move-in form. All of them must be returned when you move out.' },
  { n: '2.2', sub: true, h: 'Sizes.', t: 'Any measurements or sizes given for the apartment are estimates; the actual sizes may be different.' },
  { n: '3.', h: 'Rent.', t: 'You must pay the Rent in advance, on or before each due date stated on page 1, without our having to ask for it. Not paying the Rent in full on time is a serious breach of this Lease.' },
  { n: '3.1', sub: true, h: 'How to Pay.', t: 'Pay in the way and at the place we tell you. We do not have to accept cash unless we agree in writing, and we may at any time require that all sums due be paid together in one payment. You may not hold back or reduce the Rent unless the law allows it.' },
  { n: '3.2', sub: true, h: 'How Payments Are Applied.', t: 'Each sum owed under this Lease is a separate obligation. We may apply any money we receive first to sums you owe other than Rent, and then to Rent, whatever is written on the payment.' },
  { n: '3.3', sub: true, h: 'Late Payment.', t: 'If the monthly rent is not received in full by the time stated in Box G, you must pay the late fees stated there. A late fee is our reasonable estimate of the cost and trouble a late payment causes us.' },
  { n: '3.4', sub: true, h: 'Returned Payments.', t: 'For each check that is returned unpaid, or electronic payment that is rejected, you must pay the fee in Box H, plus any late fees, until we receive the full amount by a method we accept. After a returned payment we may require all future payments to be made by certified funds.' },
  { n: '3.5', sub: true, h: 'Rent Changes.', t: 'The Rent will not change during the initial term unless this Lease says otherwise or we both agree in writing. After the initial term we may change the Rent or other terms by giving you written notice at least as many days in advance as Box F states, plus 5 days.' },
  { n: '4.', h: 'Renewal and Notice to Move Out.', t: 'When the initial term ends, this Lease continues from month to month unless you or we give written notice to end it at least the number of days before stated in Box F. If Box F is left blank, at least 30 days\' written notice is required.' },
  { n: '5.', h: 'Security Deposit.', t: 'The security deposit in Box E is due by the day you sign this Lease. It is not rent, and it may not be used to pay Rent unless we agree in writing.' },
  { n: '5.1', sub: true, h: 'Refund.', t: 'To receive your refund you must give us written notice of moving out as this Lease requires, and your forwarding address in writing. Within 30 days after you surrender the apartment, or any other time the law requires, we will return the deposit less lawful deductions, with a written list of anything deducted. If more than one person signs, any refund may be made in one payment to all residents together.' },
  { n: '6.', h: 'Utilities and Services.', t: 'You will pay for all utilities and services not stated as provided by us, with their deposits and fees, as Box M says. Utilities metered to the apartment must be in your name from the start of this Lease until you move out, and must not be cut off for non-payment. If they are not, you will pay what the service cost us while it should have been in your name, plus the charge in Box M. During a power cut use only battery lighting; no candles or flames.' },
  { n: '7.', h: 'Insurance.', t: 'Our insurance does not cover your belongings or your liability. We strongly recommend renter\'s insurance that covers theft, fire, water damage and liability, and you must carry any insurance Box N requires.' },
  { n: '8.', h: 'Ending This Lease Early.', t: 'You may end this Lease before the end of the term only as this paragraph or the law allows. If you move out early without doing so, you remain responsible for the Rent until the end of the term or until the apartment is let to someone else, whichever comes first.' },
  { n: '8.1', sub: true, h: 'Reletting Charge.', t: 'If you do not move in, move out without giving the notice required, move out owing Rent, are asked to leave because of your default, or are evicted, you must pay the reletting charge in Box I. It covers our cost of finding a new resident only; it does not release you from Rent or any other sum you owe.' },
  { n: '8.2', sub: true, h: 'Early Termination Option.', t: 'If Box J is filled in, you may end this Lease early by giving written notice of the number of days stated there, paying the fee in Box J within the time stated, not being in default, and repaying any rent discounts you have received.' },
  { n: '8.3', sub: true, h: 'Rights Under the Law.', t: 'The law may give you the right to end this Lease early in some situations, such as military service, family violence, certain sexual offenses or stalking, or the death of a sole resident.' },
  { n: '9.', h: 'If the Apartment Is Not Ready.', t: 'If you cannot move in on the start date because of construction, repairs, cleaning or a former resident who has not left, this Lease stays in force, but the Rent is reduced day by day until you can move in. If the delay is more than a few days, you may end this Lease by written notice and receive back any deposit and Rent you paid.' },
  { bar: 'LIVING IN THE APARTMENT' },
  { n: '10.', h: 'House Rules.', t: 'You, your occupants and your guests must follow the House Rules. We may change them from time to time by giving you a written copy, as long as the change applies to every apartment in the building and does not change the amounts you pay under this Lease.' },
  { n: '10.1', sub: true, h: 'Guests.', t: 'A person not named in this Lease may not stay in the apartment for more than 3 nights in a row, or more than 7 nights in a month, without our written consent. We may refuse entry to the property to anyone who breaks the law, this Lease or the House Rules.' },
  { n: '10.2', sub: true, h: 'Criminal Convictions.', t: 'You must tell us in writing within 15 days if you or any occupant is convicted of a felony or of a crime involving violence, drugs or damage to property, or must register as a sex offender.' },
  { n: '11.', h: 'Conduct.', t: 'You must keep the apartment clean and safe, take your trash out at least once a week, and use the apartment and the common areas with care. You, your occupants and your guests must not: break the law or keep illegal drugs; threaten anyone or act violently; show a weapon in the common areas; disturb other residents or our staff; be loud, especially during quiet hours; tamper with utilities or safety equipment; bring dangerous materials onto the property; store anything in a closet with a water heater or furnace; use a gas appliance or open flame to heat the apartment; smoke except as this Lease allows; or run a business from the apartment that brings customers, clients or staff to it.' },
  { n: '12.', h: 'Animals.', t: 'No animals of any kind, even for a short time, are allowed anywhere on the property without our written consent and a signed animal agreement. Feeding stray animals is not allowed. If an animal is kept without consent, you must pay the charges in Box K from the day it arrived until it is removed, and the cost of cleaning and repairing any damage it caused. After written notice left in the apartment, we may remove an animal kept without consent.' },
  { n: '13.', h: 'Parking.', t: 'Parking is not guaranteed. You must follow our parking rules. We may tow, at the owner\'s cost, any vehicle that is parked against the rules, is not in working order, or has no current registration, as the law allows.' },
  { n: '14.', h: 'When We May Enter.', t: 'We, our staff and our contractors may enter the apartment at reasonable times for repairs, inspections, pest control, showings to buyers or new residents, and other reasonable business reasons, and at any time in an emergency. If nobody is home, we will leave a written notice in the apartment saying that we entered.' },
  { n: '15.', h: 'Repairs.', t: 'Ask for repairs in writing, except in an emergency such as fire, smoke, gas, flooding or a crime in progress, when you must call us at once. A request from one resident is a request from all of them. You must tell us in writing straight away about water leaks, mold, electrical problems, broken locks or anything else that may harm people or property. We will make repairs within a reasonable time; the Rent is not reduced while they are made unless the law requires it. We decide how repairs are done and who does them.' },
  { n: '15.1', sub: true, h: 'Damage You Cause.', t: 'You must pay for any damage to the apartment or the property caused by you, your occupants, your guests or your animals, beyond normal wear and tear, including blocked drains caused by improper items and damage from doors or windows left open.' },
  { n: '16.', h: 'Changes to the Apartment.', t: 'You may not paint, wallpaper, drill, change or add locks, install fixtures or appliances, or otherwise alter the apartment without our written consent. A few small nail holes for pictures are allowed. Any improvement you make becomes ours unless we agree otherwise in writing.' },
  { n: '17.', h: 'Subletting.', t: 'You may not assign this Lease, sublet the apartment, or rent or advertise any part of it to anyone, including as a short-term or vacation rental, without our written consent.' },
  { n: '18.', h: 'Safety and Security.', t: 'We will provide the locks, latches, door viewers and smoke alarms the law requires, rekey the locks after the previous resident moves out, and test the smoke alarms when you move in. You must replace smoke alarm batteries as needed, must never disable an alarm, and must tell us at once of any lock, alarm or safety device that is missing or not working. You will pay for rekeying you ask for and for repairs to devices damaged by you or your guests.' },
  { n: '18.1', sub: true, h: 'No Guarantee of Security.', t: 'We do not provide security services and do not promise that you, your guests or your belongings will be safe. Gates, cameras, lights and alarms can fail. In an emergency call 911.' },
  { n: '19.', h: 'Loss and Injury.', t: 'Unless the law requires otherwise, we are not liable for injury, loss or damage to you, your occupants, your guests or your belongings caused by other people, crime, fire, water, weather, utility failures or any other cause, except our own negligence.' },
  { n: '20.', h: 'Condition at Move-In.', t: 'You accept the apartment as it is, except for conditions that affect health or safety. You will receive a move-in inspection form. Within 48 hours after moving in you must note on it any damage or problems and return it signed; otherwise the apartment will be treated as clean, safe and in good working order. The form is not a repair request.' },
  { n: '21.', h: 'Notices.', t: 'Notices under this Lease must be in writing. A notice to one resident is a notice to all, and a notice from one resident is a notice from all. We may send notices, including notices to pay or vacate, by hand, by mail, or by email to the address you gave us; tell us in writing if your email address changes.' },
  { bar: 'DEFAULT AND REMEDIES' },
  { n: '22.', h: 'Everyone Is Responsible.', t: 'Each resident is responsible for the whole of this Lease, not only a share of it. A breach by any resident, occupant or guest is a breach by all residents. You will hold us harmless from claims caused by you, your occupants or your guests.' },
  { n: '23.', h: 'Default.', t: 'You are in default if you do not pay the Rent or any other sum on time; if you, an occupant or a guest breaks this Lease, the House Rules or the law; if you gave false information on your rental application; or if you or an occupant is charged with a crime that endangers people or involves illegal drugs.' },
  { n: '23.1', sub: true, h: 'Notice to Vacate and Eviction.', t: 'If you are in default, we may end your right to live in the apartment by giving you written notice to vacate, or to pay or vacate, as the law allows. Accepting money after such a notice does not cancel it, and ending your right to stay does not end your duty to pay Rent for the rest of the term.' },
  { n: '23.2', sub: true, h: 'What You Must Pay.', t: 'If you default, you must pay all Rent and charges owed, the reletting charge, any rent discounts you received, the cost of repairs, and our reasonable attorney\'s fees, court costs and collection costs. Unpaid sums bear interest as the law allows. We may report unpaid sums to credit agencies.' },
  { n: '23.3', sub: true, h: 'Holding Over.', t: 'If you stay after the date you must leave, you will pay Rent for each day you remain at the current Rent plus 25%, and any loss we suffer because a new resident cannot move in.' },
  { n: '24.', h: 'No Waiver.', t: 'Our staff and agents cannot change or waive any part of this Lease except in writing signed by us. If we do not enforce a right, or accept a late payment, we do not give up that right or any other.' },
  { bar: 'MOVING OUT' },
  { n: '25.', h: 'Move-Out Notice.', t: 'You must give us written notice of moving out as Box F and paragraph 4 require, even if this Lease has become month to month. The notice may not end this Lease before the end of the term. The move-out date can be changed only if we both agree in writing.' },
  { n: '26.', h: 'Cleaning and Inspection.', t: 'When you move out you must clean the apartment thoroughly, remove all your belongings and trash, and return all keys and access devices. If you do not, you will pay reasonable charges for cleaning, rekeying and removal. We may inspect the apartment with you; any estimate given during that inspection is subject to our final accounting.' },
  { n: '27.', h: 'Surrender and Abandonment.', t: 'You have surrendered the apartment when the move-out date has passed and nobody is living there, or when all keys have been returned, whichever comes first. The apartment is abandoned when everyone appears to have left, the Rent is unpaid, and you have not answered within 2 days a written notice we left on the inside of the main door. After surrender, abandonment or eviction we may enter, clean, relet, and remove and store or dispose of anything left behind, as the law allows. You must pay the reasonable cost of doing so.' },
  { bar: 'GENERAL PROVISIONS' },
  { n: '28.', h: 'Severability.', t: 'If any part of this Lease is found invalid, the rest of it remains in force.' },
  { n: '29.', h: 'Governing Law.', t: 'This Lease is governed by the law of the state where the apartment is. Any legal action about it must be brought in the county where the apartment is.' },
  { n: '30.', h: 'Entire Agreement.', t: 'This Lease, with its addenda, is the whole agreement between you and us. You are not relying on any spoken promise. It may be changed only in writing signed by you and us. It binds anyone who buys the property from us. An electronic signature is binding.' },
  { n: '31.', h: 'Events Beyond Our Control.', t: 'We are excused from any duty under this Lease that we cannot carry out because of events beyond our control, such as storms, floods, fire, epidemics, strikes, war or government orders.' },
];

const BED_BUGS = [
  { n: '1.', h: 'Addendum.', t: (p) => `This addendum is part of the Lease between the residents and the owner for unit ${p.unit_no} at ${p.building}${p.where ? `, ${p.where}` : ''}.` },
  { n: '2.', h: 'Purpose.', t: () => 'This addendum sets out how bed bugs are prevented, reported and treated, and who pays for treatment. We rely on what you tell us in it.' },
  { n: '3.', h: 'What We Know.', t: () => 'We are not aware of bed bugs, or any sign of them, in the apartment at this time.' },
  { n: '4.', h: 'Your Inspection.', t: () => 'By signing this addendum you confirm that you have inspected the apartment and found no sign of bed bugs, or that you will inspect it within 48 hours after moving in and tell us in writing at once of any bed bugs or signs of them you find.' },
  { n: '5.', h: 'Telling Us.', t: () => 'You must tell us promptly, in writing, if you see or suspect bed bugs in the apartment, in your furniture, clothing or belongings; if anyone in the apartment has bites or skin irritation that may be caused by bed bugs; or if a pest-control professional tells you bed bugs are present.' },
  { n: '6.', h: 'Treatment.', t: () => 'You must let us and our pest-control company into the apartment at reasonable times to inspect for and treat bed bugs, and prepare the apartment as we tell you. We may also inspect and treat the apartments next to yours. You must not treat the apartment for bed bugs yourself. When we treat the apartment, you must at the same time, at your own cost, have your furniture, clothing and belongings treated by a licensed pest-control company we approve.' },
  { n: '7.', h: 'Cooperation.', t: () => 'If bed bugs are found, you must work with us and our pest-control company and follow every instruction to clean and treat the apartment and the building until they are gone.' },
  { n: '8.', h: 'Costs.', t: () => 'You may have to pay the reasonable cost of inspecting, cleaning and treating your apartment for bed bugs, including where they are found after you move out. If other residents must be moved so that apartments next to yours can be treated, you may have to pay the rent we lose and the costs of moving them and of treating their apartments.' },
  { n: '9.', h: 'Default.', t: () => 'If you do not cooperate, or do not pay a cost you owe under this addendum, you are in default of the Lease, and we may end your right to live in the apartment and use every remedy the Lease gives us.' },
  { n: '10.', h: 'Moving to Another Apartment.', t: () => 'If we agree to move you to another apartment because of bed bugs, your belongings must first be treated by a licensed pest-control professional, and you must give us proof of it.' },
];

// ---------- drawing ----------

const PAGE = [612, 792]; // US Letter
const L = 40;
const R = 572;
const TOP = 752;
const BOTTOM = 52;

/** The lease contract and the bed bug addendum as one PDF, from contractRow(). The PDF library is loaded when the first one is made. */
export async function renderContract(p) {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  doc.setTitle(`Lease Contract - Unit ${p.unit_no}, ${p.building}`);
  const F = {
    r: await doc.embedFont(StandardFonts.Helvetica),
    b: await doc.embedFont(StandardFonts.HelveticaBold),
    i: await doc.embedFont(StandardFonts.HelveticaOblique),
    bi: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    v: await doc.embedFont(StandardFonts.CourierBold), // what is typed in from the lease
  };
  const ink = rgb(0.1, 0.1, 0.12);
  const grey = rgb(0.4, 0.4, 0.44);
  const red = rgb(0.78, 0.1, 0.22);
  const white = rgb(1, 1, 1);
  const shade = rgb(0.92, 0.92, 0.93);

  const ref = bookingRef(p);
  const sym = region().currency === 'USD' ? '$' : region().currency;
  const amt = (n) => (n == null || n === '' ? '' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const street = p.address || '';
  const where = [p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const owner = [p.c_address, p.c_city, [p.c_state, p.c_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');

  let page;
  const text = (s, x, y, { size = 8, f = F.r, color = ink, right = false, center = false } = {}) => {
    const t = plain(s);
    const w = f.widthOfTextAtSize(t, size);
    page.drawText(t, { x: right ? x - w : center ? x - w / 2 : x, y, size, font: f, color });
    return w;
  };
  const hline = (x1, x2, y, { color = ink, thickness = 0.5 } = {}) => page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  const rect = (x, y, w, h, o) => page.drawRectangle({ x, y, width: w, height: h, ...o });
  const tick = (x, y, on) => {
    rect(x, y - 1, 7, 7, { borderColor: ink, borderWidth: 0.6 });
    if (on) text('X', x + 1.2, y, { size: 7, f: F.v });
  };
  // A label, then a line to `x2` with the value typed on it.
  const field = (label, value, x, y, x2, { size = 8, f = F.r } = {}) => {
    const w = label ? text(label, x, y, { size, f }) + 3 : 0;
    hline(x + w, x2, y - 2);
    if (value !== '' && value != null) text(value, x + w + 3, y, { size: 8.5, f: F.v });
  };

  // Words in runs ([text, font]) broken into lines no wider than `width`.
  const wrap = (runs, width, size) => {
    const lines = [];
    let line = [];
    let w = 0;
    for (const [t, f] of runs) {
      for (const word of plain(t).split(/(\s+)/)) {
        if (!word) continue;
        if (/^\s+$/.test(word)) { if (line.length) { line.push([' ', f]); w += f.widthOfTextAtSize(' ', size); } continue; }
        const ww = f.widthOfTextAtSize(word, size);
        if (w + ww > width && line.length) {
          while (line.length && line.at(-1)[0] === ' ') line.pop();
          lines.push(line);
          line = [];
          w = 0;
        }
        line.push([word, f]);
        w += ww;
      }
    }
    while (line.length && line.at(-1)[0] === ' ') line.pop();
    if (line.length) lines.push(line);
    return lines;
  };
  // A line drawn a run of one font at a time, so the spaces between its words are the font's own.
  const drawRuns = (line, x, y, size, color = ink) => {
    const runs = line.reduce((out, [t, f]) => (out.at(-1)?.[1] === f ? (out.at(-1)[0] += t, out) : [...out, [t, f]]), []);
    // A hair more where the font changes, so a viewer that swaps Helvetica for a wider font still leaves a gap.
    for (const [t, f] of runs) x += text(t, x, y, { size, f, color }) + (/\s$/.test(t) ? size * 0.15 : 0);
  };

  // Text that runs down the page in columns, onto new pages as needed.
  const flow = ({ cols = 2, top, gap = 16, onPage }) => {
    const colW = (R - L - gap * (cols - 1)) / cols;
    const st = { col: 0, y: top, top };
    const x = () => L + st.col * (colW + gap);
    const room = (h) => {
      if (st.y - h >= BOTTOM) return;
      if (st.col < cols - 1) { st.col += 1; st.y = st.top; return; }
      page = doc.addPage(PAGE);
      onPage?.();
      Object.assign(st, { col: 0, y: TOP, top: TOP });
    };
    return {
      st,
      colW,
      x,
      room,
      para(runs, { size = 7.6, indent = 0, after = 3.5 } = {}) {
        const lead = size * 1.24;
        for (const line of wrap(runs, colW - indent, size)) {
          room(lead);
          drawRuns(line, x() + indent, st.y - size, size);
          st.y -= lead;
        }
        st.y -= after;
      },
      bar(label) {
        room(30); // a heading is never the last thing in a column
        rect(x(), st.y - 12, colW, 12, { color: red });
        text(label, x() + colW / 2, st.y - 9, { size: 7.5, f: F.b, color: white, center: true });
        st.y -= 17;
      },
      gap(h) { st.y -= h; },
    };
  };

  // ---------- page 1: the parties and the lease details ----------
  page = doc.addPage(PAGE);
  let y = TOP;
  text(p.company, L, y - 4, { size: 13, f: F.b });
  text([owner, usPhone(p.c_phone), p.c_email].filter(Boolean).join('  ·  '), L, y - 16, { size: 7, color: grey });
  text('Apartment Lease Contract', R, y - 4, { size: 15, f: F.b, right: true });
  text('This is a binding contract. Read it carefully before signing.', R, y - 16, { size: 7.5, f: F.b, right: true });
  text(`Lease ${ref}`, R, y - 26, { size: 7, color: grey, right: true });
  y -= 42;
  text('This Lease Contract ("Lease") is made between you, the resident(s) named below, and us, the owner named below. "You" and "your" mean', L, y, { size: 7.6, f: F.b });
  text('every resident. "We," "us" and "our" mean the owner.', L, y - 10, { size: 7.6, f: F.b });
  y -= 26;

  text('PARTIES', L, y, { size: 9, f: F.b, color: red });
  y -= 14;
  const half = (R - L - 24) / 2;
  const mid = L + half + 24;
  field('Residents', p.tenant, L, y, L + half, { f: F.b });
  field('Owner', p.company, mid, y, R, { f: F.b });
  for (let k = 1; k <= 3; k++) hline(L, L + half, y - 2 - k * 13);
  field('Occupants', '', mid, y - 20, R, { f: F.b });
  hline(mid, R, y - 35);
  y -= 58;

  text('LEASE DETAILS', L, y, { size: 9, f: F.b, color: red });
  y -= 6;
  const frameTop = y;
  const W = R - L;
  const pad = 6;
  // One band of the details frame: its height, drawn with `fill(top)` inside, with a rule under it.
  const band = (h, fill) => { fill(y); y -= h; hline(L, R, y, { color: red, thickness: 1 }); };
  const head = (label, x, top, note) => {
    const w = text(label, x + pad, top - 11, { size: 8, f: F.b });
    if (note) text(note, x + pad + w + 4, top - 11, { size: 7, color: grey });
  };
  const small = (s, x, top, { f = F.i, size = 6.6, width = 150 } = {}) => {
    let yy = top;
    for (const line of wrap([[s, f]], width, size)) { drawRuns(line, x, yy, size); yy -= size * 1.2; }
    return yy;
  };

  band(50, (t) => {
    head('A. Apartment', L, t, '(Par. 2)');
    field('Street Address:', street, L + pad, t - 24, L + 300);
    field('Building:', p.building, L + 308, t - 24, R - pad);
    field('Unit No.', p.unit_no, L + pad, t - 40, L + 130);
    field('City:', p.city || '', L + 138, t - 40, L + 330);
    field('State:', p.state || '', L + 338, t - 40, L + 420);
    field('Zip:', p.zip || '', L + 428, t - 40, R - pad);
  });
  band(20, (t) => {
    text('B. Initial Lease Term.', L + pad, t - 13, { size: 8, f: F.b });
    field('Begins:', usDate(p.start_date), L + 100, t - 13, L + 270);
    field('Ends at 11:59 p.m. on:', usDate(p.end_date), L + 280, t - 13, R - pad);
  });

  // C and D, E, F side by side.
  const c1 = L + W * 0.3;
  const c2 = L + W * 0.58;
  band(92, (t) => {
    const part = partMonth(p);
    head('C. Monthly Rent', L, t, '(Par. 3)');
    field(sym, amt(monthlyRent(p)), L + pad, t - 26, c1 - pad);
    let note = '';
    if (p.discount_type) note = `After a discount of ${p.discount_type === 'percent' ? `${Number(p.discount_value)}%` : `${sym} ${amt(p.discount_value)}`}${p.discount_note ? ` (${p.discount_note})` : ''}.`;
    if (Number(p.tax_percent) > 0) note += ` Plus ${region().tax_name} of ${Number(p.tax_percent)}%.`;
    if (note) small(note.trim(), L + pad, t - 36, { width: c1 - L - 2 * pad });
    page.drawLine({ start: { x: L, y: t - 46 }, end: { x: c1, y: t - 46 }, thickness: 0.7, color: red });
    head('D. Prorated Rent', L, t - 46);
    field(sym, part ? amt(part[0]) : '', L + pad, t - 70, c1 - pad);
    tick(L + pad, t - 81, part?.[1] === 'first');
    text('due for the rest of the 1st month, or', L + pad + 10, t - 80, { size: 6.8 });
    tick(L + pad, t - 90, part?.[1] === 'second');
    text('due with the 2nd month', L + pad + 10, t - 89, { size: 6.8 });

    page.drawLine({ start: { x: c1, y: t }, end: { x: c1, y: t - 92 }, thickness: 1, color: red });
    head('E. Security Deposit', c1, t, '(Par. 5)');
    field(sym, Number(p.security_deposit) > 0 ? amt(p.security_deposit) : '', c1 + pad, t - 26, c2 - pad);
    small('This amount does not include any animal deposit, which is set out in a separate animal agreement.', c1 + pad, t - 40, { width: c2 - c1 - 2 * pad, f: F.bi });

    page.drawLine({ start: { x: c2, y: t }, end: { x: c2, y: t - 92 }, thickness: 1, color: red });
    head('F. Notice to Move Out', c2, t, '(Par. 4)');
    text('At least', c2 + pad, t - 26, { size: 7.6 });
    hline(c2 + pad + 30, c2 + pad + 80, t - 28);
    text("days' written notice to end this Lease", c2 + pad + 84, t - 26, { size: 7.6 });
    small('or to move out is required at the end of the initial term or of any renewal.', c2 + pad, t - 37, { width: R - c2 - 2 * pad, f: F.r, size: 7.2 });
    small('If no number of days is filled in, at least 30 days\' notice is required.', c2 + pad, t - 58, { width: R - c2 - 2 * pad, f: F.bi });
  });

  // G. Late fees.
  band(46, (t) => {
    head('G. Late Fees', L, t, '(Par. 3.3)');
    const lf = p.no_late_fees ? null : p.latefee;
    if (p.no_late_fees) {
      text('No late fees are charged on this Lease.', L + pad, t - 26, { size: 8.5, f: F.v });
      return;
    }
    text('Initial late fee:', L + pad, t - 24, { size: 7.6, f: F.b });
    tick(L + pad + 62, t - 24, !!(lf?.percent > 0));
    field('', lf?.percent > 0 ? String(Number(lf.percent)) : '', L + pad + 72, t - 24, L + pad + 112);
    text("% of the rent due, or", L + pad + 115, t - 24, { size: 7.6 });
    tick(L + pad + 190, t - 24, !!(lf?.amount > 0));
    field(sym, lf?.amount > 0 ? amt(lf.amount) : '', L + pad + 200, t - 24, L + pad + 290);
    text(lf?.amount > 0 && lf?.percent > 0 ? '(both are charged)' : '', L + pad + 295, t - 24, { size: 6.8, color: grey });
    text('Charged if the rent is not paid in full within', L + pad, t - 38, { size: 7.6 });
    field('', lf ? String(Number(lf.days) || 0) : '', L + pad + 160, t - 38, L + pad + 200);
    text('days after its due date (by 11:59 p.m. on the last of those days).', L + pad + 204, t - 38, { size: 7.6 });
  });

  // H and I, J, K side by side.
  band(96, (t) => {
    head('H. Returned Payment Fee', L, t, '(Par. 3.4)');
    field(sym, '', L + pad, t - 26, c1 - pad);
    page.drawLine({ start: { x: L, y: t - 36 }, end: { x: c1, y: t - 36 }, thickness: 0.7, color: red });
    head('I. Reletting Charge', L, t - 36, '(Par. 8.1)');
    field(sym, '', L + pad, t - 60, c1 - pad);
    small('Not more than 85% of the highest monthly Rent during the term. It may be charged in the cases set out in Par. 8.1.', L + pad, t - 70, { width: c1 - L - 2 * pad });

    page.drawLine({ start: { x: c1, y: t }, end: { x: c1, y: t - 96 }, thickness: 1, color: red });
    head('J. Early Termination Option', c1, t, '(Par. 8.2)');
    field('Fee', '', c1 + pad, t - 26, c2 - pad);
    field('Notice of', '', c1 + pad, t - 40, c2 - 55);
    text('days', c2 - 50, t - 40, { size: 7.6 });
    field('Fee paid within', '', c1 + pad, t - 54, c2 - 55);
    text('days', c2 - 50, t - 54, { size: 7.6 });
    small('Not available if you are in default. If any of these are blank or 0, this option does not apply.', c1 + pad, t - 66, { width: c2 - c1 - 2 * pad, f: F.bi });

    page.drawLine({ start: { x: c2, y: t }, end: { x: c2, y: t - 96 }, thickness: 1, color: red });
    head('K. Violation Charges', c2, t);
    text('Animal kept without consent (Par. 12):', c2 + pad, t - 24, { size: 7.4, f: F.b });
    field(`First charge ${sym}`, '', c2 + pad, t - 37, R - 60);
    text('per animal', R - 56, t - 37, { size: 7.2 });
    field(`Daily charge ${sym}`, '', c2 + pad, t - 50, R - 60);
    text('per animal', R - 56, t - 50, { size: 7.2 });
    text('No insurance as required (Box N):', c2 + pad, t - 66, { size: 7.4, f: F.b });
    field(sym, '', c2 + pad, t - 80, R - pad);
  });

  // L. Monthly charges besides the rent, and the charges due once.
  const monthly = p.fees.filter((f) => f.repeats);
  const once = p.fees.filter((f) => !f.repeats);
  const lines = Math.max(3, monthly.length);
  band(28 + lines * 12 + 14, (t) => {
    head('L. Additional Monthly Charges.', L, t);
    small('You will pay these with the rent each month, as well as anything set out in an addendum or the Special Provisions.', L + 150, t - 11, { width: R - L - 160, f: F.r, size: 7 });
    for (let k = 0; k < lines; k++) {
      const f = monthly[k];
      field(k < monthly.length ? '' : 'Other:', f ? f.label : '', L + pad, t - 26 - k * 12, R - 120);
      field(sym, f ? amt(f.amount) : '', R - 110, t - 26 - k * 12, R - pad);
    }
    const yy = t - 26 - lines * 12;
    field('Charges due once, at the start:', once.map((f) => `${f.label} ${sym} ${amt(f.amount)}`).join('; '), L + pad, yy, R - pad);
  });

  // M. Utilities.
  band(36, (t) => {
    head('M. Utilities and Other Charges That Vary.', L, t);
    small('You will pay separately for electricity, gas, water, wastewater, trash and any other utility not provided by us, as set out in an addendum or the Special Provisions.', L + 190, t - 11, { width: R - L - 200, f: F.r, size: 7 });
    tick(L + pad, t - 30, !!p.tenant_energy_account);
    text('The electricity account is in the resident\'s name.', L + pad + 10, t - 29, { size: 7.4 });
    field(`Utility connection or transfer charge (Par. 6): ${sym}`, '', L + 250, t - 29, R - pad, { size: 7.4 });
  });

  // N. How and when the rent is paid, and other requirements.
  band(46, (t) => {
    head('N. Payments and Other Requirements.', L, t);
    const day = p.prorate ? 1 : Number(p.start_date.slice(8, 10));
    const how = p.payment_frequency === 'upfront' ? 'The whole Rent for the term is due on the first day of the term.'
      : `Rent is paid ${FREQ[p.payment_frequency] || 'every month'}, due on the ${ordinal(day)} day of the month${p.payment_frequency === 'monthly' ? '' : ' it falls due in'}.`;
    const rules = [p.no_checks && 'Checks are not accepted.', p.no_partial_payments && 'Partial payments are not accepted.'].filter(Boolean).join(' ');
    text(`${how} ${rules}`, L + pad, t - 24, { size: 8, f: F.v });
    field(`Required liability insurance, per occurrence: ${sym}`, '', L + pad, t - 38, L + 290, { size: 7.4 });
    field(`Replacement key or access device: ${sym}`, '', L + 300, t - 38, R - pad, { size: 7.4 });
  });
  band(18, (t) => {
    text('Special Provisions.', L + pad, t - 12, { size: 8, f: F.b });
    text('See Par. 32 and any addenda attached. This Lease may be changed only in writing signed by you and us.', L + 86, t - 12, { size: 7.6 });
  });
  rect(L, y, W, frameTop - y, { borderColor: red, borderWidth: 1.6 });

  // ---------- the terms, then the signatures ----------
  page = doc.addPage(PAGE);
  const fl = flow({ top: TOP });
  for (const item of TERMS) {
    if (item.bar) { fl.bar(item.bar); continue; }
    fl.para([[`${item.n} `, F.b], [`${item.h} `, F.b], [item.t, F.r]], { indent: item.sub ? 10 : 0 });
  }
  fl.para([['32. ', F.b], ['Special Provisions. ', F.b], ['The following, and any addenda or House Rules given to you, are part of this Lease and take the place of anything in it that says otherwise.', F.r]]);
  for (let k = 0; k < 8; k++) { fl.room(13); fl.gap(13); hline(fl.x(), fl.x() + fl.colW, fl.st.y); }
  fl.gap(10);
  fl.para([['Before signing this Lease you should read it, with all its addenda, and you may consult an attorney. You are bound by this Lease once it is signed. It is the entire agreement between you and us; you are not relying on any spoken promise.', F.b]], { size: 7.4 });
  fl.gap(4);
  const sign = (name) => {
    fl.room(30);
    fl.gap(20);
    const x = fl.x();
    hline(x, x + fl.colW * 0.66, fl.st.y);
    hline(x + fl.colW * 0.72, x + fl.colW, fl.st.y);
    text(name || '(Name of Resident)', x, fl.st.y - 8, { size: 6.8, f: name ? F.b : F.r, color: name ? ink : grey });
    text('Date signed', x + fl.colW * 0.72, fl.st.y - 8, { size: 6.8, color: grey });
    fl.gap(9);
  };
  fl.para([['Resident or Residents ', F.bi], ['(all sign below)', F.i]], { after: 0 });
  sign(p.tenant);
  sign('');
  sign('');
  fl.gap(6);
  fl.para([['Owner or Owner\'s Representative ', F.bi], [`(signing for ${p.company})`, F.i]], { after: 0 });
  sign(' ');
  const leasePages = doc.getPageCount();

  // ---------- the bed bug addendum ----------
  page = doc.addPage(PAGE);
  y = TOP;
  text(p.company, L, y - 4, { size: 13, f: F.b });
  text([owner, usPhone(p.c_phone), p.c_email].filter(Boolean).join('  ·  '), L, y - 16, { size: 7, color: grey });
  text('Bed Bug Addendum', R, y - 4, { size: 15, f: F.b, right: true });
  text(`Lease ${ref}`, R, y - 16, { size: 7, color: grey, right: true });
  y -= 34;
  const note = wrap([['Please note: we want every resident to enjoy a clean and healthy home. Keeping bed bugs out of the building takes all of us working together. This addendum sets out your part in that, and what you may have to pay if bed bugs are found.', F.i]], W - 60, 8.4);
  const noteH = note.length * 10.5 + 14;
  rect(L + 20, y - noteH, W - 40, noteH, { color: shade, borderColor: red, borderWidth: 1 });
  note.forEach((line, k) => drawRuns(line, L + 28, y - 15 - k * 10.5, 8.4));
  y -= noteH + 16;
  const bb = flow({ cols: 1, top: y });
  const at = { unit_no: p.unit_no, building: p.building, where: [street, where].filter(Boolean).join(', ') };
  for (const item of BED_BUGS) bb.para([[`${item.n} `, F.b], [`${item.h} `, F.b], [item.t(at), F.r]], { size: 8.6, after: 5 });
  bb.gap(6);
  bb.room(120);
  hline(L, R, bb.st.y, { color: red, thickness: 1 });
  bb.gap(16);
  text('This Addendum is part of your Lease.', L + W / 2, bb.st.y, { size: 9, f: F.b, center: true });
  text('You are legally bound by it. Please read it carefully.', L + W / 2, bb.st.y - 11, { size: 9, f: F.b, center: true });
  bb.gap(30);
  const sx = L + W / 2 + 12;
  const sw = W / 2 - 12;
  text('Resident or Residents ', L, bb.st.y, { size: 8.4, f: F.b });
  text('Owner or Owner\'s Representative', sx, bb.st.y, { size: 8.4, f: F.b });
  let sy = bb.st.y - 26;
  for (const name of [p.tenant, '', '']) {
    hline(L, L + sw * 0.66, sy);
    hline(L + sw * 0.72, L + sw, sy);
    text(name || '(Name of Resident)', L, sy - 8, { size: 6.8, f: name ? F.b : F.r, color: name ? ink : grey });
    text('Date signed', L + sw * 0.72, sy - 8, { size: 6.8, color: grey });
    sy -= 28;
  }
  hline(sx, sx + sw * 0.66, bb.st.y - 26);
  hline(sx + sw * 0.72, sx + sw, bb.st.y - 26);
  text(`For ${p.company}`, sx, bb.st.y - 34, { size: 6.8, color: grey });
  text('Date signed', sx + sw * 0.72, bb.st.y - 34, { size: 6.8, color: grey });
  text('You are entitled to a copy of this addendum once it is fully signed. Keep it in a safe place.', L + W / 2, Math.max(sy - 6, BOTTOM + 4), { size: 7.6, f: F.i, center: true });

  // Footers, now the pages are counted.
  doc.getPages().forEach((pg, k) => {
    page = pg;
    const inLease = k < leasePages;
    text(inLease ? `Apartment Lease Contract  ·  ${p.company}  ·  ${ref}` : `Bed Bug Addendum  ·  ${p.company}  ·  ${ref}`, L, 30, { size: 6.8, color: grey });
    text(inLease ? `Page ${k + 1} of ${leasePages}` : 'Page 1 of 1', R, 30, { size: 6.8, color: grey, right: true });
    if (inLease) text('Resident initials: ______', L + W / 2, 30, { size: 6.8, color: grey, center: true });
  });

  return { bytes: Buffer.from(await doc.save()), name: `Lease Contract - Unit ${plain(p.unit_no).replace(/[\\/:*?"<>|]/g, '-')} - ${ref}.pdf` };
}

export const contractPdf = async (bookingId) => renderContract(await contractRow(bookingId));

/**
 * Keep the lease's generated contract with its documents: made the first time, made again
 * over the same file after that. Gives back the document's id.
 */
export async function fileContract(bookingId, by) {
  const b = await getBooking(bookingId);
  if (b.status === 'cancelled') throw bad('A cancelled lease gets no new contract.', 409);
  const { bytes, name } = await contractPdf(b.id);
  const had = await db.prepare('SELECT id, file_path FROM lease_documents WHERE booking_id = ? AND generated ORDER BY id LIMIT 1').get(b.id);
  if (had?.file_path) {
    writeFileSync(had.file_path, bytes);
    await db.prepare('UPDATE lease_documents SET file_name = ? WHERE id = ?').run(name, had.id);
    return had.id;
  }
  if (had) await db.prepare('DELETE FROM lease_documents WHERE id = ?').run(had.id);
  const row = { booking_id: b.id, title: 'Lease Contract', category: 'lease', notes: NOTE, generated: true, uploaded_by: by ?? null,
    ...saveFile({ buffer: bytes, originalname: name, mimetype: 'application/pdf' }, DOC_DIR) };
  const cols = Object.keys(row);
  const { id } = await db.prepare(`INSERT INTO lease_documents (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`).run(...cols.map((c) => row[c]));
  return id;
}

/** After a lease is made or changed: its contract made (again). A contract that cannot be made never stops the lease being saved. */
export async function keepContract(bookingId, by, { onlyIfKept = false } = {}) {
  try {
    if (onlyIfKept && !(await db.prepare('SELECT 1 FROM lease_documents WHERE booking_id = ? AND generated').get(Number(bookingId)))) return;
    await fileContract(bookingId, by);
  } catch (e) {
    console.error(`Lease contract for lease ${bookingId} not made:`, e.message);
  }
}

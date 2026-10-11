# Module access — design

Date: 2026-10-11
Status: draft, for review (nothing built yet)
Branch: `leasing-bookings`

## 1. The problem

Every signed-in person sees the same left menu as the master: Overview, Leasing, Tenants,
Reports and the rest. Staff will soon be given accounts (a property manager, a
receptionist), and most of those screens are not theirs to see. Today the only switch is
master or not master, and it decides single buttons, not whole screens.

## 2. What success looks like

- The master opens a person's profile on People, ticks the modules that person gets, and
  that is all there is to set.
- When that person signs in, the left menu holds only their modules.
- A module that is not ticked cannot be reached any other way: not by a link, not by
  asking Riley, not by Voice control, not by calling the server directly.
- Someone with nothing ticked has exactly what they have always had: Chats.

## 3. Decisions made with Francis (2026-10-11)

| # | Decision | Why |
|---|----------|-----|
| D1 | A **module is one left-menu item**. | The menu is already how the app is divided; no second vocabulary to learn. |
| D2 | Modules are ticked **per person**, on their People profile. No roles. | "Enable the modules. That's it." A role layer can be added later without undoing this. |
| D3 | **Module level only**: a module is on or off. No view-only level. | Same reason. |
| D4 | **Nothing ticked means Chats only**, for existing accounts as well as new ones. | It is what a person has without leasing; nobody gains a screen by default. |
| D5 | The master has every module and is never listed. | Same rule as the saifsys modules. |
| D6 | **Staff land on the AI chat screen** after signing in, whatever modules they hold. The master still lands on the Overview, as today. | Chats is the one screen every person has. The master's start is left alone until Francis says otherwise. |

## 4. Out of scope

- Roles, groups, or copying one person's modules to another.
- View-only or per-button permissions. What is master-only inside a screen today (creating
  a company, alert rules, renewals, Region) stays master-only; a tick does not widen it.
- Limiting a person to some buildings or some tenants within a module.
- The saifsys modules card and its "Can also do" actions: unchanged, and separate.
- Everything outside the left menu's main places (Shelf, Memory, Email, to-dos, meetings,
  checklists, the Buildings and Inventory screens, who-looked-at-my-workspace): unchanged.

## 5. The modules

| Key | Menu item | Notes |
|-----|-----------|-------|
| `chats` | Chats | Always on. Shown ticked and locked on the profile. |
| `tour` | 3D Navigation | Shows a node only for each module the person holds. |
| `overview` | Overview | |
| `leasing` | Leasing | Leases, the 3D view, the calendar. |
| `tenants` | Tenants | Includes tenant history. |
| `workorders` | Work orders | |
| `reports` | Reports | |
| `alerts` | Alerts | |
| `documents` | Documents | |
| `properties` | Properties | |
| `sources` | Sources | |

Region is not a module. It stays the master's, as it is now.

The list lives in one file on the server (`server/modules.js`) and the menu is drawn from
what the server says the person holds, so a new menu item is added in one place.

## 6. Data model

```sql
CREATE TABLE IF NOT EXISTS module_access (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module  TEXT    NOT NULL,
  PRIMARY KEY (user_id, module)
);
```

One row per person per ticked module, the same shape as `saifsys_access`. `chats` is never
stored: everyone has it. Masters are never stored. The table starts empty, which is D4.

## 7. Server

`server/modules.js` holds:

- `MODULES`: the keys and labels of section 5.
- `userModules(user)`: every key for a master; otherwise `chats` plus the person's rows.
- `listModuleAccess(userId)` and `setModuleAccess(userId, keys)`: for the People screen.
  `set` replaces the whole set and refuses an unknown key, like `setAccess` for saifsys.
- `needs(...keys)`: route middleware. A master passes. Anyone else passes if they hold
  **any** of the keys, and is otherwise answered 403 "Not allowed".

`/api/auth/me` and the sign-in replies carry `modules` beside `role`.

Admin routes (master only, in `server/admin.js`):

- `GET /api/admin/users/:id/modules` → `{ master, modules: [{ key, label, on, locked }] }`
- `PUT /api/admin/users/:id/modules` with `{ modules: [keys] }`

### 7.1 Which module each route needs

Screens share data: the lease form lists tenants, units and sources; Reports filters by
tenant and building; the 3D view draws work orders. So a route names every module whose
screen needs it. Reading is shared where a screen needs it; **changing belongs to the
module that owns the thing**, except where another screen already adds one inline.

| Routes | May read | May change |
|--------|----------|------------|
| `/leasing/overview` | overview, leasing (the 3D view draws from it) | – |
| `/leasing/bookings…`, `/available`, `/installments…`, `/payments…`, `/docs…`, receipts | leasing | leasing |
| `/leasing/units/:id/inspections`, `/inspections…`, inspection photos | leasing, properties | leasing, properties |
| `/leasing/tenants` | tenants, leasing, reports | tenants, leasing (the lease form adds a tenant) |
| `/leasing/tenants/:id/history`, `/leasing/log…` | tenants | tenants |
| `/leasing/services` | leasing, properties | leasing, properties |
| `/leasing/sources` | sources, leasing | sources, leasing (the lease form adds a source) |
| `/leasing/work-orders…` | workorders, leasing (the 3D view marks repairs) | workorders |
| `/leasing/reports/:name` | reports | – |
| `/leasing/alerts…` | alerts, overview | alerts |
| `/leasing/alerts/reminder/:id` | alerts, overview, leasing (a lease's Payments sends it) | alerts, leasing |
| `/leasing/alerts/count` | anyone; counts are zero for kinds whose module they lack | – |
| `/properties/renewals…` | documents | documents (and the master, as today) |
| `/properties/documents…`, `/properties/docs…`, `/properties/places` | documents, properties | documents, properties |
| `/properties/plans`, plan readings | leasing, properties | as today (master) |
| everything else under `/properties` | properties, leasing, reports | properties |
| `/leasing/region` | anyone (money and dates are formatted with it) | as today (master) |
| anything else under `/leasing` | the master only, until it is given a row here | the master only |

One list in `server/modules.js` holds this table, and one piece of middleware mounted at
`/api` applies it, so the whole of it can be read and tested in one place. `needs` of
section 7 is that middleware (`moduleGate`).

The consequences to accept:

- A person with Leasing but not Tenants still sees tenant names in the lease form, because
  a lease cannot be written without one. They do not get the Tenants screen or a tenant's
  history.
- A person with Leasing can be sent the Overview's figures by the server, because the 3D
  view is drawn from the same reading. They do not get the Overview screen.
- 3D Navigation asks only for the figures of modules the person holds; a stop without
  them shows its name and no figure.
- A button that leads into a module the person lacks (Work orders on a lease, Payments in
  a tenant's history) is not shown.

Existing master-only checks stay where they are and are applied after the gate.

### 7.2 Riley

Each tool in `LEASING_TOOLS` is given the module it belongs to (`leasing_report` →
reports, `leasing_work_orders` → workorders, `leasing_add_booking` → leasing, and so on).
`leasingKit(user)` carries only the tools of the modules the person holds, so a question
about a module they lack is one Riley cannot look up, the same rule saifsys modules
follow. `leasing_list` checks the module of the kind it is asked for.

Anything the server sends without being asked goes only to people who hold the module it
is about: a leasing alert needs Alerts, an urgent work order needs Work orders. This
changes today's behaviour for a building's staff, who are buzzed now with no tick at all.

## 8. App

- `App.jsx` keeps `me.modules`. The sidebar's `places` are filtered by it; Region keeps
  its master check.
- If the screen to open is one the person lacks (an old link, a notification, a voice
  command), the app opens Chats instead.
- `Tour3D` draws only the nodes of held modules and asks the server only for their figures.
- Voice control works on what is on the screen, so it follows the menu with no change of
  its own.
- People → a person's profile gets a **Modules** tab beside Agents: one tick per module,
  saved on tap, put back if the save fails. Chats is ticked and locked. For a master it
  reads "The master has every module." and nothing can be tapped.
- A change takes effect on the server at once and in the person's menu the next time the
  app loads.

## 9. Testing

`tests/modules.test.js`, run in `/root/jarvis-dev`:

- nothing ticked → `userModules` is `['chats']`; a master gets every key
- `setModuleAccess` replaces the set, refuses an unknown key, ignores `chats`
- for each row of 7.1: a person without the module gets 403, with it gets through, and a
  reader who is not an owner cannot change
- the lease form's shared reads work with Leasing alone
- `leasingKit` for a person with only Work orders carries the work-order tools and no others
- the admin routes refuse a non-master

Then by hand: a test account with two modules ticked, checked on the menu, by direct
link, by asking Riley, and by Voice control.

# Catering Event Manager — Software Requirements & Design (SDLC)

Version 1.0 · Phase: Requirements → Design → Build → Test (local) → Deploy (later)

---

## 1. Purpose

A simple, reliable booking + reminder + stock tool for a catering business.
The people using it daily are **40–60 years old**, often not computer-savvy, and
the biggest business risk today is **forgetting an event or a detail of it**.

So the order of priority is:

1. **Never lose a booking** (safe storage, soft-delete, backup, audit trail).
2. **Never miss an event** (multi-stage WhatsApp reminders, red warnings 2 days before,
   escalation to the owner when nobody confirms).
3. **Be obvious to use** (big text, icons *with* words, step-by-step booking, no hidden menus).
4. **Know what to buy** (ingredient planning from the menu of each booking).

---

## 2. Users & roles

| Role | Who | Can do |
|---|---|---|
| **Owner (admin)** | 1 person | Everything + manage staff PINs, settings, WhatsApp setup, backups |
| **Staff** | 2–4 people | Create / edit bookings, payments, reminders, stock |
| **Common View** | Anyone (kitchen TV, phone) | *Read-only* board of today / tomorrow / this week. No money, no phone numbers |

Login = pick your name + 4-digit PIN (no usernames / passwords to remember).
Every change is recorded with *who* and *when* (audit log).

---

## 3. Functional requirements

### 3.1 Bookings (events)
- FR-1 Create a booking in **4 guided steps**: Customer → Event (date, time, venue, guests) → Food items → Reminders & payment → Review.
- FR-2 Fields: customer name, phone, alternate phone, address; event name/type, date, optional end date (multi-day weddings), time, “time not fixed yet” flag, venue, map link, guest count, status, total amount, notes, special instructions (allergy, Jain, no onion…), assigned staff, **custom fields** the owner can add without a programmer.
- FR-3 Food items: name (pick from menu or type freely), quantity, unit (plates / kg / litres / pieces), diet (veg / non-veg / Jain / egg), notes.
- FR-4 Edit any booking; **two people editing at the same time is detected** (version check) and the second person is told to reload instead of silently overwriting.
- FR-5 Cancel / restore / delete (soft delete with restore) / duplicate (“Book again”).
- FR-6 List view with search, quick filters, **show/hide columns**, sort, export to Excel (CSV).
- FR-7 Calendar (month) view so double bookings are visible at a glance.
- FR-8 Printable kitchen sheet per event.
- FR-9 Payments: advance + further payments, balance due shown in red near the event.

### 3.2 Reminders (WhatsApp)
- FR-10 Default schedule: **7 days, 2 days (WARNING), 1 day, 4 hours** before the event. Configurable. The 2-day warning can never be switched off.
- FR-11 Reminder recipients per booking: customer (auto-added), plus any people the staff choose (cook, helper, supplier, owner, driver…).
- FR-12 Custom one-off reminder: any person, any date/time, any note.
- FR-13 Booking confirmation message on save; “date/time changed” message when an event is moved.
- FR-14 Retry with back-off on failure; after 5 failures mark **FAILED (red)** and alert the owner.
- FR-15 Within 2 days of the event, the event shows a **red warning** until a staff member presses **“Customer re-confirmed ✓”**. If not pressed within N hours of the warning, the owner gets a WhatsApp alert.
- FR-16 Test mode (default): messages are written to the *Message Outbox* with a one-tap **“Open in WhatsApp”** button, so the system can be used before the WhatsApp Business API is connected.
- FR-17 Providers: Meta WhatsApp Cloud API or Twilio, selected in Settings; credentials stay in `config.env`, never in the database.

### 3.3 Stock / inventory
- FR-18 Ingredients with unit, cost, lead time, shelf life.
- FR-19 Recipes: ingredient quantity **per plate** for each menu item.
- FR-20 Receive stock in batches with expiry dates; adjust / write off.
- FR-21 Shopping plan for upcoming bookings with **“order by” dates**.
- FR-22 Issue stock to an event (once only).
- FR-23 Low-stock, out-of-stock and expiring-soon alerts.

### 3.4 Common view
- FR-24 Big-screen board: Today / Tomorrow / Next 7 days, auto-refresh every minute, red banners for events in ≤2 days.

### 3.5 Admin
- FR-25 Staff management (add, change PIN, deactivate).
- FR-26 Settings: business name, phones, reminder schedule, quiet hours, capacity per day, wastage %, stock parameters.
- FR-27 One-click database backup download; Excel export.

---

## 4. Edge cases analysed (and how the system handles them)

| # | Situation in real catering life | Handling |
|---|---|---|
| E1 | Booking taken **less than 2 days** before the event | Missed reminders are not all fired at once; only the most urgent one is sent immediately (“catch-up collapse”), others are marked *skipped*. |
| E2 | **Computer was switched off** when a reminder was due | On start-up the scheduler catches up using the same collapse rule; reminders for events already over are marked *expired*, never sent late. |
| E3 | Reminder due at **night (11 pm / 3 am)** | Quiet hours (21:00–07:00 default). Reminders are moved **earlier** to 20:30, never later, so they always arrive before the event. |
| E4 | Event **postponed / time changed** | All reminders are re-planned for the new time (including ones already sent for the old date), and a “date changed” message goes to everyone on the list. |
| E5 | Event **cancelled** | All pending reminders cancelled instantly; restoring the booking re-arms them. |
| E6 | **Time not fixed yet** (“evening, will confirm”) | Allowed. Event shows a *Time not fixed* flag, reminders are planned on 12:00 and the 2-day message asks the customer to confirm the time. |
| E7 | **Same customer books again** | Customer is found by phone number and reused; history is visible. |
| E8 | Phone typed as `098xxxxxxx`, `+91 98xxx xxxxx`, `98xxx-xxxxx` | Normalised to international format `+9198…`; invalid numbers rejected with a plain-language message. |
| E9 | **Two staff edit the same booking** at once | Version check → second save is refused with “Someone else changed this booking; reload”. |
| E10 | **Double booking / too many events on one day** | Warning while choosing the date, showing the other bookings that day and the daily capacity. |
| E11 | **Multi-day events** (wedding 2–3 days) | Optional end date; reminders are based on the first day. |
| E12 | **Guest count changes** at the last minute | One button “Set plates = guests” rescales plate items; stock plan updates automatically. |
| E13 | Menu item not in the menu list (special dish) | Free text allowed; it is flagged *“no recipe – not in stock plan”* so nobody assumes it was planned. |
| E14 | WhatsApp **delivery fails** (wrong number, no internet, API down) | Retry after 5, 15, 45, 120 min; then FAILED → red on dashboard + owner alert + “Open in WhatsApp” manual button. |
| E15 | Two schedulers / “Send now” clicked while scheduler is sending | Each reminder is *claimed* atomically before sending, so it can never be sent twice. |
| E16 | Server crash in the middle of sending | Claims older than 10 minutes are released and retried. |
| E17 | **Accidental delete** | Soft delete; “Deleted” filter + Restore button; audit log keeps who did it. |
| E18 | Stock issued twice for one event | Blocked (`stock_issued` flag). |
| E19 | Ingredient will **expire before the event** | Not counted as available in the plan (expiry-aware FEFO simulation). |
| E20 | Advance paid but **balance still due** close to the event | Red flag “Balance due” within 2 days. |
| E21 | Event date already passed but still “confirmed” | Shown under “Needs closing” so the booking is marked completed (and stock issued). |
| E22 | Booking entered for a **past date** (recording old data) | Allowed only after an explicit confirmation. |
| E23 | Enquiry (date held, not confirmed) | Status *Enquiry*: shown on calendar in grey, no customer reminders until confirmed. |
| E24 | Allergy / Jain / no-onion-garlic instructions | Separate “special instructions” field printed in bold on the kitchen sheet and included in staff reminders. |

---

## 5. Reminder algorithm (design)

```
on booking save / edit / status change  →  sync_event_reminders(event)
every 60 seconds (background thread)     →  sync all upcoming events
                                            process_due()
                                            check_escalations()
```

**sync_event_reminders** — idempotent planner. For every *(recipient × offset)* it computes
`due = start − offset`, shifts it out of quiet hours (always earlier), and upserts a row keyed
by `(event, kind, phone)`. Rows that were planned for an *old* start time are re-armed;
rows no longer needed are cancelled. Then **catch-up collapse**: of the overdue rows for one
recipient only the one closest to the event is kept, the rest are *skipped*.

**process_due** — selects due rows, *atomically claims* each one
(`UPDATE … SET status='sending' WHERE status IN ('pending','retry')`), builds the message
**at send time** (so last-minute menu edits are included), sends, and records the outbox entry.
Failure → exponential back-off (5 → 15 → 45 → 120 min) → FAILED after 5 attempts → owner alert.
During quiet hours only urgent messages (event < 10 h away) are sent.

**check_escalations** — if an event is ≤ 48 h away, the 2-day warning was sent more than
`ack_hours` ago and nobody pressed *Customer re-confirmed*, the owner receives one alert.

---

## 6. Inventory algorithms (design)

Catering demand is *dependent demand* (driven by bookings), with a small *independent*
baseline (staples, daily usage). The system therefore combines:

1. **MRP / Bill-of-Materials explosion** — each booking’s menu × recipe-per-plate × (1 + wastage %) gives the exact ingredient requirement.
2. **Time-phased, expiry-aware netting (FEFO simulation)** — bookings are processed in date order; for each one only batches that will still be fresh on that date are consumed, earliest-expiry first. The result is the shortage per booking and the **order-by date = event date − supplier lead time**.
3. **Reorder Point with safety stock** for baseline usage: `ROP = d̄·L + Z·σ·√L` (Z from the service level, default 95 %).
4. **Simple Exponential Smoothing** (α = 0.3) to forecast daily usage from history.
5. **EOQ** (Economic Order Quantity) `√(2·D·S / H)` to suggest how much to buy.
6. **ABC (Pareto) classification** by annual consumption value — A items (≈80 % of spend) deserve the closest watching.
7. **FEFO issue** — stock is always taken from the batch that expires first.

---

## 7. Non-functional requirements

- **Usability**: base font 19 px, buttons ≥ 52 px tall, every icon has a text label, colour is never the only signal (red items also say “WARNING”), confirmation dialogs for destructive actions, success messages after saving.
- **Reliability**: SQLite with WAL journaling, soft deletes, atomic reminder claims, backup download.
- **Security**: PIN hashed (PBKDF2), session cookies, owner-only settings, secrets in `config.env`, all output HTML-escaped.
- **Portability**: Python 3.10+ and Flask only. Runs on any Windows PC (`start.bat`). Moves to a server/cloud later without code changes.

## 8. Architecture

```
Browser (admin SPA  /  common board)
        │  JSON over HTTP
Flask app (app.py)  ── catering/api.py      REST endpoints, auth, validation, audit
                    ├─ catering/reminders.py  planner, sender loop, escalation, messages
                    ├─ catering/inventory.py  MRP, FEFO, ROP, EOQ, ABC, SES
                    ├─ catering/whatsapp.py   Test / Meta Cloud API / Twilio adapters
                    ├─ catering/scheduler.py  background thread (every 60 s)
                    └─ catering/db.py         schema, settings, seed
SQLite file: data/catering.db
```

## 9. Test plan
`python -m unittest discover tests` covers: phone normalisation, reminder planning,
quiet hours, catch-up collapse, re-planning on date change, cancellation, retry/back-off,
failure escalation, no double send, MRP netting with expiry, FEFO issue, ROP/EOQ/ABC,
API create/edit/conflict/soft-delete, and the read-only board.

## 10. Roadmap (next phases)
- Connect WhatsApp Business (Meta Cloud API) with approved message templates.
- Two-way WhatsApp: customer replies “YES” → auto re-confirmation.
- Quotation / invoice PDF, GST.
- Hosting on a small cloud server so staff phones can use it from anywhere.

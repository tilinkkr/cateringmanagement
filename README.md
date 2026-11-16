# Catering Manager

Bookings, calendar, customers, food items and WhatsApp reminders for a catering business.
Mobile-first, large text, for staff aged 40–60. The app runs fully in the browser and
saves to the device's **local storage**, so it can be hosted on **Vercel** as a static site.

> **Important:** local storage keeps data on *one* phone/computer only. Staff on different
> devices will not see each other's bookings. Use **Settings → Download / Restore backup** to move data.
> For shared data across devices, a cloud database (e.g. Supabase) is the next step.

## Try it on this computer

Double-click **`start.bat`** (opens http://localhost:5500), or:

```bash
python -m http.server 5500 --directory web
```

The first visit asks you to create the owner account (phone + password).
The owner adds staff logins in **Settings → Team logins**.

## Deploy to Vercel

1. Push this folder to GitHub and import it in Vercel.
2. Keep the default settings (Root Directory = the repo root). `vercel.json` serves the `web` folder; no build step.
3. Deploy. That's it.

### WhatsApp (later)
The WhatsApp page has two buttons: **Add numbers** (owner/staff/cook who get alerts) and **Send notifications**.
Until an account is connected, *Send notifications* opens WhatsApp with each message ready — one tap each.

To send automatically, add these Environment Variables in Vercel, redeploy, and type the same
`WA_APP_KEY` in the app under **Settings → Automatic WhatsApp**:
`WA_TOKEN`, `WA_PHONE_ID`, `WA_APP_KEY` (and optionally `WA_TEMPLATE`, `WA_TEMPLATE_LANG`).
The function is `api/send-whatsapp.js` (Meta WhatsApp Cloud API).

### What gets sent
- Customer: booking confirmation, 2 days before, 1 day before, and a notice if date/time changes.
- Team numbers: 2-day warning and an event-day morning message for every booking.
- Owners: an alert if an event is less than 24 h away and nobody pressed **Re-confirmed**.
- No messages 21:00–07:00 (moved earlier); late bookings send only the most urgent missed reminder.
- Example bookings are never messaged.

### Money and phone numbers
- Money is in **Australian dollars (A$)**; Settings → Currency holds the A$→₹ rate (with a “Get today’s rate” button).
- Phone numbers default to **Australia (+61)** — type `0412 345 678`; switch to India (+91) in Settings → Business.

## Tests
```bash
node web/tests/store.test.js
```

## Files
```
web/index.html          the app
web/css/app.css         styles (mobile first)
web/js/store.js         local storage data + reminder engine
web/js/app.js           login, home, bookings, booking form
web/js/pages.js         calendar, customers, food items, WhatsApp, settings
api/send-whatsapp.js      Vercel function for automatic WhatsApp (optional)
```
The older Python/SQLite version (`legacy-python/`) is kept for reference and is not used by the web app.

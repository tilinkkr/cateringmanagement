'use strict';
/* Data layer (browser localStorage) + WhatsApp reminder engine.
   Everything is saved on THIS device. Use Settings > Backup to move data between devices. */
(function (root) {
  const KEY = 'catering.v2';
  const DAY = 86400000, HOUR = 3600000;
  const DEFAULT_RATE = 63.99, DEFAULT_RATE_DATE = '2026-11-16';   // 1 AUD = 63.99 INR (rate on 16 Nov 2026)

  /* ---------- small utils */
  const pad = n => String(n).padStart(2, '0');
  const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const toISO = d => `${isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const parseD = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
  const parseDT = s => { const d = parseD(s); const t = s.slice(11, 16); if (t) { const [h, m] = t.split(':').map(Number); d.setHours(h, m, 0, 0); } return d; };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const hm = s => { const [h, m] = (s || '0:0').split(':').map(Number); return h * 60 + m; };

  function normPhone(raw, cc = '61') {
    let d = String(raw || '').replace(/\D/g, '');
    if (!d) throw new Error('Phone number is required');
    if (d.startsWith('00')) d = d.slice(2);
    else if (d.startsWith('0')) d = d.slice(1);           // local trunk 0 (India 0987…, Australia 04…)
    if (d.length === 9 || d.length === 10) d = cc + d;    // local number -> add country code
    if (d.length < 11 || d.length > 15) throw new Error(`“${raw}” is not a valid phone number`);
    return '+' + d;
  }

  async function hashPass(phone, pass) {
    const txt = `cm|${phone}|${pass}`;
    if (root.crypto && root.crypto.subtle) {
      const buf = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    let h = 5381; for (const c of txt) h = ((h << 5) + h + c.charCodeAt(0)) | 0; return 'x' + (h >>> 0).toString(16);
  }

  /* ---------- storage */
  function emptyDB() {
    return {
      version: 2,
      business: { name: '', phone: '' },
      settings: { quietStart: '21:00', quietEnd: '07:00', cc: '61', ccSet: true, waKey: '', currency: 'AUD', inrPerAud: DEFAULT_RATE, rateDate: DEFAULT_RATE_DATE },
      users: [], customers: [], bookings: [], items: [], waNumbers: [], notes: [], activity: [],
    };
  }
  let db = null;
  function load() {
    try { db = JSON.parse(root.localStorage.getItem(KEY) || 'null'); } catch (e) { db = null; }
    if (!db || db.version !== 2) db = emptyDB();
    migrateToAUD();
    if (!db.settings.ccSet) { db.settings.cc = '61'; db.settings.ccSet = true; try { root.localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* */ } }
    return db;
  }
  /** Older data was in Indian rupees: convert every amount once to Australian dollars. */
  function migrateToAUD() {
    if (db.settings.currency === 'AUD') return;
    const r = db.settings.inrPerAud || DEFAULT_RATE;
    const cv = v => Math.round((+v || 0) / r * 100) / 100;
    db.items.forEach(i => { i.price = cv(i.price); });
    db.bookings.forEach(b => { b.total = cv(b.total); (b.payments || []).forEach(p => { p.amount = cv(p.amount); }); });
    Object.assign(db.settings, { currency: 'AUD', inrPerAud: r, rateDate: db.settings.rateDate || DEFAULT_RATE_DATE });
    try { root.localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* ignore */ }
  }
  function save() {
    try { root.localStorage.setItem(KEY, JSON.stringify(db)); }
    catch (e) { throw new Error('Could not save — the storage on this device is full. Please download a backup and remove old data.'); }
  }
  function replaceAll(data) {
    if (!data || data.version !== 2 || !Array.isArray(data.bookings)) throw new Error('This is not a valid backup file');
    db = data; save();
  }
  function log(by, text, bookingId) {
    db.activity.unshift({ at: toISO(new Date()), by, text, bookingId: bookingId || null });
    db.activity = db.activity.slice(0, 300);
  }

  /* ---------- bookings helpers */
  function bookingStart(b) {
    const d = parseD(b.date);
    const [h, m] = (b.time || '12:00').split(':').map(Number);
    d.setHours(h, m, 0, 0);
    return d;
  }
  const daysLeft = (b, now = new Date()) => Math.round((parseD(b.date) - parseD(isoDate(now))) / DAY);
  const paid = b => (b.payments || []).reduce((s, p) => s + (+p.amount || 0), 0);
  const balance = b => Math.max(0, (+b.total || 0) - paid(b));
  function urgency(b, now = new Date()) {
    if (b.deletedAt) return 'deleted';
    if (b.status === 'cancelled') return 'cancelled';
    if (b.status === 'completed') return 'done';
    const dl = daysLeft(b, now);
    if (dl < 0) return 'over';
    return dl <= 2 ? 'red' : dl <= 7 ? 'amber' : 'green';
  }
  /** Things a person must act on, most urgent first. */
  function attention(b, now = new Date()) {
    const u = urgency(b, now), out = [];
    if (['deleted', 'cancelled', 'done'].includes(u)) return out;
    const dl = daysLeft(b, now);
    if (u === 'over') { out.push({ code: 'close', text: 'Event over — mark completed', level: 'amber' }); return out; }
    if (b.status === 'enquiry' && dl <= 7) out.push({ code: 'enquiry', text: 'Enquiry — confirm or cancel', level: dl <= 2 ? 'red' : 'amber' });
    if (b.status === 'confirmed' && dl <= 2 && !b.reconfirmedAt) out.push({ code: 'reconfirm', text: 'Call customer & re-confirm', level: 'red' });
    if (!b.time && dl <= 7) out.push({ code: 'time', text: 'Time not fixed', level: dl <= 2 ? 'red' : 'amber' });
    if (!(b.items || []).length && dl <= 7) out.push({ code: 'items', text: 'No food items', level: 'amber' });
    if (balance(b) > 0 && dl <= 2) out.push({ code: 'balance', text: 'Balance payment due', level: 'red' });
    return out;
  }

  /* ---------- reminder engine (pure functions of db + now) */
  function inQuiet(dt, s) {
    const qs = hm(s.quietStart), qe = hm(s.quietEnd);
    if (qs === qe) return false;
    const t = dt.getHours() * 60 + dt.getMinutes();
    return qs > qe ? (t >= qs || t < qe) : (qs <= t && t < qe);
  }
  /** Night-time reminders move EARLIER (30 min before quiet start), never later. */
  function shiftQuiet(dt, s) {
    if (!inQuiet(dt, s)) return dt;
    const qs = hm(s.quietStart), qe = hm(s.quietEnd);
    const day = new Date(dt);
    const t = dt.getHours() * 60 + dt.getMinutes();
    if (qs > qe && t < qe) day.setDate(day.getDate() - 1);
    day.setHours(0, qs - 30, 0, 0);
    return day;
  }
  const AUTO_KINDS = ['c2d', 'c1d', 't2d', 'tday'];
  const KIND_LABEL = {
    confirm: 'Booking confirmed', c2d: '2 days before', c1d: '1 day before', t2d: '2-day warning to team',
    tday: 'Morning of event to team', unconfirmed: 'Alert: not re-confirmed', changed: 'Date / time changed',
  };

  function desiredFor(b, s) {
    if (b.sample || b.deletedAt || b.status !== 'confirmed') return [];
    const start = bookingStart(b), sk = toISO(start), out = [];
    const cust = db.customers.find(c => c.id === b.customerId);
    const add = (kind, to, name, role, due) => out.push({
      key: `${b.id}|${kind}|${to}|${sk}`, bookingId: b.id, kind, to, name, role, due: toISO(shiftQuiet(new Date(due), s)), start: sk,
    });
    if (b.remindCustomer !== false && cust) {
      add('c2d', cust.phone, cust.name, 'customer', start - 2 * DAY);
      add('c1d', cust.phone, cust.name, 'customer', start - DAY);
    }
    const morning = parseD(b.date); morning.setHours(7, 0, 0, 0);
    db.waNumbers.forEach(t => {
      add('t2d', t.phone, t.name, t.role, start - 2 * DAY);
      add('tday', t.phone, t.name, t.role, Math.min(+morning, +start - 3 * HOUR));
    });
    return out;
  }

  function queueOneOff(b, kind, now = new Date()) {
    if (b.sample) return;
    const cust = db.customers.find(c => c.id === b.customerId);
    const targets = [];
    if ((kind === 'confirm' || kind === 'changed') && cust && b.remindCustomer !== false) targets.push([cust.phone, cust.name, 'customer']);
    if (kind === 'changed') db.waNumbers.forEach(t => targets.push([t.phone, t.name, t.role]));
    targets.forEach(([to, name, role]) => db.notes.push({
      id: uid(), key: `${b.id}|${kind}|${to}|${toISO(now)}`, bookingId: b.id, kind, to, name, role,
      due: toISO(now), start: toISO(bookingStart(b)), status: 'pending',
    }));
  }

  function sync(now = new Date()) {
    const s = db.settings;
    const byId = Object.fromEntries(db.bookings.map(b => [b.id, b]));
    const desired = new Map();
    db.bookings.forEach(b => { if (bookingStart(b) > now) desiredFor(b, s).forEach(d => desired.set(d.key, d)); });
    const have = new Set(db.notes.map(n => n.key));
    // drop planned reminders that no longer apply (cancelled, moved, number removed)
    db.notes = db.notes.filter(n => !(n.status === 'pending' && AUTO_KINDS.includes(n.kind) && !desired.has(n.key)));
    desired.forEach((d, k) => { if (!have.has(k)) db.notes.push({ id: uid(), ...d, status: 'pending' }); });
    db.notes.forEach(n => {
      const b = byId[n.bookingId];
      if (n.status !== 'pending') return;
      if (!b || b.deletedAt || b.status === 'cancelled') { n.status = 'cancelled'; return; }
      if (bookingStart(b) <= now) n.status = 'expired';
    });
    // late booking / device was off: per person, only the latest overdue reminder is sent
    const groups = {};
    db.notes.filter(n => n.status === 'pending' && AUTO_KINDS.includes(n.kind) && parseDT(n.due) <= now)
      .forEach(n => (groups[n.bookingId + n.to] = groups[n.bookingId + n.to] || []).push(n));
    Object.values(groups).forEach(g => { g.sort((a, b) => a.due < b.due ? 1 : -1); g.slice(1).forEach(n => { n.status = 'skipped'; }); });
    // owner alert: within 24h and not re-confirmed
    db.bookings.forEach(b => {
      const st = bookingStart(b);
      if (b.sample || b.deletedAt || b.status !== 'confirmed' || b.reconfirmedAt || st <= now || st - now > 24 * HOUR) return;
      db.waNumbers.filter(t => t.role === 'owner').forEach(t => {
        const key = `${b.id}|unconfirmed|${t.phone}|${toISO(st)}`;
        if (!db.notes.some(n => n.key === key)) db.notes.push({ id: uid(), key, bookingId: b.id, kind: 'unconfirmed', to: t.phone, name: t.name, role: t.role, due: toISO(now), start: toISO(st), status: 'pending' });
      });
    });
    const cutoff = toISO(new Date(+now - 60 * DAY));
    db.notes = db.notes.filter(n => n.status === 'pending' || (n.sentAt || n.due) >= cutoff);
  }

  /** Messages that should go out now. During quiet hours only urgent ones (event < 10 h away). */
  function dueNotes(now = new Date()) {
    const quiet = inQuiet(now, db.settings);
    return db.notes.filter(n => {
      if (n.status !== 'pending' || parseDT(n.due) > now) return false;
      return !quiet || parseDT(n.start) - now < 10 * HOUR;
    }).sort((a, b) => (a.due < b.due ? -1 : 1));
  }

  /* ---------- messages */
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const fmtDate = s => { const d = parseD(s); return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
  const fmtTime = t => { if (!t) return ''; let [h, m] = t.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; return `${h % 12 || 12}:${pad(m)} ${ap}`; };

  function buildMessage(n) {
    const b = db.bookings.find(x => x.id === n.bookingId);
    if (!b) return '';
    const cust = db.customers.find(c => c.id === b.customerId) || {};
    const biz = db.business.name || 'Catering';
    const team = n.role !== 'customer';
    const head = {
      confirm: '✅ Your booking is CONFIRMED. Thank you!',
      c2d: '⚠️ Reminder: your event is in 2 DAYS.',
      c1d: '⏰ Reminder: your event is TOMORROW.',
      t2d: '⚠️ 2 DAYS TO GO — please get ready.',
      tday: '📋 EVENT TODAY.',
      unconfirmed: `🚨 NOT yet re-confirmed with the customer. Please call ${cust.name} (${cust.phone}).`,
      changed: '📢 Booking details have CHANGED. New details below.',
    }[n.kind] || 'Reminder';
    const L = [`*${biz}*`, `Hello ${n.name},`, head, '', `🎉 *${b.title}*`, `📅 ${fmtDate(b.date)}`,
      `⏰ ${b.time ? fmtTime(b.time) : 'Time not fixed yet — please confirm'}`];
    if (b.venue) L.push(`📍 ${b.venue}`);
    L.push(`👥 ${b.guests || 0} guests`);
    if ((b.items || []).length) { L.push('🍛 Menu:'); b.items.forEach(i => L.push(`  • ${i.name} — ${i.qty} ${i.unit || 'plates'}`)); }
    if (team) {
      L.push(`👤 Customer: ${cust.name || ''} ${cust.phone || ''}`);
      if (b.special) L.push(`⚠️ Special: ${b.special}`);
    } else if (['c2d', 'c1d'].includes(n.kind)) {
      L.push('', 'Please reply *YES* to confirm, or call us if anything has changed.');
    }
    if (db.business.phone) L.push(`📞 ${biz}: ${db.business.phone}`);
    return L.join('\n');
  }
  const waLink = (to, text) => `https://wa.me/${String(to).replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;

  function markSent(id, how) {
    const n = db.notes.find(x => x.id === id);
    if (!n) return;
    n.status = 'sent'; n.sentAt = toISO(new Date()); n.via = how; n.text = buildMessage(n);
  }

  /* ---------- seed */
  const SAMPLE_ITEMS = [
    ['Veg Biryani', 'Main course', 'veg', 14], ['Chicken Biryani', 'Main course', 'non-veg', 18], ['Mutton Biryani', 'Main course', 'non-veg', 24],
    ['Ghee Rice', 'Main course', 'veg', 8], ['Plain Rice', 'Main course', 'veg', 4], ['Chapati', 'Bread', 'veg', 2], ['Porotta', 'Bread', 'veg', 3],
    ['Paneer Butter Masala', 'Curry', 'veg', 12], ['Chicken Curry', 'Curry', 'non-veg', 14], ['Dal Tadka', 'Curry', 'veg', 8],
    ['Sambar', 'Curry', 'veg', 5], ['Rasam', 'Curry', 'veg', 4], ['Avial', 'Curry', 'veg', 7], ['Chilli Chicken', 'Starter', 'non-veg', 14],
    ['Gobi Manchurian', 'Starter', 'veg', 11], ['Salad', 'Side', 'veg', 4], ['Pappadam', 'Side', 'veg', 1], ['Pickle', 'Side', 'veg', 1],
    ['Payasam', 'Dessert', 'veg', 6], ['Gulab Jamun', 'Dessert', 'veg', 5], ['Ice Cream', 'Dessert', 'veg', 5],
    ['Fresh Lime Juice', 'Drinks', 'veg', 4], ['Water Bottle', 'Drinks', 'veg', 2],
  ];
  function seedItems() {
    if (db.items.length) return;
    db.items = SAMPLE_ITEMS.map(([name, category, diet, price]) => ({ id: uid(), name, category, diet, price, active: true }));
  }
  function seedSamples(by) {
    const t = new Date();
    const it = n => db.items.find(i => i.name === n);
    const samples = [
      ['Ramesh Kumar', '9876500001', 'Wedding Reception', 'Wedding', 1, '19:30', 250, 'Lakshmi Hall, MG Road', [['Chicken Biryani', 150], ['Veg Biryani', 100], ['Payasam', 250]], 9500, 3000],
      ['Priya Nair', '9876500002', 'Birthday Party', 'Birthday', 2, '', 60, 'Home, 12 Park Street', [['Veg Biryani', 60], ['Gulab Jamun', 60]], 1500, 500],
      ['Joseph Mathew', '9876500003', 'House Warming Lunch', 'House Warming', 6, '12:30', 120, 'Kakkanad', [['Plain Rice', 120], ['Sambar', 120], ['Avial', 120], ['Payasam', 120]], 2400, 1000],
      ['Anitha S', '9876500004', 'Office Annual Day', 'Corporate', 15, '13:00', 300, 'Infopark Hall 2', [['Veg Biryani', 300], ['Paneer Butter Masala', 300]], 7000, 2000],
    ];
    samples.forEach(([cn, ph, title, type, dd, time, guests, venue, items, total, adv]) => {
      const c = { id: uid(), name: cn + ' (sample)', phone: '+91' + ph, address: '', notes: '', sample: true, createdAt: toISO(t) };
      db.customers.push(c);
      const date = new Date(t); date.setDate(date.getDate() + dd);
      db.bookings.push({
        id: uid(), customerId: c.id, title, type, date: isoDate(date), time, venue, guests, status: 'confirmed',
        items: items.map(([n, q]) => ({ itemId: it(n)?.id, name: n, qty: q, unit: 'plates' })), total,
        payments: [{ id: uid(), amount: adv, date: isoDate(t), mode: 'Cash' }], notes: '', special: '',
        remindCustomer: true, sample: true, createdAt: toISO(t), createdBy: by, updatedAt: toISO(t), updatedBy: by,
      });
    });
  }

  const api = {
    KEY, load, save, replaceAll, get db() { return db; }, log, uid, pad, isoDate, toISO, parseD, parseDT, normPhone, hashPass,
    bookingStart, daysLeft, paid, balance, urgency, attention, inQuiet, shiftQuiet, desiredFor, queueOneOff, sync, dueNotes,
    DEFAULT_RATE, buildMessage, waLink, markSent, seedItems, seedSamples, fmtDate, fmtTime, MONTHS, DAYS, KIND_LABEL, emptyDB,
    _setDB(d) { db = d; },
  };
  root.Store = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

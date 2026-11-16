'use strict';
/* Core: helpers, API, login, shell, router, dashboard, booking list, calendar.
   Booking wizard + detail are in booking.js; stock/menu/customers/settings in admin.js */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseD = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const parseDT = s => { const d = parseD(s); const [h, mi] = (s.slice(11, 16) || '00:00').split(':').map(Number); d.setHours(h, mi, 0, 0); return d; };
const qty = n => Math.round((+n || 0) * 100) / 100;
const todayISO = () => isoDate(new Date());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const S = { me: null, cfg: null, menu: [], dirty: false, timers: [] };

class ApiErr extends Error { constructor(m, s, b) { super(m); this.status = s; this.body = b || {}; } }

async function api(method, url, data) {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (data !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(data); }
  let res;
  try { res = await fetch(url, opt); }
  catch (e) { throw new ApiErr('Cannot reach the program. Please check that it is still running on the computer.', 0); }
  let body = null;
  try { body = await res.json(); } catch (e) { /* not json */ }
  if (res.status === 401 && !url.endsWith('/login')) { S.me = null; renderLogin(); throw new ApiErr(body?.error || 'Please log in again', 401); }
  if (!res.ok) throw new ApiErr(body?.error || `Something went wrong (${res.status})`, res.status, body);
  return body;
}

/* ---------- formatting */
function money(n) {
  const cur = S.me?.currency || '₹';
  return cur + ' ' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
function fmtDate(s) { if (!s) return ''; const d = parseD(s); return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
function fmtDateShort(s) { if (!s) return ''; const d = parseD(s); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
function fmtTime(hhmm) {
  if (!hhmm) return '';
  let [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${h}:${pad(m)} ${ap}`;
}
function fmtDT(s) { return s ? `${fmtDateShort(s)}, ${fmtTime(s.slice(11, 16))}` : ''; }
function relTime(s) {
  if (!s) return '';
  const diff = (parseDT(s) - new Date()) / 60000;
  const a = Math.abs(diff);
  let t;
  if (a < 1) return 'now';
  if (a < 60) t = `${Math.round(a)} min`;
  else if (a < 60 * 36) t = `${Math.round(a / 60)} hours`;
  else t = `${Math.round(a / 1440)} days`;
  return diff > 0 ? `in ${t}` : `${t} ago`;
}
function countdownText(e) {
  const d = e.days_left;
  if (e.urgency === 'needs_close') return 'Over';
  if (d === 0) return 'TODAY';
  if (d === 1) return 'TOMORROW';
  if (d < 0) return `${-d} days ago`;
  return `In ${d} days`;
}
function countdown(e) {
  const cls = { red: 'red', amber: 'amber', green: 'green' }[e.urgency] || 'grey';
  const warn = e.urgency === 'red' ? icon('alert', 18) + ' ' : '';
  return `<span class="countdown ${cls}">${warn}${countdownText(e)}</span>`;
}
const STATUS = {
  confirmed: ['Confirmed', 'b-green'], enquiry: ['Enquiry', 'b-blue'], completed: ['Completed', 'b-grey'],
  cancelled: ['Cancelled', 'b-grey'],
};
function statusBadge(e) {
  if (e.deleted_at) return '<span class="badge b-red">Deleted</span>';
  const [t, c] = STATUS[e.status] || [e.status, 'b-grey'];
  return `<span class="badge ${c}">${t}</span>`;
}
function flagBadges(flags) {
  return (flags || []).map(f => `<span class="badge b-${f.level === 'red' ? 'red' : 'amber'}">${icon('alert', 16)} ${esc(f.text)}</span>`).join('');
}

/* ---------- toast, modal, confirm */
function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(type === 'err' ? 'alert' : 'check')} <span>${esc(msg)}</span>`;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'err' ? 6000 : 3200);
}
function showError(e) { toast(e.message || String(e), 'err'); }

function openModal(html, { wide = false, onClose } = {}) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('mousedown', ev => { if (ev.target === ov) close(); });
  $$('[data-close]', ov).forEach(b => b.addEventListener('click', close));
  const first = $('input, select, textarea', ov);
  if (first) setTimeout(() => first.focus(), 30);
  return { el: ov, close };
}

function confirmBox({ title, text, ok = 'Yes', cancel = 'No, go back', danger = false }) {
  return new Promise(resolve => {
    let done = false;
    const m = openModal(`
      <h2>${icon(danger ? 'alert' : 'info')} ${esc(title)}</h2>
      <p style="font-size:1.05rem">${text}</p>
      <div class="modal-foot">
        <button class="btn big" data-no>${icon('left')} ${esc(cancel)}</button>
        <button class="btn big ${danger ? 'solid-danger' : 'primary'}" data-yes>${icon('check')} ${esc(ok)}</button>
      </div>`, { onClose: () => { if (!done) resolve(false); } });
    $('[data-no]', m.el).onclick = () => { done = true; m.close(); resolve(false); };
    $('[data-yes]', m.el).onclick = () => { done = true; m.close(); resolve(true); };
    setTimeout(() => $('[data-yes]', m.el).focus(), 40);
  });
}

function formData(root) {
  const o = {};
  $$('[name]', root).forEach(el => {
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
    else o[el.name] = el.value.trim();
  });
  return o;
}

async function withBusy(btn, fn) {
  if (btn) { btn.disabled = true; btn.dataset.label = btn.innerHTML; btn.innerHTML = 'Please wait…'; }
  try { return await fn(); }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset.label; } }
}

/* ---------- login */
async function renderLogin() {
  clearTimers();
  let info = { staff: [], business_name: 'Catering' };
  try { info = await api('GET', '/api/staff/public'); } catch (e) { showError(e); }
  let chosen = info.staff.length === 1 ? info.staff[0].id : null;
  $('#app').innerHTML = `
    <div class="login-wrap">
      <div class="login">
        <div class="brand" style="color:var(--primary-dark);font-size:1.4rem;margin-bottom:1rem">
          <span class="logo">${icon('utensils', 26)}</span> ${esc(info.business_name)}
        </div>
        <h2>1. Tap your name</h2>
        <div class="who-grid">
          ${info.staff.map(s => `<button class="who-btn ${s.id === chosen ? 'on' : ''}" data-id="${s.id}">
              ${icon('user', 30)} ${esc(s.name)} ${s.role === 'admin' ? '<span class="small muted">Owner</span>' : ''}</button>`).join('')}
        </div>
        <h2>2. Type your PIN</h2>
        <input id="pin" class="pin-input" type="password" inputmode="numeric" maxlength="6" autocomplete="off" aria-label="PIN">
        <div class="keypad">
          ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button class="btn" data-k="${n}">${n}</button>`).join('')}
          <button class="btn" data-k="del">${icon('left')}</button><button class="btn" data-k="0">0</button>
          <button class="btn primary" data-k="go">${icon('right')}</button>
        </div>
        <button class="btn primary big block" id="loginBtn" style="margin-top:1rem">${icon('lock')} Log in</button>
        <p class="center muted small" style="text-align:center;margin-top:1rem">
          <a href="/board" target="_blank">${icon('monitor', 18)} Open the Common View (no login needed)</a></p>
      </div>
    </div>`;
  const pin = $('#pin');
  $$('.who-btn').forEach(b => b.onclick = () => {
    chosen = +b.dataset.id; $$('.who-btn').forEach(x => x.classList.toggle('on', x === b)); pin.focus();
  });
  const go = async () => {
    if (!chosen) return toast('Please tap your name first', 'err');
    if (pin.value.length < 4) return toast('PIN has at least 4 numbers', 'err');
    try {
      await api('POST', '/api/login', { staff_id: chosen, pin: pin.value });
      await boot();
    } catch (e) { pin.value = ''; showError(e); }
  };
  $$('.keypad button').forEach(b => b.onclick = () => {
    const k = b.dataset.k;
    if (k === 'del') pin.value = pin.value.slice(0, -1);
    else if (k === 'go') go();
    else if (pin.value.length < 6) pin.value += k;
  });
  pin.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  $('#loginBtn').onclick = go;
  pin.focus();
}

/* ---------- shell */
const NAV = [
  ['#/', 'home', 'Today'],
  ['#/events/new', 'plus', 'New Booking', 'cta'],
  ['#/events', 'list', 'All Bookings'],
  ['#/calendar', 'calendar', 'Calendar'],
  ['#/reminders', 'bell', 'Reminders', '', 'remCount'],
  ['#/stock', 'box', 'Stock & Shopping', '', 'stockCount'],
  ['#/menu', 'utensils', 'Menu & Recipes'],
  ['#/customers', 'users', 'Customers'],
  ['#/outbox', 'inbox', 'Message Outbox'],
  ['#/settings', 'settings', 'Settings'],
];

function renderShell() {
  $('#app').innerHTML = `
    <header class="topbar">
      <div class="brand"><span class="logo">${icon('utensils', 24)}</span><span>${esc(S.me.business_name)}</span></div>
      <div class="clock"><b id="clockTime"></b><span id="clockDate"></span></div>
      <div class="who">
        <a class="btn" href="/board" target="_blank" title="Open the read-only common view">${icon('monitor')}<span class="t">Common View</span></a>
        <span class="btn" style="cursor:default">${icon('user')}<span class="name">${esc(S.me.name)}</span></span>
        <button class="btn" id="logoutBtn">${icon('logout')}<span class="t">Log out</span></button>
      </div>
    </header>
    <div class="shell">
      <aside class="sidebar"><nav class="nav">
        ${NAV.map(([h, ic, l, cls, cnt]) => `<a href="${h}" class="${cls || ''}" data-nav="${h}">${icon(ic)}<span>${l}</span>${cnt ? `<span class="count hidden" id="${cnt}"></span>` : ''}</a>`).join('')}
      </nav></aside>
      <main id="view"></main>
    </div>`;
  $('#logoutBtn').onclick = async () => {
    if (S.dirty && !(await confirmBox({ title: 'Leave without saving?', text: 'The booking you are typing is not saved yet.', ok: 'Leave', danger: true }))) return;
    S.dirty = false;
    await api('POST', '/api/logout'); S.me = null; renderLogin();
  };
  tickClock();
  S.clock = S.clock || setInterval(tickClock, 15000);
}
function tickClock() {
  const t = $('#clockTime'); if (!t) return;
  const n = new Date();
  t.textContent = fmtTime(`${pad(n.getHours())}:${pad(n.getMinutes())}`);
  $('#clockDate').textContent = fmtDate(isoDate(n));
}
function setNav(hash) {
  $$('.nav a').forEach(a => {
    const h = a.dataset.nav;
    const on = h === '#/' ? (hash === '#/' || hash === '' || hash === '#') : (hash === h || (h === '#/events' && /^#\/events\/\d+/.test(hash)));
    a.classList.toggle('active', on);
  });
}
async function refreshBadges() {
  try {
    const d = await api('GET', '/api/dashboard');
    const set = (id, n) => { const el = $('#' + id); if (!el) return; el.textContent = n; el.classList.toggle('hidden', !n); };
    set('remCount', d.counts.failed_reminders);
    set('stockCount', d.counts.to_buy_overdue + d.counts.stock_low);
    return d;
  } catch (e) { return null; }
}
function clearTimers() { S.timers.forEach(clearInterval); S.timers = []; }

/* ---------- router */
const ROUTES = [
  [/^#\/?$/, () => pageDashboard()],
  [/^#\/events\/new$/, (m, q) => pageWizard(null, q)],
  [/^#\/events\/(\d+)\/edit$/, m => pageWizard(+m[1])],
  [/^#\/events\/(\d+)$/, m => pageEvent(+m[1])],
  [/^#\/events$/, (m, q) => pageEvents(q)],
  [/^#\/calendar$/, (m, q) => pageCalendar(q)],
  [/^#\/reminders$/, () => pageReminders()],
  [/^#\/outbox$/, () => pageOutbox()],
  [/^#\/stock$/, () => pageStock()],
  [/^#\/menu$/, () => pageMenu()],
  [/^#\/customers$/, () => pageCustomers()],
  [/^#\/settings$/, () => pageSettings()],
];
let lastHash = location.hash;
async function route() {
  if (!S.me) return;
  const full = location.hash || '#/';
  if (S.dirty && full !== lastHash) {
    const leave = await confirmBox({ title: 'Leave without saving?', text: 'You have not saved this booking yet. If you leave now, what you typed will be lost.', ok: 'Leave without saving', cancel: 'Stay here', danger: true });
    if (!leave) { history.replaceState(null, '', lastHash); return; }
    S.dirty = false;
  }
  lastHash = full;
  const [hash, qs] = full.split('?');
  const q = Object.fromEntries(new URLSearchParams(qs || ''));
  clearTimers();
  setNav(hash);
  window.scrollTo(0, 0);
  for (const [re, fn] of ROUTES) {
    const m = hash.match(re);
    if (m) {
      $('#view').innerHTML = '<p class="muted">Loading…</p>';
      try { await fn(m, q); } catch (e) { if (e.status !== 401) { $('#view').innerHTML = `<div class="alert red">${icon('alert')}<div><b>Could not open this page</b>${esc(e.message)}</div></div>`; } }
      refreshBadges();
      return;
    }
  }
  location.hash = '#/';
}
window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

async function loadConfig() {
  S.cfg = await api('GET', '/api/settings');
  S.menu = await api('GET', '/api/menu');
}

async function boot() {
  try { S.me = await api('GET', '/api/me'); }
  catch (e) { return; }
  await loadConfig();
  renderShell();
  lastHash = location.hash || '#/';
  route();
}

/* ---------- shared event card */
function evCard(e) {
  const d = parseD(e.event_date);
  const venue = e.venue ? `<span>${icon('pin', 18)} ${esc(e.venue)}</span>` : '';
  const time = e.event_time ? fmtTime(e.event_time) : '<b style="color:var(--red)">Time not fixed</b>';
  return `<a class="ev u-${e.urgency}" href="#/events/${e.id}">
    <div class="datebox"><div class="m">${MONTHS[d.getMonth()]}</div><div class="d">${d.getDate()}</div><div class="w">${DAYS[d.getDay()]}</div></div>
    <div>
      <div class="row" style="gap:.5rem"><span class="title">${esc(e.title)}</span>${statusBadge(e)}${countdown(e)}</div>
      <div class="meta"><span>${icon('clock', 18)} ${time}</span><span>${icon('user', 18)} ${esc(e.customer_name)}</span>
        <span>${icon('users', 18)} ${e.guest_count} guests</span>${venue}</div>
      ${e.flags?.length ? `<div class="flags">${flagBadges(e.flags)}</div>` : ''}
    </div>
    <div class="go">Open ${icon('right')}</div>
  </a>`;
}
function emptyBox(ic, text, action = '') {
  return `<div class="empty">${icon(ic, 56)}<p>${text}</p>${action}</div>`;
}

/* ---------- dashboard */
async function pageDashboard() {
  const d = await api('GET', '/api/dashboard');
  const c = d.counts;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const stat = (href, ic, num, lbl, color, red) => `<a class="stat ${red ? 'red' : ''}" href="${href}">
      <span class="ico" style="background:${color}22;color:${color}">${icon(ic, 28)}</span>
      <span><span class="num">${num}</span><br><span class="lbl">${lbl}</span></span></a>`;
  const urgent = d.urgent;
  const weekRest = d.week.filter(e => !urgent.some(u => u.id === e.id));
  $('#view').innerHTML = `
    <div class="page-head">
      <h1>${greet}, ${esc(S.me.name)}</h1>
      <a class="btn accent big" href="#/events/new">${icon('plus')} New Booking</a>
    </div>
    ${!d.owner_phone_set ? `<div class="alert amber">${icon('info')}<div><b>Owner phone number is not set</b>
      Urgent alerts (missed confirmations, failed messages) need a phone number. <a href="#/settings">Open Settings ${icon('right', 16)}</a></div></div>` : ''}
    ${S.me.provider === 'test' ? `<div class="alert blue">${icon('info')}<div><b>WhatsApp is in TEST mode</b>
      Reminders are prepared on time but not sent automatically. Open the <a href="#/outbox">Message Outbox</a> and tap “Open in WhatsApp” to send them by hand.</div></div>` : ''}
    ${urgent.length ? `<div class="alert red">${icon('alert', 30)}<div><b>WARNING: ${urgent.length} booking${urgent.length > 1 ? 's need' : ' needs'} attention now</b>
      Events in the next 2 days, or bookings with a problem. Please check each one below.</div></div>
      <div class="ev-list" style="margin-bottom:1.5rem">${urgent.map(evCard).join('')}</div>` : `<div class="alert green">${icon('check', 28)}<div><b>All good — nothing urgent</b>No events in the next 2 days need attention.</div></div>`}
    <div class="stat-grid">
      ${stat('#/events?f=week', 'calendar', c.today, 'Events today', '#17694a')}
      ${stat('#/events?f=week', 'list', c.week, 'Events in next 7 days', '#1f5fa8')}
      ${stat('#/reminders', 'bell', c.failed_reminders, 'Failed WhatsApp messages', '#b42318', c.failed_reminders > 0)}
      ${stat('#/stock?tab=plan', 'cart', c.to_buy, `Items to buy${c.to_buy_overdue ? ` (${c.to_buy_overdue} LATE)` : ''}`, '#d9891c', c.to_buy_overdue > 0)}
      ${stat('#/events?f=upcoming', 'wallet', money(c.balance_due), 'Balance to collect', '#5b625d')}
      ${stat('#/events?f=enquiry', 'info', c.enquiries, 'Enquiries to follow up', '#1f5fa8')}
    </div>
    ${d.needs_close.length ? `<h2 class="section-title">${icon('check')} Events finished — please mark as completed</h2>
      <div class="ev-list">${d.needs_close.map(evCard).join('')}</div>` : ''}
    <h2 class="section-title">${icon('calendar')} This week</h2>
    <div class="ev-list">${weekRest.length ? weekRest.map(evCard).join('') : emptyBox('calendar', urgent.length ? 'No other events this week.' : 'No events this week.')}</div>
    <h2 class="section-title">${icon('right')} Coming later (next 30 days)</h2>
    <div class="ev-list">${d.later.length ? d.later.map(evCard).join('') : emptyBox('calendar', 'No bookings later this month yet.')}</div>
    ${d.shopping.length ? `<h2 class="section-title">${icon('cart')} To buy for upcoming bookings</h2>
      <div class="table-wrap"><table><thead><tr><th>Ingredient</th><th class="num">Need to buy</th><th>Order by</th><th>For</th></tr></thead>
      <tbody>${d.shopping.map(s => `<tr class="${s.overdue ? 'r-red' : ''}"><td><b>${esc(s.ingredient)}</b></td>
        <td class="num">${qty(s.shortage)} ${esc(s.unit)}</td>
        <td>${s.overdue ? `<span class="badge b-red">LATE — ${fmtDateShort(s.order_by)}</span>` : fmtDateShort(s.order_by)}</td>
        <td class="small">${esc(s.events.join(', '))}</td></tr>`).join('')}</tbody></table></div>
      <p><a class="btn" href="#/stock?tab=plan">${icon('cart')} Open full shopping plan ${icon('right')}</a></p>` : ''}
  `;
  S.timers.push(setInterval(() => { if ((location.hash || '#/') === '#/' && !document.querySelector('.overlay')) pageDashboard().catch(() => {}); }, 60000));
}

/* ---------- booking list */
const FILTERS = {
  upcoming: ['Upcoming', () => ({ from: todayISO(), status: 'confirmed,enquiry' })],
  week: ['Next 7 days', () => ({ from: todayISO(), to: isoDate(addDays(new Date(), 7)), status: 'confirmed,enquiry' })],
  enquiry: ['Enquiries', () => ({ status: 'enquiry' })],
  completed: ['Completed', () => ({ status: 'completed', order: 'desc' })],
  cancelled: ['Cancelled', () => ({ status: 'cancelled', order: 'desc' })],
  all: ['All', () => ({ order: 'desc' })],
  deleted: ['Deleted', () => ({ deleted: '1', order: 'desc' })],
};
function columnDefs() {
  const cols = [
    { k: 'id', l: 'No.', def: true, r: e => `#${e.id}` },
    { k: 'event_date', l: 'Date', def: true, r: e => `<span class="nowrap"><b>${fmtDateShort(e.event_date)}</b></span><br>${countdown(e)}`, s: e => e.event_date + (e.event_time || '') },
    { k: 'event_time', l: 'Time', def: true, r: e => e.event_time ? fmtTime(e.event_time) : '<span class="badge b-amber">Not fixed</span>' },
    { k: 'title', l: 'Event', def: true, r: e => `<b>${esc(e.title)}</b>${e.event_type ? `<br><span class="small muted">${esc(e.event_type)}</span>` : ''}` },
    { k: 'customer_name', l: 'Customer', def: true, r: e => esc(e.customer_name) },
    { k: 'customer_phone', l: 'Phone', def: false, r: e => esc(e.customer_phone) },
    { k: 'venue', l: 'Venue', def: true, r: e => esc(e.venue || '') },
    { k: 'guest_count', l: 'Guests', def: true, num: true, r: e => e.guest_count },
    { k: 'items_text', l: 'Food items', def: false, r: e => `<span class="small">${esc(e.items_text || '')}</span>` },
    { k: 'status', l: 'Status', def: true, r: e => statusBadge(e) },
    { k: 'total_amount', l: 'Total', def: false, num: true, r: e => money(e.total_amount) },
    { k: 'paid', l: 'Paid', def: false, num: true, r: e => money(e.paid) },
    { k: 'balance', l: 'Balance', def: true, num: true, r: e => e.balance > 0 ? `<b style="color:var(--red)">${money(e.balance)}</b>` : money(0) },
    { k: 'assigned_name', l: 'Assigned to', def: false, r: e => esc(e.assigned_name || '') },
    { k: 'next_reminder', l: 'Next reminder', def: false, r: e => e.next_reminder ? fmtDT(e.next_reminder) : '' },
    { k: 'flags', l: 'Warnings', def: true, r: e => `<div class="row" style="gap:.3rem">${flagBadges(e.flags)}</div>`, s: e => -e.flags.length },
    { k: 'updated_by', l: 'Last changed by', def: false, r: e => `${esc(e.updated_by || '')}<br><span class="small muted">${fmtDT(e.updated_at)}</span>` },
  ];
  (S.cfg.custom_fields || []).filter(f => f.active).forEach(f => cols.push({
    k: 'x_' + f.key, l: f.label, def: true, r: e => { const v = e.extra?.[f.key]; return f.field_type === 'yesno' ? (v === true || v === 'yes' ? 'Yes' : v ? 'No' : '') : esc(v ?? ''); }, s: e => String(e.extra?.[f.key] ?? ''),
  }));
  return cols;
}
function visibleCols() {
  const defs = columnDefs();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('cm.cols') || 'null'); } catch (e) { saved = null; }
  const pick = Array.isArray(saved) && saved.length ? defs.filter(c => saved.includes(c.k)) : [];
  return pick.length ? pick : defs.filter(c => c.def);
}
function saveCols(keys) { try { localStorage.setItem('cm.cols', JSON.stringify(keys)); } catch (e) { /* private mode */ } }

async function pageEvents(q = {}) {
  const f = FILTERS[q.f] ? q.f : 'upcoming';
  const params = new URLSearchParams(FILTERS[f][1]());
  if (q.q) params.set('q', q.q);
  const list = await api('GET', '/api/events?' + params.toString());
  let sortKey = null, sortDir = 1;
  const render = () => {
    const cols = visibleCols();
    const defs = columnDefs();
    let rows = list.slice();
    if (sortKey) {
      const c = defs.find(x => x.k === sortKey);
      const val = c.s || (e => e[c.k] ?? '');
      rows.sort((a, b) => { const x = val(a), y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * sortDir; });
    }
    $('#tbl').innerHTML = rows.length ? `<div class="table-wrap"><table>
      <thead><tr>${cols.map(c => `<th class="sortable ${c.num ? 'num' : ''}" data-k="${c.k}">${esc(c.l)} ${sortKey === c.k ? (sortDir > 0 ? '▲' : '▼') : ''}</th>`).join('')}
        ${f === 'deleted' ? '<th></th>' : ''}</tr></thead>
      <tbody>${rows.map(e => `<tr class="click r-${e.urgency}" data-id="${e.id}">${cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.r(e)}</td>`).join('')}
        ${f === 'deleted' ? `<td><button class="btn small" data-restore="${e.id}">${icon('undo', 18)} Restore</button></td>` : ''}</tr>`).join('')}</tbody>
    </table></div>` : emptyBox('list', 'No bookings found here.', `<a class="btn accent" href="#/events/new">${icon('plus')} New Booking</a>`);
    $$('#tbl th.sortable').forEach(th => th.onclick = () => { if (sortKey === th.dataset.k) sortDir = -sortDir; else { sortKey = th.dataset.k; sortDir = 1; } render(); });
    $$('#tbl tr.click').forEach(tr => tr.onclick = ev => { if (!ev.target.closest('button')) location.hash = `#/events/${tr.dataset.id}`; });
    $$('#tbl [data-restore]').forEach(b => b.onclick = async () => {
      try { await api('POST', `/api/events/${b.dataset.restore}/restore`); toast('Booking restored'); route(); } catch (e) { showError(e); }
    });
  };
  $('#view').innerHTML = `
    <div class="page-head"><h1>${icon('list', 30)} All Bookings</h1>
      <div class="row">
        <a class="btn" href="#/calendar">${icon('calendar')} Calendar view</a>
        <button class="btn" id="colBtn">${icon('columns')} Choose columns</button>
        <a class="btn" href="/api/export/events.csv">${icon('download')} Export to Excel</a>
        <a class="btn accent" href="#/events/new">${icon('plus')} New Booking</a>
      </div></div>
    <div class="row" style="margin-bottom:1rem">
      <div class="search">${icon('search')}<input id="q" placeholder="Search name, phone, venue or booking no." value="${esc(q.q || '')}"></div>
    </div>
    <div class="tabs">${Object.entries(FILTERS).map(([k, [l]]) => `<button class="tab ${k === f ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
    <p class="muted small">${list.length} booking${list.length === 1 ? '' : 's'} · Click a column title to sort · Click a row to open it</p>
    <div id="tbl"></div>`;
  render();
  $$('.tab[data-f]').forEach(b => b.onclick = () => { location.hash = `#/events?f=${b.dataset.f}${q.q ? '&q=' + encodeURIComponent(q.q) : ''}`; });
  let t;
  $('#q').addEventListener('input', ev => {
    clearTimeout(t);
    t = setTimeout(() => {
      const v = ev.target.value.trim();
      history.replaceState(null, '', `#/events?f=${f}${v ? '&q=' + encodeURIComponent(v) : ''}`);
      lastHash = location.hash;
      pageEvents({ f, q: v }).then(() => { const i = $('#q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); });
    }, 400);
  });
  $('#colBtn').onclick = () => {
    const defs = columnDefs();
    const vis = visibleCols().map(c => c.k);
    const m = openModal(`<h2>${icon('columns')} Choose which columns to show</h2>
      <p class="muted">Tick the columns you want to see in the list. This is remembered on this computer.</p>
      <div class="col-chooser grid2">${defs.map(c => `<label><input type="checkbox" value="${c.k}" ${vis.includes(c.k) ? 'checked' : ''}> ${esc(c.l)}</label>`).join('')}</div>
      <div class="modal-foot"><button class="btn" data-reset>${icon('undo')} Reset to normal</button>
        <button class="btn primary big" data-ok>${icon('check')} Show these columns</button></div>`);
    $('[data-reset]', m.el).onclick = () => { try { localStorage.removeItem('cm.cols'); } catch (e) { /* ignore */ } m.close(); render(); };
    $('[data-ok]', m.el).onclick = () => { saveCols($$('input:checked', m.el).map(i => i.value)); m.close(); render(); };
  };
}

/* ---------- calendar */
async function pageCalendar(q = {}) {
  const base = q.m ? parseD(q.m + '-01') : new Date();
  const first = new Date(base.getFullYear(), base.getMonth(), 1);
  const start = addDays(first, -first.getDay());
  const end = addDays(start, 41);
  const list = await api('GET', `/api/events?from=${isoDate(start)}&to=${isoDate(end)}&status=confirmed,enquiry,completed`);
  const cap = +(S.cfg.settings.max_events_per_day || 3);
  const byDay = {};
  list.forEach(e => {
    let d = parseD(e.event_date);
    const last = e.end_date ? parseD(e.end_date) : d;
    for (; d <= last; d = addDays(d, 1)) (byDay[isoDate(d)] = byDay[isoDate(d)] || []).push(e);
  });
  const ym = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const prev = new Date(first.getFullYear(), first.getMonth() - 1, 1);
  const next = new Date(first.getFullYear(), first.getMonth() + 1, 1);
  const monthName = first.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const k = isoDate(d);
    const evs = (byDay[k] || []).sort((a, b) => (a.event_time || '12:00').localeCompare(b.event_time || '12:00'));
    const active = evs.filter(e => e.status !== 'completed').length;
    cells += `<div class="day ${d.getMonth() !== first.getMonth() ? 'other' : ''} ${k === todayISO() ? 'today' : ''} ${active >= cap ? 'full' : ''}" data-date="${k}">
      <div class="dn"><span>${d.getDate()}</span>${active >= cap ? '<span class="badge b-red" style="font-size:.65rem">FULL</span>' : ''}</div>
      ${evs.map(e => `<a class="chip ${e.status === 'enquiry' ? 'enq' : e.status === 'completed' ? 'grey' : e.urgency === 'red' ? 'red' : e.urgency === 'amber' ? 'amber' : ''}" href="#/events/${e.id}" title="${esc(e.title)}">${e.event_time ? fmtTime(e.event_time).replace(':00', '') + ' ' : ''}${esc(e.title)}</a>`).join('')}
    </div>`;
  }
  $('#view').innerHTML = `
    <div class="page-head"><h1>${icon('calendar', 30)} Calendar</h1>
      <div class="row"><a class="btn" href="#/events">${icon('list')} List view</a><a class="btn accent" href="#/events/new">${icon('plus')} New Booking</a></div></div>
    <div class="row between" style="margin-bottom:1rem">
      <a class="btn big" href="#/calendar?m=${ym(prev)}">${icon('chevL')} ${MONTHS[prev.getMonth()]}</a>
      <h2 style="margin:0">${esc(monthName)}</h2>
      <a class="btn big" href="#/calendar?m=${ym(next)}">${MONTHS[next.getMonth()]} ${icon('chevR')}</a>
    </div>
    <div class="cal">${DAYS.map(d => `<div class="dow">${d}</div>`).join('')}${cells}</div>
    <p class="muted small" style="margin-top:1rem">Tap an empty part of a day to make a new booking on that date.
      Colours: <span class="badge b-red">Red = within 2 days</span> <span class="badge b-amber">Orange = within 7 days</span>
      <span class="badge b-green">Green = later</span> <span class="badge b-grey">Dashed = enquiry, grey = completed</span>
      · “FULL” = ${cap} or more bookings that day.</p>`;
  $$('.cal .day').forEach(c => c.onclick = ev => { if (!ev.target.closest('a')) location.hash = `#/events/new?date=${c.dataset.date}`; });
}

/* start */
boot().then(() => { if (!S.me) renderLogin(); });

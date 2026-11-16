'use strict';
/* Core UI: helpers, login, shell, router, home, bookings, booking page, booking form.
   Calendar / customers / items / WhatsApp / settings are in pages.js */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DB = () => Store.db;
const { isoDate, parseD, parseDT, fmtDate, fmtTime, MONTHS, DAYS } = Store;
const todayISO = () => isoDate(new Date());
const SESSION = 'catering.session';
let ME = null;
let DIRTY = false;

const money = n => 'A$ ' + Number(n || 0).toLocaleString('en-AU', { maximumFractionDigits: 2 });
const rate = () => +DB().settings.inrPerAud || Store.DEFAULT_RATE;
const inr = n => '≈ ₹ ' + Math.round((+n || 0) * rate()).toLocaleString('en-IN');
const fmtShort = s => { const d = parseD(s); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const custOf = b => DB().customers.find(c => c.id === b.customerId) || { name: '—', phone: '' };
const live = () => DB().bookings.filter(b => !b.deletedAt);
function ago(s) {
  const m = Math.round((new Date() - parseDT(s)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return fmtShort(s);
}
function whenPill(b) {
  const u = Store.urgency(b), dl = Store.daysLeft(b);
  if (b.status === 'enquiry') return '<span class="pill p-blue">Enquiry</span>';
  if (u === 'cancelled') return '<span class="pill p-grey">Cancelled</span>';
  if (u === 'done') return '<span class="pill p-grey">Done</span>';
  if (u === 'over') return '<span class="pill p-amber">Over</span>';
  const t = dl === 0 ? 'Today' : dl === 1 ? 'Tomorrow' : `${dl} days`;
  return `<span class="pill ${u === 'red' ? 'p-red' : u === 'amber' ? 'p-amber' : 'p-green'}">${u === 'red' ? icon('alert', 14) : ''}${t}</span>`;
}

/* ---------- commit: save + log + re-plan reminders */
function commit(text, bookingId) {
  if (text) Store.log(ME ? ME.name : 'system', text, bookingId);
  Store.sync();
  Store.save();
  refreshBadges();
}

/* ---------- toast / modal / confirm */
function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(type === 'err' ? 'alert' : 'check', 20)} <span>${esc(msg)}</span>`;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'err' ? 5000 : 2600);
}
function openModal(html, { onClose } = {}) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(ov);
  const onKey = e => { if (e.key === 'Escape') close(); };
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
  $$('[data-close]', ov).forEach(b => b.addEventListener('click', close));
  return { el: ov, close };
}
function confirmBox(title, text, ok = 'Yes', danger = false) {
  return new Promise(res => {
    let done = false;
    const m = openModal(`<h2>${icon(danger ? 'alert' : 'info')} ${esc(title)}</h2><p>${esc(text)}</p>
      <div class="mfoot"><button class="btn lg" data-no>No</button><button class="btn lg ${danger ? 'danger' : 'primary'}" data-yes>${esc(ok)}</button></div>`,
      { onClose: () => { if (!done) res(false); } });
    $('[data-no]', m.el).onclick = () => { done = true; m.close(); res(false); };
    $('[data-yes]', m.el).onclick = () => { done = true; m.close(); res(true); };
  });
}
function formData(root) {
  const o = {};
  $$('[name]', root).forEach(el => { o[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim(); });
  return o;
}
function fieldError(root, name, msg) {
  const el = $(`[name="${name}"]`, root);
  const f = el && el.closest('.field');
  if (f) { f.classList.add('err'); f.insertAdjacentHTML('beforeend', `<div class="err-text">${esc(msg)}</div>`); el.focus(); }
  toast(msg, 'err');
}
function clearErrors(root) { $$('.field.err', root).forEach(f => { f.classList.remove('err'); $('.err-text', f)?.remove(); }); }

/* ---------- autocomplete (shows after 2 letters) */
function autocomplete(input, source, onPick) {
  const wrap = input.parentElement;
  let list = null, hl = 0, opts = [];
  const close = () => { list?.remove(); list = null; };
  const draw = () => {
    list.innerHTML = opts.map((o, i) => `<button type="button" class="${i === hl ? 'hl' : ''} ${o.isNew ? 'new' : ''}" data-i="${i}">
      ${o.isNew ? icon('plus', 20) : ''}<span class="ellipsis">${esc(o.label)}</span>${o.sub ? `<span class="sub">${esc(o.sub)}</span>` : ''}</button>`).join('');
    $$('button', list).forEach(b => b.addEventListener('mousedown', e => { e.preventDefault(); pick(+b.dataset.i); }));
  };
  const open = () => {
    const q = input.value.trim();
    if (q.length < 2) return close();
    opts = source(q);
    if (!opts.length) return close();
    if (!list) { list = document.createElement('div'); list.className = 'ac-list'; wrap.appendChild(list); }
    hl = 0; draw();
  };
  const pick = i => { const o = opts[i]; close(); if (o) onPick(o); };
  input.setAttribute('autocomplete', 'off');
  input.addEventListener('input', open);
  input.addEventListener('focus', open);
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', e => {
    if (!list) { if (e.key === 'Enter') { e.preventDefault(); open(); if (list) pick(0); } return; }
    if (e.key === 'ArrowDown') { hl = Math.min(hl + 1, opts.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { hl = Math.max(hl - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(hl); }
    else if (e.key === 'Escape') close();
  });
}
function matchRank(text, q) {
  const t = text.toLowerCase(), s = q.toLowerCase();
  if (t.startsWith(s)) return 0;
  if (t.split(/\s+/).some(w => w.startsWith(s))) return 1;
  return t.includes(s) ? 2 : -1;
}

/* ---------- login */
function renderLogin() {
  const first = !DB().users.length;
  if (first) return renderSetup();
  let role = 'owner';
  $('#app').innerHTML = `<div class="login-wrap"><form class="login" id="lf" novalidate>
    <div class="logo">${icon('utensils', 30)}</div>
    <h1>${esc(DB().business.name || 'Catering Manager')}</h1>
    <p class="muted" style="margin:.3rem 0 1.2rem">Log in to continue</p>
    <div class="seg" style="margin-bottom:1.1rem">
      <button type="button" class="on" data-role="owner">${icon('user', 20)} Owner</button>
      <button type="button" data-role="staff">${icon('users', 20)} Staff</button></div>
    <div class="field"><label class="f" for="lp">Phone number</label><input id="lp" name="phone" type="tel" inputmode="tel" placeholder="0412 345 678"></div>
    <div class="field"><label class="f" for="lw">Password</label><input id="lw" name="pass" type="password"></div>
    <button class="btn primary lg block" type="submit">${icon('lock')} Log in</button>
    <p class="hint" style="text-align:center;margin-top:1rem">Forgot password? Ask the owner to reset it in Settings.</p>
  </form></div>`;
  $$('[data-role]').forEach(b => b.onclick = () => { role = b.dataset.role; $$('[data-role]').forEach(x => x.classList.toggle('on', x === b)); });
  $('#lf').onsubmit = async e => {
    e.preventDefault();
    const f = $('#lf'); clearErrors(f);
    const d = formData(f);
    let phone;
    try { phone = Store.normPhone(d.phone, DB().settings.cc); } catch (er) { return fieldError(f, 'phone', er.message); }
    if (!d.pass) return fieldError(f, 'pass', 'Please type your password');
    const u = DB().users.find(x => x.phone === phone && x.active !== false);
    const h = await Store.hashPass(phone, d.pass);
    if (!u || u.pass !== h) return fieldError(f, 'pass', 'Phone number or password is wrong');
    if (u.role !== role) return toast(`This number is registered as ${u.role === 'owner' ? 'Owner' : 'Staff'}. Please choose ${u.role === 'owner' ? 'Owner' : 'Staff'}.`, 'err');
    localStorage.setItem(SESSION, u.id);
    start();
  };
}
function renderSetup() {
  $('#app').innerHTML = `<div class="login-wrap"><form class="login" id="sf" novalidate>
    <div class="logo">${icon('utensils', 30)}</div>
    <h1>Welcome! Let’s set up</h1>
    <p class="muted" style="margin:.3rem 0 1.2rem">Create the owner account. Staff accounts can be added later.</p>
    <div class="field"><label class="f">Business name</label><input name="biz" placeholder="e.g. Annapoorna Caterers"></div>
    <div class="field"><label class="f">Your name</label><input name="name"></div>
    <div class="field"><label class="f">Your phone number</label><input name="phone" type="tel" inputmode="tel"></div>
    <div class="field"><label class="f">Choose a password</label><input name="pass" type="password"><div class="hint">At least 4 characters</div></div>
    <label class="check"><input type="checkbox" name="samples" checked> Add 4 example bookings to try the app</label>
    <button class="btn primary lg block" type="submit" style="margin-top:.8rem">${icon('check')} Create & start</button>
  </form></div>`;
  $('#sf').onsubmit = async e => {
    e.preventDefault();
    const f = $('#sf'); clearErrors(f);
    const d = formData(f);
    if (!d.biz) return fieldError(f, 'biz', 'Please type the business name');
    if (!d.name) return fieldError(f, 'name', 'Please type your name');
    let phone;
    try { phone = Store.normPhone(d.phone, DB().settings.cc); } catch (er) { return fieldError(f, 'phone', er.message); }
    if (d.pass.length < 4) return fieldError(f, 'pass', 'Password needs at least 4 characters');
    const db = DB();
    db.business.name = d.biz;
    const u = { id: Store.uid(), name: d.name, phone, role: 'owner', pass: await Store.hashPass(phone, d.pass), active: true };
    db.users.push(u);
    db.waNumbers.push({ id: Store.uid(), name: d.name, phone, role: 'owner' });
    Store.seedItems();
    if (d.samples) Store.seedSamples(d.name);
    Store.log(d.name, 'set up the app');
    Store.sync(); Store.save();
    localStorage.setItem(SESSION, u.id);
    start();
  };
}

/* ---------- shell */
const NAV = [
  ['#/', 'home', 'Home'], ['#/bookings', 'list', 'Bookings'], ['#/calendar', 'calendar', 'Calendar'],
  ['#/customers', 'users', 'Customers'], ['#/items', 'tag', 'Food Items'],
];
function renderShell() {
  $('#app').innerHTML = `
    <header class="header">
      <span class="logo">${icon('utensils', 22)}</span>
      <span class="biz ellipsis grow">${esc(DB().business.name)}</span>
      <div class="user-chip"><span class="pill p-blue">${icon('user', 14)} ${esc(ME.name)}</span>
        <button class="btn sm ghost" id="logout" title="Log out">${icon('logout', 20)}</button></div>
    </header>
    <div class="layout">
      <nav class="side">
        <a class="new" href="#/new">${icon('plus')} New Booking</a>
        ${NAV.map(([h, ic, l]) => `<a href="${h}" data-nav="${h}">${icon(ic)} ${l}</a>`).join('')}
        <div class="spacer"></div><div class="sep"></div>
        <a href="#/whatsapp" data-nav="#/whatsapp">${icon('chat')} WhatsApp <span class="dot hidden" data-wa></span></a>
        <a href="#/settings" data-nav="#/settings">${icon('settings')} Settings</a>
      </nav>
      <main id="view"></main>
    </div>
    <nav class="bottom-nav">
      <a href="#/" data-nav="#/">${icon('home')}Home</a>
      <a href="#/bookings" data-nav="#/bookings">${icon('list')}Bookings</a>
      <a href="#/new" aria-label="New booking"><span class="fab">${icon('plus', 30)}</span></a>
      <a href="#/calendar" data-nav="#/calendar">${icon('calendar')}Calendar</a>
      <button id="moreBtn">${icon('menu')}More<span class="dot hidden" data-wa></span></button>
    </nav>`;
  $('#logout').onclick = logout;
  $('#moreBtn').onclick = () => {
    const due = Store.dueNotes().length;
    const m = openModal(`<div class="menu-list">
      <a href="#/customers">${icon('users')} Customers</a>
      <a href="#/items">${icon('tag')} Food Items</a>
      <a href="#/whatsapp">${icon('chat')} WhatsApp ${due ? `<span class="pill p-red">${due} to send</span>` : ''}</a>
      <a href="#/settings">${icon('settings')} Settings</a>
      <button id="mLogout">${icon('logout')} Log out</button></div>`);
    $$('a', m.el).forEach(a => a.addEventListener('click', () => m.close()));
    $('#mLogout', m.el).onclick = () => { m.close(); logout(); };
  };
}
async function logout() {
  if (DIRTY && !(await confirmBox('Leave without saving?', 'The booking you are typing is not saved.', 'Leave', true))) return;
  DIRTY = false;
  localStorage.removeItem(SESSION); ME = null; renderLogin();
}
function refreshBadges() {
  const n = Store.dueNotes().length;
  $$('[data-wa]').forEach(d => { d.textContent = n; d.classList.toggle('hidden', !n); });
}

/* ---------- router */
const ROUTES = [
  [/^#\/?$/, () => pageHome()],
  [/^#\/bookings$/, (m, q) => pageBookings(q)],
  [/^#\/new$/, (m, q) => pageForm(null, q)],
  [/^#\/b\/(\w+)\/edit$/, m => pageForm(m[1])],
  [/^#\/b\/(\w+)$/, m => pageBooking(m[1])],
  [/^#\/calendar$/, (m, q) => pageCalendar(q)],
  [/^#\/customers$/, () => pageCustomers()],
  [/^#\/c\/(\w+)$/, m => pageCustomer(m[1])],
  [/^#\/items$/, () => pageItems()],
  [/^#\/whatsapp$/, () => pageWhatsApp()],
  [/^#\/settings$/, () => pageSettings()],
];
let lastHash = '';
async function route() {
  if (!ME) return;
  const full = location.hash || '#/';
  if (DIRTY && full !== lastHash) {
    if (!(await confirmBox('Leave without saving?', 'This booking is not saved yet. What you typed will be lost.', 'Leave', true))) {
      history.replaceState(null, '', lastHash); return;
    }
    DIRTY = false;
  }
  lastHash = full;
  const [hash, qs] = full.split('?');
  const q = Object.fromEntries(new URLSearchParams(qs || ''));
  $$('[data-nav]').forEach(a => {
    const h = a.dataset.nav;
    a.classList.toggle('on', h === '#/' ? hash === '#/' || hash === '#' || hash === '' : hash.startsWith(h) || (h === '#/bookings' && hash.startsWith('#/b/')) || (h === '#/customers' && hash.startsWith('#/c/')));
  });
  window.scrollTo(0, 0);
  for (const [re, fn] of ROUTES) {
    const m = hash.match(re);
    if (m) {
      try { fn(m, q); } catch (e) { console.error(e); $('#view').innerHTML = `<div class="banner red">${icon('alert')}<div><b>Something went wrong</b>${esc(e.message)}</div></div>`; }
      refreshBadges();
      return;
    }
  }
  location.hash = '#/';
}
window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', e => { if (DIRTY) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('storage', e => { if (e.key === Store.KEY && ME && !DIRTY) { Store.load(); route(); } });

/* ---------- booking row */
function bkRow(b, opt = {}) {
  const d = parseD(b.date), c = custOf(b), u = Store.urgency(b), att = opt.warn === false ? null : Store.attention(b)[0];
  const bal = Store.balance(b), near = Store.daysLeft(b) <= 2 && ['confirmed', 'enquiry'].includes(b.status);
  return `<a class="bk u-${u}" href="#/b/${b.id}">
    <div class="dt"><span>${MONTHS[d.getMonth()]}</span><b>${d.getDate()}</b><span>${DAYS[d.getDay()]}</span></div>
    <div class="grow">
      <div class="t ellipsis">${esc(b.title)}</div>
      <div class="s ellipsis">${esc(c.name)} · ${b.time ? fmtTime(b.time) : 'Time ?'} · ${b.guests || 0} guests</div>
      ${att ? `<div class="warn" style="${att.level === 'amber' ? 'color:var(--amber)' : ''}">${icon('alert', 15)} ${esc(att.text)}</div>` : ''}
    </div>
    <div class="xl s ellipsis">${b.venue ? icon('pin', 16) + ' ' + esc(b.venue) : ''}</div>
    <div class="xl s money-col">${bal > 0 ? `<span style="${near ? 'color:var(--red);font-weight:800' : 'font-weight:600'}">${money(bal)} due</span>` : (b.total ? '<span style="color:var(--green);font-weight:700">Paid</span>' : '—')}</div>
    <div class="r">${whenPill(b)}${icon('chevR', 20)}</div>
  </a>`;
}
const listOrEmpty = (arr, msg, opt) => arr.length ? `<div class="list">${arr.map(b => bkRow(b, opt)).join('')}</div>` : `<div class="list"><div class="empty">${esc(msg)}</div></div>`;
const byStart = (a, b) => Store.bookingStart(a) - Store.bookingStart(b);

/* ---------- home
   Order (most important first): 1 next event  2 needs attention  3 coming up  4 recent updates */
function readiness(b) {
  const dl = Store.daysLeft(b), bal = Store.balance(b);
  const out = [];
  if (b.status === 'enquiry') out.push({ s: 'bad', t: 'Not confirmed (enquiry)' });
  else out.push(b.reconfirmedAt ? { s: 'ok', t: 'Re-confirmed' } : dl <= 2 ? { s: 'bad', t: 'Not re-confirmed' } : { s: 'wait', t: 'Re-confirm later' });
  out.push(b.time ? { s: 'ok', t: `Time ${fmtTime(b.time)}` } : { s: 'bad', t: 'Time not fixed' });
  out.push((b.items || []).length ? { s: 'ok', t: `${b.items.length} food item${b.items.length > 1 ? 's' : ''}` } : { s: 'bad', t: 'No food added' });
  out.push(bal <= 0 ? { s: 'ok', t: b.total ? 'Fully paid' : 'No amount set' } : { s: dl <= 2 ? 'bad' : 'wait', t: `${money(bal)} due` });
  return out;
}
function dayLabel(iso) {
  const dl = Math.round((parseD(iso) - parseD(todayISO())) / 86400000);
  if (dl === 0) return 'Today';
  if (dl === 1) return 'Tomorrow';
  const d = parseD(iso);
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
function quickAct(b) {
  if (b.status === 'enquiry') return ['confirm', 'check', 'Confirm booking'];
  const codes = Store.attention(b).map(a => a.code);
  if (codes.includes('close')) return ['complete', 'check', 'Mark completed'];
  if (codes.includes('reconfirm')) return ['reconfirm', 'check', 'Mark re-confirmed'];
  if (codes.includes('time') || codes.includes('items')) return ['edit', 'edit', codes.includes('time') ? 'Set the time' : 'Add food'];
  if (codes.includes('balance')) return ['open', 'wallet', 'Add payment'];
  return ['open', 'chevR', 'Open'];
}

function pageHome() {
  const now = new Date();
  const active = live().filter(b => ['confirmed', 'enquiry'].includes(b.status)).sort(byStart);
  const upcoming = active.filter(b => Store.daysLeft(b, now) >= 0);
  const next = upcoming.find(b => b.status === 'confirmed') || upcoming[0] || null;
  const sameDayMore = next ? upcoming.filter(b => b !== next && b.date === next.date).length : 0;
  const attention = active.filter(b => b !== next && Store.attention(b, now).length)
    .sort((x, y) => (Store.attention(y, now).some(a => a.level === 'red') - Store.attention(x, now).some(a => a.level === 'red')) || byStart(x, y));
  const due = Store.dueNotes(now).length;
  const todayN = upcoming.filter(b => Store.daysLeft(b, now) === 0).length;
  const weekN = upcoming.filter(b => Store.daysLeft(b, now) <= 7).length;
  const todo = attention.length + (next && Store.attention(next, now).length ? 1 : 0);
  const soon = upcoming.filter(b => b !== next && Store.daysLeft(b, now) <= 14);
  const hr = now.getHours();

  const stat = (href, ic, n, label, alert) => `<a class="stat ${alert && n ? 'alert' : ''}" href="${href}">${icon(ic, 20)}<b>${n}</b><span>${label}</span></a>`;

  const hero = next ? (() => {
    const c = custOf(next), dl = Store.daysLeft(next, now), ready = readiness(next);
    const tone = dl <= 2 ? 'red' : dl <= 7 ? 'amber' : 'green';
    const [act, ic, lbl] = quickAct(next);
    const when = dl === 0 ? 'TODAY' : dl === 1 ? 'TOMORROW' : `IN ${dl} DAYS`;
    return `<section class="hero t-${tone}">
      <div class="hero-top"><span class="eyebrow">Next event</span>
        <span class="when-big">${when}${next.time ? ' · ' + fmtTime(next.time) : ''}</span></div>
      <a class="hero-title" href="#/b/${next.id}">${esc(next.title)}</a>
      <div class="hero-meta">
        <span>${icon('calendar', 18)} ${fmtDate(next.date)}</span>
        <span>${icon('user', 18)} ${esc(c.name)}</span>
        ${next.venue ? `<span>${icon('pin', 18)} ${esc(next.venue)}</span>` : ''}
        <span>${icon('users', 18)} ${next.guests || 0} guests</span></div>
      <ul class="ready">${ready.map(r => `<li class="${r.s}">${icon(r.s === 'ok' ? 'check' : r.s === 'bad' ? 'alert' : 'clock', 16)} ${esc(r.t)}</li>`).join('')}</ul>
      <div class="hero-actions">
        ${act !== 'open' ? `<button class="btn primary" data-act="${act}" data-id="${next.id}">${icon(ic, 18)} ${lbl}</button>` : ''}
        <a class="btn" href="tel:${esc(c.phone)}">${icon('phone', 18)} Call</a>
        <a class="btn" href="#/b/${next.id}">Open ${icon('chevR', 18)}</a></div>
      ${sameDayMore ? `<p class="small muted" style="margin:.6rem 0 0">+ ${sameDayMore} more booking${sameDayMore > 1 ? 's' : ''} the same day — see Coming up</p>` : ''}
    </section>`;
  })() : `<section class="hero t-none"><span class="eyebrow">Next event</span>
      <p class="hero-title" style="margin:.4rem 0">No upcoming events</p>
      <a class="btn accent" href="#/new">${icon('plus')} New booking</a></section>`;

  const attCard = b => {
    const list = Store.attention(b, now), c = custOf(b), red = list.some(a => a.level === 'red');
    const [act, ic, lbl] = quickAct(b);
    const d = parseD(b.date);
    return `<article class="acard ${red ? 'red' : 'amber'}">
      <div class="acard-head"><span class="adate"><b>${d.getDate()}</b>${MONTHS[d.getMonth()]}</span>
        <div class="grow"><a href="#/b/${b.id}" class="atitle ellipsis">${esc(b.title)}</a><span class="small muted ellipsis">${esc(c.name)}</span></div>
        ${whenPill(b)}</div>
      <p class="aissue">${icon('alert', 16)} ${esc(list[0].text)}</p>
      ${list.length > 1 ? `<p class="amore">${list.slice(1).map(a => esc(a.text)).join(' · ')}</p>` : ''}
      <div class="acard-foot">${act !== 'open' ? `<button class="btn sm ${red ? 'primary' : ''}" data-act="${act}" data-id="${b.id}">${icon(ic, 16)} ${lbl}</button>` : ''}
        <a class="btn sm ghost" href="#/b/${b.id}">Open ${icon('chevR', 16)}</a></div>
    </article>`;
  };

  const groups = [];
  soon.forEach(b => { const g = groups.find(x => x.date === b.date); g ? g.list.push(b) : groups.push({ date: b.date, list: [b] }); });
  const timeline = groups.length ? groups.map(g => `<div class="tl-day"><h3>${dayLabel(g.date)}</h3>
      ${g.list.map(b => `<a class="tl-row u-${Store.urgency(b, now)}" href="#/b/${b.id}">
        <span class="tl-time">${b.time ? fmtTime(b.time) : 'Time ?'}</span>
        <span class="grow"><b class="ellipsis">${esc(b.title)}</b><span class="small muted ellipsis">${esc(custOf(b).name)} · ${b.guests || 0} guests</span></span>
        ${b.status === 'enquiry' ? '<span class="pill p-blue">Enquiry</span>' : ''}${icon('chevR', 18)}</a>`).join('')}</div>`).join('')
    : '<p class="muted small" style="margin:.4rem 0">Nothing else in the next 2 weeks.</p>';

  const updates = DB().activity.slice(0, 4).map(a => `<li><b>${esc(a.by)}</b> ${esc(a.text)} <span class="muted">· ${ago(a.at)}</span></li>`).join('');

  $('#view').innerHTML = `
    <div class="home">
      <header class="home-head">
        <div><h1>${hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening'}, ${esc(ME.name.split(' ')[0])}</h1>
          <span class="muted">${fmtDate(todayISO())}</span></div>
        <nav class="stats">
          ${stat('#/calendar', 'calendar', todayN, 'Today')}
          ${stat('#/bookings', 'list', weekN, 'This week')}
          ${stat('#attn', 'alert', todo, 'To do', true)}
          ${stat('#/whatsapp', 'chat', due, 'Messages', true)}
        </nav>
      </header>

      <div class="home-cols">
        <div class="home-main">
          ${hero}
          ${due ? `<a class="msg-bar" href="#/whatsapp">${icon('chat', 20)} <b>${due} WhatsApp message${due > 1 ? 's' : ''} ready to send</b><span class="grow"></span>Send ${icon('chevR', 18)}</a>` : ''}
          <section id="attn" class="block">
            <div class="block-head"><h2>Needs attention</h2>${attention.length ? `<span class="count-badge">${attention.length}</span>` : ''}</div>
            ${attention.length ? `<div class="acards">${attention.map(attCard).join('')}</div>`
              : `<div class="calm">${icon('check', 20)} Nothing else needs attention</div>`}
          </section>
        </div>
        <aside class="home-side">
          <section class="block panel">
            <div class="block-head"><h2>Coming up</h2><a class="small" href="#/calendar">Calendar ${icon('chevR', 14)}</a></div>
            ${timeline}
          </section>
          <section class="block panel">
            <div class="block-head"><h2>Recent updates</h2></div>
            ${updates ? `<ul class="updates">${updates}</ul>` : '<p class="muted small">No updates yet</p>'}
          </section>
        </aside>
      </div>
    </div>`;

  $$('.stat[href="#attn"]').forEach(a => a.onclick = e => { e.preventDefault(); $('#attn').scrollIntoView({ behavior: 'smooth' }); });
  $$('[data-act]').forEach(btn => btn.onclick = async () => {
    const b = DB().bookings.find(x => x.id === btn.dataset.id);
    const act = btn.dataset.act;
    if (act === 'reconfirm') { b.reconfirmedAt = Store.toISO(new Date()); b.reconfirmedBy = ME.name; commit(`re-confirmed ${b.title} with customer`, b.id); toast('Marked as re-confirmed'); pageHome(); }
    else if (act === 'complete') { b.status = 'completed'; touch(b); commit(`marked ${b.title} completed`, b.id); toast('Marked completed'); pageHome(); }
    else if (act === 'confirm') {
      if (!(await confirmBox('Confirm this booking?', 'The customer gets a WhatsApp confirmation.', 'Confirm'))) return;
      b.status = 'confirmed'; touch(b); Store.queueOneOff(b, 'confirm'); commit(`confirmed ${b.title}`, b.id); toast('Booking confirmed'); pageHome();
    }
    else if (act === 'edit') location.hash = `#/b/${b.id}/edit`;
    else location.hash = `#/b/${b.id}`;
  });
}

function touch(b) { b.updatedAt = Store.toISO(new Date()); b.updatedBy = ME.name; }

/* ---------- bookings list */
const FILTERS = {
  upcoming: ['Upcoming', b => ['confirmed', 'enquiry'].includes(b.status) && Store.daysLeft(b) >= 0],
  enquiry: ['Enquiries', b => b.status === 'enquiry'],
  past: ['Past', b => b.status === 'completed' || (b.status === 'confirmed' && Store.daysLeft(b) < 0)],
  cancelled: ['Cancelled', b => b.status === 'cancelled'],
  all: ['All', () => true],
};
function pageBookings(q = {}) {
  let f = FILTERS[q.f] ? q.f : 'upcoming';
  let text = q.q || '';
  $('#view').innerHTML = `
    <div class="page-head"><h1>${icon('list', 26)} Bookings</h1></div>
    <div class="field ac" style="margin-bottom:.7rem"><input id="bq" type="search" placeholder="Search name, phone, venue…" value="${esc(text)}"></div>
    <div class="chips" style="margin-bottom:1rem">${Object.entries(FILTERS).map(([k, [l]]) => `<button class="chip ${k === f ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
    <div id="bl"></div>`;
  const draw = () => {
    const s = text.toLowerCase();
    let arr = live().filter(FILTERS[f][1]).filter(b => {
      if (!s) return true;
      const c = custOf(b);
      return [b.title, b.venue, b.type, c.name, c.phone].some(v => (v || '').toLowerCase().includes(s));
    });
    arr.sort(byStart);
    if (['past', 'cancelled', 'all'].includes(f)) arr.reverse();
    const groups = {};
    arr.forEach(b => { const d = parseD(b.date); const k = d.toLocaleString('en-IN', { month: 'long', year: 'numeric' }); (groups[k] = groups[k] || []).push(b); });
    $('#bl').innerHTML = arr.length ? Object.entries(groups).map(([k, list]) => `<div class="section-head" style="margin-top:1rem"><h2 class="small muted" style="text-transform:uppercase">${esc(k)}</h2><span class="small muted">${list.length}</span></div>
      <div class="list">${list.map(bkRow).join('')}</div>`).join('')
      : `<div class="list"><div class="empty">${icon('list', 44)}<p>No bookings here</p><a class="btn accent" href="#/new">${icon('plus')} New Booking</a></div></div>`;
  };
  draw();
  $$('[data-f]').forEach(b => b.onclick = () => { f = b.dataset.f; $$('[data-f]').forEach(x => x.classList.toggle('on', x === b)); history.replaceState(null, '', `#/bookings?f=${f}`); lastHash = location.hash; draw(); });
  $('#bq').addEventListener('input', e => { text = e.target.value.trim(); draw(); });
}

/* ---------- booking page */
function pageBooking(id) {
  const b = DB().bookings.find(x => x.id === id);
  if (!b) { $('#view').innerHTML = `<div class="empty">Booking not found. <a href="#/bookings">Back</a></div>`; return; }
  const c = custOf(b), u = Store.urgency(b), dl = Store.daysLeft(b), bal = Store.balance(b);
  const active = ['confirmed', 'enquiry'].includes(b.status) && !b.deletedAt;
  $('#view').innerHTML = `
    <div class="row between" style="margin-bottom:.8rem"><a class="btn sm ghost" href="#/bookings">${icon('left', 20)} Bookings</a>
      ${!b.deletedAt ? `<a class="btn sm primary" href="#/b/${b.id}/edit">${icon('edit', 18)} Edit</a>` : ''}</div>
    ${b.deletedAt ? `<div class="banner red" style="margin-bottom:1rem">${icon('trash')}<div><b>Deleted</b><button class="btn sm" id="restore" style="margin-top:.4rem">${icon('undo', 18)} Restore</button></div></div>` : ''}
    ${u === 'red' && b.status === 'confirmed' ? `<div class="banner ${b.reconfirmedAt ? 'green' : 'red'}" style="margin-bottom:1rem">${icon(b.reconfirmedAt ? 'check' : 'alert', 26)}<div class="grow">
        <b>${dl === 0 ? 'Event is TODAY' : dl === 1 ? 'Event is TOMORROW' : 'Event in 2 days'}</b>
        ${b.reconfirmedAt ? `Re-confirmed by ${esc(b.reconfirmedBy)} · ${ago(b.reconfirmedAt)}` : 'Call the customer and check all details.'}
        ${!b.reconfirmedAt ? `<div class="row" style="margin-top:.6rem"><button class="btn primary" id="reconf">${icon('check')} Customer re-confirmed</button>
          <a class="btn" href="tel:${esc(c.phone)}">${icon('phone')} Call</a></div>` : ''}</div></div>` : ''}

    <div class="detail-grid"><div class="d-left">
    <div class="card">
      <div class="pad"><div class="row" style="gap:.4rem;margin-bottom:.3rem">${whenPill(b)}${b.type ? `<span class="pill p-grey">${esc(b.type)}</span>` : ''}</div>
        <h1>${esc(b.title)}</h1></div>
      <dl class="kv" style="border-top:1px solid var(--line)">
        <dt>Date</dt><dd>${fmtDate(b.date)}</dd>
        <dt>Time</dt><dd>${b.time ? fmtTime(b.time) : '<span style="color:var(--red)">Not fixed yet</span>'}</dd>
        <dt>Venue</dt><dd>${esc(b.venue || '—')}</dd>
        <dt>Guests</dt><dd>${b.guests || 0}</dd>
      </dl>
      ${b.special ? `<div class="pad" style="border-top:1px solid var(--line)"><div class="special">${icon('alert', 18)} ${esc(b.special)}</div></div>` : ''}
      ${b.notes ? `<div class="pad muted" style="border-top:1px solid var(--line)">${esc(b.notes)}</div>` : ''}
    </div>

    <div class="section"><div class="section-head"><h2>${icon('user')} Customer</h2></div>
      <div class="card"><div class="att"><div class="txt"><a href="#/c/${c.id}" style="color:inherit"><b>${esc(c.name)}</b></a><span class="muted">${esc(c.phone)}</span></div>
        <a class="btn sm" href="tel:${esc(c.phone)}">${icon('phone', 18)} Call</a>
        <a class="btn sm wa" target="_blank" rel="noopener" href="https://wa.me/${esc(c.phone.replace(/\D/g, ''))}">${icon('chat', 18)}</a></div></div></div>

    </div><div class="d-right">
    <div class="section"><div class="section-head"><h2>${icon('utensils')} Food</h2><span class="small muted">${(b.items || []).length} items</span></div>
      <div class="list">${(b.items || []).map(i => `<div class="item-line"><span>${esc(i.name)}</span><b>${i.qty} ${esc(i.unit || 'plates')}</b></div>`).join('')
        || `<div class="empty">No food items yet · <a href="#/b/${b.id}/edit">Add</a></div>`}</div></div>

    <div class="section"><div class="section-head"><h2>${icon('wallet')} Payment</h2>${active ? `<button class="btn sm" id="addPay">${icon('plus', 18)} Add payment</button>` : ''}</div>
      <div class="card"><div class="money"><div><span class="small muted">Total</span><b>${money(b.total)}</b></div>
        <div><span class="small muted">Paid</span><b>${money(Store.paid(b))}</b></div><div class="${bal > 0 ? 'due' : ''}"><span class="small muted">Balance</span><b>${money(bal)}</b></div></div>
        <p class="small muted" style="margin:0;padding:.5rem 1.1rem;border-top:1px solid var(--line)">Total ${inr(b.total)} · rate 1 A$ = ₹${rate()}</p>
        ${(b.payments || []).length ? `<div class="list" style="border:0;border-top:1px solid var(--line);border-radius:0;box-shadow:none">${b.payments.map(p => `<div class="item-line"><span class="muted">${fmtShort(p.date)} · ${esc(p.mode || '')}</span><b>${money(p.amount)}</b></div>`).join('')}</div>` : ''}</div></div>

    </div></div>
    ${!b.deletedAt ? `<div class="section actions-bar">
      ${b.status === 'enquiry' ? `<button class="btn primary" data-st="confirmed">${icon('check')} Confirm booking</button>` : ''}
      ${b.status === 'confirmed' ? `<button class="btn" data-st="completed">${icon('check')} Mark completed</button>` : ''}
      ${['completed', 'cancelled'].includes(b.status) ? `<button class="btn" data-st="confirmed">${icon('undo')} Re-open</button>` : ''}
      <button class="btn" id="again">${icon('copy')} Book again</button>
      ${active ? `<button class="btn danger" data-st="cancelled">${icon('x')} Cancel booking</button>` : ''}
      <button class="btn danger" id="del">${icon('trash')} Delete</button></div>` : ''}
    <p class="small muted" style="margin-top:1rem">Last changed by ${esc(b.updatedBy || b.createdBy || '')} · ${b.updatedAt ? ago(b.updatedAt) : ''}</p>`;

  $('#reconf')?.addEventListener('click', () => { b.reconfirmedAt = Store.toISO(new Date()); b.reconfirmedBy = ME.name; commit(`re-confirmed ${b.title} with customer`, b.id); toast('Re-confirmed'); pageBooking(id); });
  $('#restore')?.addEventListener('click', () => { delete b.deletedAt; touch(b); commit(`restored ${b.title}`, b.id); toast('Restored'); pageBooking(id); });
  $$('[data-st]').forEach(btn => btn.onclick = async () => {
    const st = btn.dataset.st;
    const msg = { cancelled: ['Cancel this booking?', 'Reminders for it will stop.', 'Cancel booking', true], completed: ['Mark as completed?', 'The event is finished.', 'Completed', false], confirmed: ['Confirm this booking?', 'The customer gets a WhatsApp confirmation.', 'Confirm', false] }[st];
    if (!(await confirmBox(...msg))) return;
    const was = b.status;
    b.status = st; touch(b);
    if (st === 'confirmed' && was === 'enquiry') Store.queueOneOff(b, 'confirm');
    commit(`${st === 'confirmed' ? (was === 'enquiry' ? 'confirmed' : 're-opened') : st === 'cancelled' ? 'cancelled' : 'completed'} ${b.title}`, b.id);
    toast('Updated'); pageBooking(id);
  });
  $('#again')?.addEventListener('click', () => {
    sessionStorage.setItem('cm.copy', JSON.stringify({ customerId: b.customerId, title: b.title, type: b.type, time: b.time, venue: b.venue, guests: b.guests, items: b.items, total: b.total, special: b.special }));
    location.hash = '#/new?copy=1';
  });
  $('#del')?.addEventListener('click', async () => {
    if (!(await confirmBox('Delete this booking?', 'You can restore it later from Bookings → All.', 'Delete', true))) return;
    b.deletedAt = Store.toISO(new Date()); touch(b); commit(`deleted ${b.title}`, b.id); toast('Deleted'); location.hash = '#/bookings';
  });
  $('#addPay')?.addEventListener('click', () => {
    const m = openModal(`<h2>${icon('wallet')} Add payment</h2><div id="pf">
      <div class="field"><label class="f">Amount (A$)</label><input name="amount" type="number" inputmode="decimal" min="0" value="${bal || ''}"></div>
      <div class="field"><label class="f">Paid by</label><div class="chips" id="modes">${['Cash', 'UPI', 'Bank', 'Cheque'].map((x, i) => `<button type="button" class="chip ${i ? '' : 'on'}" data-m="${x}">${x}</button>`).join('')}</div></div>
      <div class="field"><label class="f">Date</label><input name="date" type="date" value="${todayISO()}"></div></div>
      <div class="mfoot"><button class="btn lg" data-close>Cancel</button><button class="btn lg primary" id="savePay">${icon('check')} Save</button></div>`);
    let mode = 'Cash';
    $$('[data-m]', m.el).forEach(x => x.onclick = () => { mode = x.dataset.m; $$('[data-m]', m.el).forEach(y => y.classList.toggle('on', y === x)); });
    $('#savePay', m.el).onclick = () => {
      const d = formData($('#pf', m.el));
      if (!(+d.amount > 0)) return toast('Please type the amount', 'err');
      b.payments = b.payments || [];
      b.payments.push({ id: Store.uid(), amount: +d.amount, date: d.date || todayISO(), mode });
      touch(b); commit(`added payment ${money(d.amount)} for ${b.title}`, b.id); m.close(); toast('Payment saved'); pageBooking(id);
    };
  });
}

/* ---------- booking form (new + edit) */
const TYPES = ['Wedding', 'Engagement', 'Birthday', 'House Warming', 'Corporate', 'Pooja', 'Funeral', 'Party', 'Other'];
function pageForm(id, q = {}) {
  const db = DB();
  const src = id ? db.bookings.find(x => x.id === id) : null;
  if (id && !src) { location.hash = '#/bookings'; return; }
  let copy = null;
  if (q.copy) { try { copy = JSON.parse(sessionStorage.getItem('cm.copy') || 'null'); } catch (e) { copy = null; } sessionStorage.removeItem('cm.copy'); }
  const base = src || copy || {};
  const F = {
    customerId: base.customerId || q.customer || null, cname: '', cphone: '',
    type: base.type || '', title: base.title || '', date: src ? src.date : (q.date || ''), time: base.time || '',
    timeUnknown: src ? !src.time : false, venue: base.venue || '', guests: base.guests ?? '', status: src ? src.status : 'confirmed',
    special: base.special || '', notes: src ? src.notes || '' : '', items: JSON.parse(JSON.stringify(base.items || [])),
    total: base.total ?? '', advance: '', remindCustomer: src ? src.remindCustomer !== false : true,
  };
  let step = 0;
  DIRTY = false;
  const STEP_NAMES = ['Customer', 'Event', 'Food', 'Payment'];
  const setDirty = () => { DIRTY = true; };

  const stepCustomer = () => {
    const c = F.customerId && db.customers.find(x => x.id === F.customerId);
    return `<p class="step-title">Step 1 of 4</p><h2 style="margin:.2rem 0 1rem">Who is the customer?</h2>
      ${c ? `<div class="card"><div class="att"><span class="ico blue">${icon('user')}</span><div class="txt"><b>${esc(c.name)}</b><span class="muted">${esc(c.phone)}</span></div>
          <button class="btn sm" id="chgCust">${icon('edit', 18)} Change</button></div></div>`
        : `<div class="field ac"><label class="f">Search existing customer</label><input id="custSearch" placeholder="Type 2 letters of name or phone"></div>
          <p class="muted small" style="text-align:center;margin:.4rem 0 1rem">— or add a new customer —</p>
          <div class="grid2"><div class="field"><label class="f">Customer name</label><input name="cname" value="${esc(F.cname)}"></div>
          <div class="field"><label class="f">Phone (WhatsApp)</label><input name="cphone" type="tel" inputmode="tel" value="${esc(F.cphone)}" placeholder="0412 345 678"></div></div>`}`;
  };
  const sameDay = () => F.date ? live().filter(b => b.id !== id && ['confirmed', 'enquiry'].includes(b.status) && b.date === F.date) : [];
  const stepEvent = () => `<p class="step-title">Step 2 of 4</p><h2 style="margin:.2rem 0 1rem">Event details</h2>
    <div class="field"><label class="f">Type of event</label><div class="types">${TYPES.map(t => `<button type="button" class="${F.type === t ? 'on' : ''}" data-type="${t}">${t}</button>`).join('')}</div></div>
    <div class="field"><label class="f">Event name <span class="muted small">(optional)</span></label><input name="title" value="${esc(F.title)}" placeholder="e.g. Ramesh & Priya Wedding"></div>
    <div class="grid2">
      <div class="field"><label class="f">Date</label><input name="date" type="date" value="${esc(F.date)}"><div id="dayInfo"></div></div>
      <div class="field"><label class="f">Serving time</label><input name="time" type="time" value="${esc(F.time)}" ${F.timeUnknown ? 'disabled' : ''}>
        <label class="check"><input type="checkbox" name="timeUnknown" ${F.timeUnknown ? 'checked' : ''}> Time not fixed yet</label></div>
    </div>
    <div class="grid2">
      <div class="field"><label class="f">Venue</label><input name="venue" value="${esc(F.venue)}" placeholder="Hall / address"></div>
      <div class="field"><label class="f">Guests</label><div class="stepper"><button type="button" data-g="-10">−</button>
        <input name="guests" type="number" inputmode="numeric" min="0" value="${esc(F.guests)}"><button type="button" data-g="10">+</button></div></div>
    </div>
    <div class="field"><label class="f">Status</label><div class="seg">
      <button type="button" class="${F.status === 'confirmed' ? 'on' : ''}" data-status="confirmed">${icon('check', 18)} Confirmed</button>
      <button type="button" class="${F.status === 'enquiry' ? 'on' : ''}" data-status="enquiry">${icon('info', 18)} Enquiry</button></div></div>
    <div class="field"><label class="f">Special instructions <span class="muted small">(allergy, Jain…)</span></label><textarea name="special">${esc(F.special)}</textarea></div>`;
  const stepFood = () => `<p class="step-title">Step 3 of 4</p><h2 style="margin:.2rem 0 1rem">Food items</h2>
    <div class="field ac"><input id="foodSearch" placeholder="Type 2 letters, e.g. “bi” for Biryani"></div>
    <div class="list" id="foodList">${F.items.map((it, i) => `<div class="food-row"><b class="ellipsis">${esc(it.name)}</b>
      <div class="stepper"><button type="button" data-q="${i}" data-d="-10">−</button><input type="number" inputmode="numeric" min="0" data-qty="${i}" value="${esc(it.qty)}"><button type="button" data-q="${i}" data-d="10">+</button></div>
      <button type="button" class="btn icon danger" data-rm="${i}" title="Remove">${icon('trash', 18)}</button></div>`).join('') || '<div class="empty">No food added yet</div>'}</div>
    ${F.items.length && +F.guests ? `<button type="button" class="btn block" id="eqGuests" style="margin-top:.7rem">${icon('users')} Set all to ${F.guests} plates</button>` : ''}`;
  const estimate = () => F.items.reduce((s, it) => s + ((db.items.find(x => x.id === it.itemId) || {}).price || 0) * (+it.qty || 0), 0);
  const stepPay = () => {
    const c = F.customerId ? db.customers.find(x => x.id === F.customerId) : { name: F.cname, phone: F.cphone };
    const est = estimate();
    return `<p class="step-title">Step 4 of 4</p><h2 style="margin:.2rem 0 1rem">Payment & save</h2>
      <div class="grid2"><div class="field"><label class="f">Total amount (A$)</label><input name="total" type="number" inputmode="decimal" min="0" value="${esc(F.total)}">
        ${est ? `<div class="hint">Menu estimate ${money(est)} · <a href="#" id="useEst">use this</a></div>` : ''}</div>
        ${id ? '' : `<div class="field"><label class="f">Advance received (A$)</label><input name="advance" type="number" inputmode="decimal" min="0" value="${esc(F.advance)}"></div>`}</div>
      <label class="check"><input type="checkbox" name="remindCustomer" ${F.remindCustomer ? 'checked' : ''}> Send WhatsApp reminders to the customer</label>
      <div class="card" style="margin-top:1rem"><dl class="kv">
        <dt>Customer</dt><dd>${esc(c?.name || '')}</dd>
        <dt>Event</dt><dd>${esc(F.title || `${F.type || 'Event'} - ${c?.name || ''}`)}${F.status === 'enquiry' ? ' <span class="pill p-blue">Enquiry</span>' : ''}</dd>
        <dt>When</dt><dd>${F.date ? fmtDate(F.date) : '—'} · ${F.timeUnknown || !F.time ? 'time not fixed' : fmtTime(F.time)}</dd>
        <dt>Guests</dt><dd>${F.guests || 0}</dd>
        <dt>Food</dt><dd>${F.items.length ? esc(F.items.map(i => `${i.name} (${i.qty})`).join(', ')) : '—'}</dd></dl></div>`;
  };
  const STEPS = [stepCustomer, stepEvent, stepFood, stepPay];

  function render() {
    $('#view').innerHTML = `<div class="narrow">
      <div class="row between" style="margin-bottom:.8rem"><h1>${id ? 'Edit booking' : 'New booking'}</h1>
        <a class="btn sm ghost" href="${id ? '#/b/' + id : '#/'}">${icon('x', 20)} Close</a></div>
      <div class="steps">${STEP_NAMES.map((n, i) => `<div class="${i <= step ? 'on' : ''}" title="${n}"></div>`).join('')}</div>
      <div id="sb" class="card pad form-card">${STEPS[step]()}</div>
      <div class="foot">
        ${step ? `<button class="btn lg" id="back">${icon('left')} Back</button>` : ''}
        ${step < 3 ? `<button class="btn lg primary" id="next">Next ${icon('right')}</button>` : `<button class="btn lg accent" id="save">${icon('check')} Save booking</button>`}
      </div></div>`;
    bind();
  }
  function read() {
    const d = formData($('#sb'));
    ['cname', 'cphone', 'title', 'date', 'time', 'venue', 'guests', 'special', 'total', 'advance'].forEach(k => { if (k in d) F[k] = d[k]; });
    if ('timeUnknown' in d) F.timeUnknown = d.timeUnknown;
    if ('remindCustomer' in d) F.remindCustomer = d.remindCustomer;
  }
  function validate() {
    const sb = $('#sb'); clearErrors(sb);
    if (step === 0 && !F.customerId) {
      if (!F.cname) return fieldError(sb, 'cname', 'Please type the customer name, or search above'), false;
      let ph;
      try { ph = Store.normPhone(F.cphone, db.settings.cc); } catch (e) { return fieldError(sb, 'cphone', e.message), false; }
      const ex = db.customers.find(c => c.phone === ph);
      if (ex) { F.customerId = ex.id; toast(`Existing customer found: ${ex.name}`); }
    }
    if (step === 1) {
      if (!F.date) return fieldError(sb, 'date', 'Please choose the date'), false;
      if (!F.timeUnknown && !F.time) return fieldError(sb, 'time', 'Choose the time or tick “Time not fixed yet”'), false;
    }
    return true;
  }
  function bind() {
    const sb = $('#sb');
    $$('input, textarea', sb).forEach(el => el.addEventListener('input', setDirty));
    $('#back')?.addEventListener('click', () => { read(); step--; render(); window.scrollTo(0, 0); });
    $('#next')?.addEventListener('click', async () => {
      read();
      if (!validate()) return;
      if (step === 1 && F.date < todayISO() && !id && !(await confirmBox('Date is in the past', 'Are you recording an old event?', 'Yes, continue'))) return;
      if (step === 2 && !F.items.length && !(await confirmBox('No food added', 'You can add food later. Continue?', 'Continue'))) return;
      step++; render(); window.scrollTo(0, 0);
    });
    $('#save')?.addEventListener('click', () => { read(); save(); });
    // customer
    $('#chgCust')?.addEventListener('click', () => { F.customerId = null; render(); });
    const cs = $('#custSearch');
    if (cs) autocomplete(cs, qq => db.customers.map(c => ({ c, r: Math.min(...[matchRank(c.name, qq), c.phone.includes(qq.replace(/\D/g, '') || '§') ? 1 : -1].filter(x => x >= 0).concat(9)) }))
      .filter(x => x.r < 9).sort((a, b) => a.r - b.r).slice(0, 8).map(x => ({ label: x.c.name, sub: x.c.phone, value: x.c.id })),
      o => { F.customerId = o.value; setDirty(); render(); });
    // event
    $$('[data-type]', sb).forEach(b => b.onclick = () => { F.type = b.dataset.type; setDirty(); $$('[data-type]', sb).forEach(x => x.classList.toggle('on', x === b)); });
    $$('[data-status]', sb).forEach(b => b.onclick = () => { F.status = b.dataset.status; setDirty(); $$('[data-status]', sb).forEach(x => x.classList.toggle('on', x === b)); });
    $$('[data-g]', sb).forEach(b => b.onclick = () => { const i = $('[name=guests]', sb); i.value = Math.max(0, (+i.value || 0) + +b.dataset.g); setDirty(); });
    const tu = $('[name=timeUnknown]', sb);
    tu?.addEventListener('change', () => { $('[name=time]', sb).disabled = tu.checked; if (tu.checked) $('[name=time]', sb).value = ''; });
    const di = $('[name=date]', sb);
    const showDay = () => { read(); const s = sameDay(); $('#dayInfo').innerHTML = s.length ? `<div class="hint" style="color:var(--amber);font-weight:700">${icon('alert', 15)} ${s.length} other booking${s.length > 1 ? 's' : ''} this day: ${esc(s.map(b => `${b.title} ${b.time ? fmtTime(b.time) : ''}`).join(', '))}</div>` : (F.date ? `<div class="hint" style="color:var(--green)">${icon('check', 15)} Free day</div>` : ''); };
    if (di) { di.addEventListener('change', showDay); showDay(); }
    // food
    const fs = $('#foodSearch');
    if (fs) {
      autocomplete(fs, qq => {
        const found = db.items.filter(i => i.active !== false).map(i => ({ i, r: matchRank(i.name, qq) })).filter(x => x.r >= 0)
          .sort((a, b) => a.r - b.r || a.i.name.localeCompare(b.i.name)).slice(0, 8)
          .map(x => ({ label: x.i.name, sub: x.i.price ? money(x.i.price) : x.i.category, value: x.i.id }));
        if (!db.items.some(i => i.name.toLowerCase() === qq.toLowerCase())) found.push({ label: `Add “${qq}” as new item`, value: '__new', isNew: true, name: qq });
        return found;
      }, o => {
        let item;
        if (o.value === '__new') {
          const name = o.name.replace(/\b\w/g, ch => ch.toUpperCase());
          item = { id: Store.uid(), name, category: 'Other', diet: 'veg', price: 0, active: true };
          db.items.push(item); Store.save(); toast(`“${name}” added to Food Items`);
        } else item = db.items.find(i => i.id === o.value);
        if (F.items.some(x => x.itemId === item.id)) { toast('Already in the list'); fs.value = ''; return; }
        F.items.push({ itemId: item.id, name: item.name, qty: +F.guests || 0, unit: 'plates' });
        setDirty(); render(); $('#foodSearch').focus();
      });
    }
    $$('[data-qty]', sb).forEach(el => el.addEventListener('input', () => { F.items[+el.dataset.qty].qty = +el.value || 0; setDirty(); }));
    $$('[data-q]', sb).forEach(b => b.onclick = () => { const it = F.items[+b.dataset.q]; it.qty = Math.max(0, (+it.qty || 0) + +b.dataset.d); setDirty(); $(`[data-qty="${b.dataset.q}"]`, sb).value = it.qty; });
    $$('[data-rm]', sb).forEach(b => b.onclick = () => { F.items.splice(+b.dataset.rm, 1); setDirty(); render(); });
    $('#eqGuests')?.addEventListener('click', () => { F.items.forEach(i => { i.qty = +F.guests; }); setDirty(); render(); });
    $('#useEst')?.addEventListener('click', e => { e.preventDefault(); $('[name=total]', sb).value = estimate(); setDirty(); });
  }
  function save() {
    const now = Store.toISO(new Date());
    let cust = F.customerId && db.customers.find(c => c.id === F.customerId);
    if (!cust) {
      cust = { id: Store.uid(), name: F.cname, phone: Store.normPhone(F.cphone, db.settings.cc), address: '', notes: '', createdAt: now };
      db.customers.push(cust);
    }
    const data = {
      customerId: cust.id, type: F.type, title: F.title || `${F.type || 'Event'} - ${cust.name}`, date: F.date,
      time: F.timeUnknown ? '' : F.time, venue: F.venue, guests: +F.guests || 0, status: F.status, special: F.special,
      notes: F.notes, items: F.items.filter(i => i.name), total: +F.total || 0, remindCustomer: F.remindCustomer,
    };
    let b;
    if (src) {
      b = src;
      const moved = b.date !== data.date || b.time !== data.time;
      const wasStatus = b.status;
      Object.assign(b, data); touch(b);
      if (moved) { delete b.reconfirmedAt; delete b.reconfirmedBy; }
      if (b.status === 'confirmed' && wasStatus === 'enquiry') Store.queueOneOff(b, 'confirm');
      else if (b.status === 'confirmed' && moved) Store.queueOneOff(b, 'changed');
      commit(`edited ${b.title}${moved ? ' (date/time changed)' : ''}`, b.id);
    } else {
      b = { id: Store.uid(), ...data, payments: [], createdAt: now, createdBy: ME.name, updatedAt: now, updatedBy: ME.name };
      if (+F.advance > 0) b.payments.push({ id: Store.uid(), amount: +F.advance, date: todayISO(), mode: 'Cash' });
      db.bookings.push(b);
      if (b.status === 'confirmed') Store.queueOneOff(b, 'confirm');
      commit(`added booking ${b.title}`, b.id);
    }
    DIRTY = false;
    toast(src ? 'Changes saved' : 'Booking saved');
    location.hash = `#/b/${b.id}`;
  }
  render();
}

/* ---------- start */
function start() {
  Store.load();
  const uidS = localStorage.getItem(SESSION);
  ME = DB().users.find(u => u.id === uidS && u.active !== false) || null;
  if (!ME) return renderLogin();
  Store.sync(); Store.save();
  renderShell();
  lastHash = location.hash || '#/';
  route();
  clearInterval(start.t);
  start.t = setInterval(() => { Store.sync(); Store.save(); refreshBadges(); autoSend(); }, 60000);
  autoSend();
}
start();

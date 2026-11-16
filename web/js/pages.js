'use strict';
/* Calendar, customers, food items, WhatsApp, settings. */

/* ---------- calendar */
function pageCalendar(q = {}) {
  const base = q.m ? parseD(q.m + '-01') : new Date();
  const first = new Date(base.getFullYear(), base.getMonth(), 1);
  const start = new Date(first); start.setDate(1 - first.getDay());
  let sel = q.d || (q.m ? isoDate(first) : todayISO());
  const byDay = {};
  live().filter(b => b.status !== 'cancelled').forEach(b => (byDay[b.date] = byDay[b.date] || []).push(b));
  Object.values(byDay).forEach(a => a.sort(byStart));
  const ym = d => `${d.getFullYear()}-${Store.pad(d.getMonth() + 1)}`;
  const prev = new Date(first.getFullYear(), first.getMonth() - 1, 1), next = new Date(first.getFullYear(), first.getMonth() + 1, 1);
  const cls = b => b.status === 'enquiry' ? 'enq' : b.status === 'completed' || Store.urgency(b) === 'over' ? 'grey' : ({ red: 'red', amber: 'amber' }[Store.urgency(b)] || '');
  const draw = () => {
    let cells = '';
    const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    const cellsN = Math.ceil((first.getDay() + lastDay.getDate()) / 7) * 7;
    for (let i = 0; i < cellsN; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const k = isoDate(d), evs = byDay[k] || [];
      cells += `<button class="day ${d.getMonth() !== first.getMonth() ? 'other' : ''} ${k === todayISO() ? 'today' : ''} ${k === sel ? 'sel' : ''}" data-day="${k}">
        <span class="n">${d.getDate()}</span>
        ${evs.slice(0, 2).map(b => `<span class="ev ${cls(b)}"><span class="l1"><b>${b.time ? fmtTime(b.time) : 'Time ?'}</b> · ${esc(b.title)}</span><span class="who">${esc(custOf(b).name)} · ${b.guests || 0} guests</span></span>`).join('')}
        ${evs.length > 2 ? `<span class="more">+${evs.length - 2} more</span>` : ''}
        <span class="dots">${evs.slice(0, 4).map(b => `<i class="${cls(b) === 'enq' ? 'grey' : cls(b)}"></i>`).join('')}</span>
      </button>`;
    }
    const dayEvs = byDay[sel] || [];
    $('#view').innerHTML = `
      <div class="page-head"><h1>${icon('calendar', 26)} Calendar</h1></div>
      <div class="row between" style="margin-bottom:.7rem;flex-wrap:nowrap">
        <a class="btn icon" href="#/calendar?m=${ym(prev)}" aria-label="Previous month">${icon('chevL')}</a>
        <h2>${first.toLocaleString('en-IN', { month: 'long', year: 'numeric' })}</h2>
        <a class="btn icon" href="#/calendar?m=${ym(next)}" aria-label="Next month">${icon('chevR')}</a></div>
      <div class="cal">${DAYS.map(d => `<div class="dow">${d}</div>`).join('')}${cells}</div>
      <div class="section"><div class="section-head"><h2>${fmtDate(sel)}</h2>
        <a class="btn sm accent" href="#/new?date=${sel}">${icon('plus', 18)} Book this day</a></div>
        ${dayEvs.length ? `<div class="list">${dayEvs.map(bkRow).join('')}</div>` : '<div class="list"><div class="empty">No bookings on this day</div></div>'}</div>`;
    $$('[data-day]').forEach(b => b.onclick = () => { sel = b.dataset.day; draw(); if (!matchMedia('(min-width: 900px)').matches) $('.section').scrollIntoView({ behavior: 'smooth' }); });
  };
  draw();
}

/* ---------- customers */
function customerModal(c, after) {
  const v = c || { name: '', phone: '', address: '', notes: '' };
  const m = openModal(`<h2>${icon(c ? 'edit' : 'userPlus')} ${c ? 'Edit customer' : 'Add customer'}</h2><div id="cf">
    <div class="field"><label class="f">Name</label><input name="name" value="${esc(v.name)}"></div>
    <div class="field"><label class="f">Phone (WhatsApp)</label><input name="phone" type="tel" inputmode="tel" value="${esc(v.phone)}"></div>
    <div class="field"><label class="f">Address <span class="muted small">(optional)</span></label><input name="address" value="${esc(v.address || '')}"></div>
    <div class="field"><label class="f">Notes <span class="muted small">(optional)</span></label><input name="notes" value="${esc(v.notes || '')}"></div></div>
    <div class="mfoot"><button class="btn lg" data-close>Cancel</button><button class="btn lg primary" id="saveC">${icon('check')} Save</button></div>`);
  $('#saveC', m.el).onclick = () => {
    const box = $('#cf', m.el); clearErrors(box);
    const d = formData(box);
    if (!d.name) return fieldError(box, 'name', 'Please type the name');
    let phone;
    try { phone = Store.normPhone(d.phone, DB().settings.cc); } catch (e) { return fieldError(box, 'phone', e.message); }
    const dup = DB().customers.find(x => x.phone === phone && x !== c);
    if (dup) return fieldError(box, 'phone', `This number belongs to ${dup.name}`);
    if (c) Object.assign(c, { name: d.name, phone, address: d.address, notes: d.notes });
    else { c = { id: Store.uid(), name: d.name, phone, address: d.address, notes: d.notes, createdAt: Store.toISO(new Date()) }; DB().customers.push(c); }
    commit(`${v.name ? 'edited' : 'added'} customer ${d.name}`);
    m.close(); toast('Customer saved'); after && after(c);
  };
}
function pageCustomers() {
  let text = '';
  $('#view').innerHTML = `
    <div class="page-head"><h1>${icon('users', 26)} Customers</h1><button class="btn accent" id="addC">${icon('userPlus')} Add customer</button></div>
    <div class="field"><input id="cq" type="search" placeholder="Search name or phone"></div>
    <div id="cl"></div>`;
  const draw = () => {
    const s = text.toLowerCase();
    const list = DB().customers.filter(c => !s || c.name.toLowerCase().includes(s) || c.phone.includes(s.replace(/\D/g, '') || '§'))
      .sort((a, b) => a.name.localeCompare(b.name));
    $('#cl').innerHTML = list.length ? `<div class="list">${list.map(c => {
      const n = live().filter(b => b.customerId === c.id).length;
      return `<a class="att" href="#/c/${c.id}" style="color:inherit;text-decoration:none"><span class="ico blue">${icon('user', 20)}</span>
        <div class="txt"><b class="ellipsis">${esc(c.name)}</b><span class="small muted">${esc(c.phone)}</span></div>
        <span class="pill p-grey">${n} booking${n === 1 ? '' : 's'}</span>${icon('chevR', 20)}</a>`;
    }).join('')}</div>` : `<div class="list"><div class="empty">No customers yet</div></div>`;
  };
  draw();
  $('#cq').addEventListener('input', e => { text = e.target.value.trim(); draw(); });
  $('#addC').onclick = () => customerModal(null, c => { location.hash = `#/c/${c.id}`; });
}
function pageCustomer(id) {
  const c = DB().customers.find(x => x.id === id);
  if (!c) { location.hash = '#/customers'; return; }
  const bks = live().filter(b => b.customerId === id).sort(byStart).reverse();
  $('#view').innerHTML = `
    <a class="btn sm ghost" href="#/customers" style="margin-bottom:.8rem">${icon('left', 20)} Customers</a>
    <div class="card"><div class="pad"><h1>${esc(c.name)}</h1><p class="muted" style="margin:.2rem 0 0">${esc(c.phone)}${c.address ? ' · ' + esc(c.address) : ''}</p>
      ${c.notes ? `<p class="small">${esc(c.notes)}</p>` : ''}</div>
      <div class="pad actions-bar" style="border-top:1px solid var(--line)">
        <a class="btn" href="tel:${esc(c.phone)}">${icon('phone')} Call</a>
        <a class="btn wa" target="_blank" rel="noopener" href="https://wa.me/${esc(c.phone.replace(/\D/g, ''))}">${icon('chat')} WhatsApp</a>
        <button class="btn" id="editC">${icon('edit')} Edit</button>
        <a class="btn accent" href="#/new?customer=${c.id}">${icon('plus')} New booking</a></div></div>
    <div class="section"><div class="section-head"><h2>Bookings</h2><span class="small muted">${bks.length}</span></div>${listOrEmpty(bks, 'No bookings yet')}</div>`;
  $('#editC').onclick = () => customerModal(c, () => pageCustomer(id));
}

/* ---------- food items */
function itemModal(it) {
  const v = it || { name: '', category: '', diet: 'veg', price: '' };
  const cats = [...new Set(DB().items.map(i => i.category).filter(Boolean))].sort();
  let diet = v.diet || 'veg';
  const m = openModal(`<h2>${icon(it ? 'edit' : 'plus')} ${it ? 'Edit food item' : 'Add food item'}</h2><div id="itf">
    <div class="field"><label class="f">Name</label><input name="name" value="${esc(v.name)}" placeholder="e.g. Veg Biryani"></div>
    <div class="field"><label class="f">Category</label><input name="category" list="cats" value="${esc(v.category || '')}" placeholder="Main course, Dessert…">
      <datalist id="cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
    <div class="field"><label class="f">Type</label><div class="seg"><button type="button" data-diet="veg" class="${diet === 'veg' ? 'on' : ''}">🟢 Veg</button><button type="button" data-diet="non-veg" class="${diet === 'non-veg' ? 'on' : ''}">🔴 Non-veg</button></div></div>
    <div class="field"><label class="f">Price per plate (A$) <span class="muted small">(optional)</span></label><input name="price" type="number" inputmode="decimal" min="0" value="${esc(v.price)}"></div></div>
    <div class="mfoot">${it ? `<button class="btn lg danger" id="delI">${icon('trash')}</button>` : `<button class="btn lg" data-close>Cancel</button>`}
      <button class="btn lg primary" id="saveI">${icon('check')} Save</button></div>`);
  $$('[data-diet]', m.el).forEach(b => b.onclick = () => { diet = b.dataset.diet; $$('[data-diet]', m.el).forEach(x => x.classList.toggle('on', x === b)); });
  $('#saveI', m.el).onclick = () => {
    const box = $('#itf', m.el); clearErrors(box);
    const d = formData(box);
    if (!d.name) return fieldError(box, 'name', 'Please type the item name');
    const dup = DB().items.find(i => i.name.toLowerCase() === d.name.toLowerCase() && i !== it && i.active !== false);
    if (dup) return fieldError(box, 'name', 'This item already exists');
    const data = { name: d.name, category: d.category || 'Other', diet, price: +d.price || 0, active: true };
    if (it) Object.assign(it, data); else DB().items.push({ id: Store.uid(), ...data });
    commit(`${it ? 'edited' : 'added'} food item ${d.name}`);
    m.close(); toast('Saved'); pageItems();
  };
  $('#delI', m.el)?.addEventListener('click', async () => {
    m.close();
    if (!(await confirmBox('Remove this item?', 'Old bookings keep it. It will not be suggested any more.', 'Remove', true))) return;
    it.active = false; commit(`removed food item ${it.name}`); toast('Removed'); pageItems();
  });
}
function pageItems() {
  let text = '';
  $('#view').innerHTML = `
    <div class="page-head"><h1>${icon('tag', 26)} Food Items</h1><button class="btn accent" id="addI">${icon('plus')} Add item</button></div>
    <div class="field"><input id="iq" type="search" placeholder="Search food"></div><div id="il"></div>`;
  const draw = () => {
    const s = text.toLowerCase();
    const items = DB().items.filter(i => i.active !== false && (!s || i.name.toLowerCase().includes(s)));
    const groups = {};
    items.sort((a, b) => a.name.localeCompare(b.name)).forEach(i => (groups[i.category || 'Other'] = groups[i.category || 'Other'] || []).push(i));
    $('#il').innerHTML = items.length ? Object.keys(groups).sort().map(g => `<div><div class="section-head" style="margin-top:1rem"><h2 class="small muted" style="text-transform:uppercase">${esc(g)}</h2></div>
      <div class="list">${groups[g].map(i => `<button class="item-line" data-id="${i.id}" style="width:100%;border:0;background:none;font:inherit;cursor:pointer;text-align:left;min-height:52px;align-items:center">
        <span>${i.diet === 'non-veg' ? '🔴' : '🟢'} ${esc(i.name)}</span><span class="row" style="gap:.4rem"><b>${i.price ? money(i.price) : ''}</b>${icon('chevR', 18)}</span></button>`).join('')}</div></div>`).join('')
      : '<div class="list"><div class="empty">No items</div></div>';
    $$('[data-id]', $('#il')).forEach(b => b.onclick = () => itemModal(DB().items.find(i => i.id === b.dataset.id)));
  };
  draw();
  $('#iq').addEventListener('input', e => { text = e.target.value.trim(); draw(); });
  $('#addI').onclick = () => itemModal(null);
}

/* ---------- WhatsApp: two buttons only */
const ROLE_NAME = { owner: 'Owner', staff: 'Staff', cook: 'Cook', other: 'Other' };
function pageWhatsApp() {
  const due = Store.dueNotes();
  const auto = DB().settings.waAuto;
  $('#view').innerHTML = `
    <div class="card wa-hero">
      <div class="big">${icon('chat', 38)}</div>
      <h1>WhatsApp</h1>
      <p class="muted" style="margin:.4rem 0 0">${due.length ? `<b style="color:var(--red)">${due.length} message${due.length > 1 ? 's' : ''} ready to send</b>` : `${icon('check', 18)} All messages are sent`}</p>
      <p class="small muted" style="margin:.3rem 0 0">${DB().waNumbers.length} number${DB().waNumbers.length === 1 ? '' : 's'} get team alerts · ${auto ? 'Sending automatically' : 'Tap Send to send'}</p>
      <div class="wa-btns">
        <button class="btn" id="waNums">${icon('userPlus', 26)} Add numbers</button>
        <button class="btn wa" id="waSend">${icon('send', 26)} Send notifications${due.length ? ` (${due.length})` : ''}</button>
      </div>
    </div>`;
  $('#waNums').onclick = numbersModal;
  $('#waSend').onclick = sendNotifications;
}
function numbersModal() {
  let role = 'staff';
  const m = openModal(`<h2>${icon('userPlus')} Numbers for alerts</h2>
    <p class="small muted" style="margin-top:-.5rem">These people get the 2-day warning and the event-day message for every booking. Owners also get alerts when a customer is not re-confirmed.</p>
    <div class="list" id="numList"></div>
    <div id="nf" style="margin-top:1rem">
      <div class="grid2"><div class="field"><label class="f">Name</label><input name="name"></div>
      <div class="field"><label class="f">WhatsApp number</label><input name="phone" type="tel" inputmode="tel"></div></div>
      <div class="seg" style="margin-bottom:.8rem">${Object.entries(ROLE_NAME).map(([k, l]) => `<button type="button" data-role="${k}" class="${k === role ? 'on' : ''}">${l}</button>`).join('')}</div>
      <button class="btn primary block lg" id="addNum">${icon('plus')} Add number</button></div>
    <div class="mfoot"><button class="btn lg" data-close>Done</button></div>`, { onClose: () => route() });
  const draw = () => {
    $('#numList', m.el).innerHTML = DB().waNumbers.map(n => `<div class="att"><span class="ico green">${icon('chat', 20)}</span><div class="txt"><b>${esc(n.name)}</b><span class="small muted">${esc(n.phone)} · ${ROLE_NAME[n.role] || n.role}</span></div>
      <button class="btn icon danger" data-del="${n.id}" title="Remove">${icon('trash', 18)}</button></div>`).join('') || '<div class="empty">No numbers yet</div>';
    $$('[data-del]', m.el).forEach(b => b.onclick = () => { DB().waNumbers = DB().waNumbers.filter(n => n.id !== b.dataset.del); commit('removed a WhatsApp alert number'); draw(); });
  };
  draw();
  $$('[data-role]', m.el).forEach(b => b.onclick = () => { role = b.dataset.role; $$('[data-role]', m.el).forEach(x => x.classList.toggle('on', x === b)); });
  $('#addNum', m.el).onclick = () => {
    const box = $('#nf', m.el); clearErrors(box);
    const d = formData(box);
    if (!d.name) return fieldError(box, 'name', 'Please type a name');
    let phone;
    try { phone = Store.normPhone(d.phone, DB().settings.cc); } catch (e) { return fieldError(box, 'phone', e.message); }
    if (DB().waNumbers.some(n => n.phone === phone)) return fieldError(box, 'phone', 'This number is already added');
    DB().waNumbers.push({ id: Store.uid(), name: d.name, phone, role });
    commit(`added WhatsApp number for ${d.name}`);
    $$('input', box).forEach(i => { i.value = ''; });
    toast('Number added'); draw();
  };
}
async function postWA(n, text) {
  const r = await fetch('/api/send-whatsapp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-key': DB().settings.waKey || '' },
    body: JSON.stringify({ to: n.to, text }),
  });
  if ([404, 405, 501].includes(r.status)) return 'unavailable';
  if (!r.ok) { let e = ''; try { e = (await r.json()).error; } catch (x) { /* */ } throw new Error(e || `Error ${r.status}`); }
  return 'sent';
}
/** Background “agent”: when automatic sending is connected, due messages go out by themselves. */
let sending = false;
async function autoSend() {
  if (!DB().settings.waAuto || sending) return;
  sending = true;
  try {
    for (const n of Store.dueNotes()) {
      try { if (await postWA(n, Store.buildMessage(n)) !== 'sent') { DB().settings.waAuto = false; break; } Store.markSent(n.id, 'auto'); }
      catch (e) { n.error = e.message; }
    }
    Store.save(); refreshBadges();
  } finally { sending = false; }
}
async function sendNotifications() {
  Store.sync(); Store.save();
  const due = Store.dueNotes();
  if (!due.length) return toast('Nothing to send — all done');
  // try automatic sending first
  try {
    const first = await postWA(due[0], Store.buildMessage(due[0]));
    if (first === 'sent') {
      Store.markSent(due[0].id, 'auto');
      DB().settings.waAuto = true;
      let ok = 1;
      for (const n of due.slice(1)) { try { if (await postWA(n, Store.buildMessage(n)) === 'sent') { Store.markSent(n.id, 'auto'); ok++; } } catch (e) { n.error = e.message; } }
      Store.save(); refreshBadges(); toast(`${ok} message${ok > 1 ? 's' : ''} sent`); pageWhatsApp(); return;
    }
  } catch (e) { toast('Automatic sending failed: ' + e.message + ' — send by hand', 'err'); }
  // manual: one tap per message opens WhatsApp with the text ready
  let i = 0;
  const m = openModal('<div id="mm"></div>', { onClose: () => { Store.save(); refreshBadges(); route(); } });
  const draw = () => {
    if (i >= due.length) { $('#mm', m.el).innerHTML = `<div class="wa-hero"><div class="big">${icon('check', 38)}</div><h2 style="justify-content:center">All done</h2></div><div class="mfoot"><button class="btn lg primary" data-close2>Close</button></div>`; $('[data-close2]', m.el).onclick = m.close; return; }
    const n = due[i], text = Store.buildMessage(n), b = DB().bookings.find(x => x.id === n.bookingId);
    $('#mm', m.el).innerHTML = `<p class="step-title">Message ${i + 1} of ${due.length}</p>
      <h2 style="margin:.3rem 0 .2rem">To ${esc(n.name)} <span class="pill p-grey">${n.role === 'customer' ? 'Customer' : ROLE_NAME[n.role] || 'Team'}</span></h2>
      <p class="small muted" style="margin:0 0 .7rem">${esc(Store.KIND_LABEL[n.kind] || '')} · ${esc(b ? b.title : '')}</p>
      <div class="msg-preview">${esc(text)}</div>
      <a class="btn wa lg block" style="margin-top:1rem" target="_blank" rel="noopener" id="go" href="${esc(Store.waLink(n.to, text))}">${icon('send')} Send on WhatsApp</a>
      <div class="mfoot"><button class="btn" id="skip">Skip</button><button class="btn" data-close>Stop</button></div>`;
    $('#go', m.el).onclick = () => { Store.markSent(n.id, 'manual'); Store.save(); i++; setTimeout(draw, 300); };
    $('#skip', m.el).onclick = () => { i++; draw(); };
  };
  draw();
}

/* ---------- settings */
function pageSettings() {
  const db = DB(), owner = ME.role === 'owner';
  $('#view').innerHTML = `<div class="narrow">
    <div class="page-head"><h1>${icon('settings', 26)} Settings</h1></div>
    ${owner ? `<div class="card pad"><h2 style="margin-bottom:.8rem">Business</h2><div id="bf" class="grid2">
      <div class="field"><label class="f">Business name</label><input name="name" value="${esc(db.business.name)}"></div>
      <div class="field"><label class="f">Business phone <span class="muted small">(shown in messages)</span></label><input name="phone" type="tel" value="${esc(db.business.phone)}"></div></div>
      <div class="field"><label class="f">Phone numbers are from</label><div class="seg">
        <button type="button" data-cc="61" class="${db.settings.cc !== '91' ? 'on' : ''}">Australia (+61)</button>
        <button type="button" data-cc="91" class="${db.settings.cc === '91' ? 'on' : ''}">India (+91)</button></div>
        <div class="hint">Used when a number is typed without a country code.</div></div>
      <button class="btn primary" id="saveBiz">${icon('check')} Save</button></div>

    <div class="section card pad"><h2 style="margin-bottom:.4rem">${icon('wallet')} Currency</h2>
      <p class="small muted" style="margin:0 0 .8rem">All prices and payments are in <b>Australian dollars (A$)</b>. The rate is used to show the rupee value on each booking.</p>
      <div class="row" style="align-items:flex-end">
        <div class="field" style="margin:0;flex:1;min-width:180px"><label class="f">1 A$ = ₹</label><input id="rate" type="number" step="0.01" min="0" inputmode="decimal" value="${esc(db.settings.inrPerAud)}"></div>
        <button class="btn" id="liveRate">${icon('undo')} Get today’s rate</button>
        <button class="btn primary" id="saveRate">${icon('check')} Save rate</button></div>
      <p class="hint" id="rateInfo">Last updated ${db.settings.rateDate ? fmtDate(db.settings.rateDate) : ''}</p></div>

    <div class="section"><div class="section-head"><h2>${icon('users')} Team logins</h2><button class="btn sm accent" id="addU">${icon('userPlus', 18)} Add person</button></div>
      <div class="list">${db.users.map(u => `<div class="att"><span class="ico blue">${icon('user', 20)}</span><div class="txt"><b>${esc(u.name)}${u.id === ME.id ? ' (you)' : ''}</b>
        <span class="small muted">${esc(u.phone)} · ${u.role === 'owner' ? 'Owner' : 'Staff'}${u.active === false ? ' · removed' : ''}</span></div>
        ${u.id !== ME.id ? `<button class="btn sm" data-u="${u.id}">${icon('edit', 18)}</button>` : ''}</div>`).join('')}</div></div>` : ''}

    <div class="section card pad"><h2 style="margin-bottom:.8rem">${icon('lock')} My password</h2><div id="pf" class="grid2">
      <div class="field"><label class="f">Current password</label><input name="old" type="password"></div>
      <div class="field"><label class="f">New password</label><input name="new" type="password"></div></div>
      <button class="btn primary" id="savePw">${icon('check')} Change password</button></div>

    <div class="section card pad"><h2 style="margin-bottom:.4rem">${icon('download')} Backup</h2>
      <p class="small muted" style="margin:0 0 .8rem">All data is saved on this device only. Download a backup every week, and use it to move data to another phone or computer.</p>
      <div class="actions-bar"><button class="btn primary" id="exp">${icon('download')} Download backup</button>
        <label class="btn">${icon('upload')} Restore backup<input type="file" id="imp" accept=".json,application/json" hidden></label>
        ${owner && db.bookings.some(b => b.sample) ? `<button class="btn danger" id="clrS">${icon('trash')} Remove examples</button>` : ''}</div></div>

    ${owner ? `<div class="section card pad"><h2 style="margin-bottom:.4rem">${icon('chat')} Automatic WhatsApp (later)</h2>
      <p class="small muted" style="margin:0 0 .8rem">When the WhatsApp Business account is connected on the server, enter the app key here. Until then, messages are sent with one tap from the WhatsApp page.</p>
      <div class="field"><label class="f">App key</label><input id="waKey" value="${esc(db.settings.waKey || '')}" autocomplete="off"></div>
      <button class="btn" id="saveKey">${icon('check')} Save key</button></div>` : ''}</div>`;

  let cc = db.settings.cc || '61';
  $$('[data-cc]').forEach(b => b.onclick = () => { cc = b.dataset.cc; $$('[data-cc]').forEach(x => x.classList.toggle('on', x === b)); });
  $('#liveRate')?.addEventListener('click', async ev => {
    const btn = ev.currentTarget; btn.disabled = true;
    try {
      const j = await (await fetch('https://open.er-api.com/v6/latest/AUD')).json();
      if (!j.rates || !j.rates.INR) throw new Error('no rate');
      $('#rate').value = Math.round(j.rates.INR * 100) / 100;
      $('#rateInfo').textContent = `Today’s rate: 1 A$ = ₹${$('#rate').value} — press Save rate to keep it`;
    } catch (e) { toast('Could not get the rate. Check the internet and try again.', 'err'); }
    btn.disabled = false;
  });
  $('#saveRate')?.addEventListener('click', () => {
    const r = +$('#rate').value;
    if (!(r > 0)) return toast('Please type a valid rate', 'err');
    db.settings.inrPerAud = r; db.settings.rateDate = todayISO(); commit(`set rate 1 A$ = ₹${r}`); toast('Rate saved'); pageSettings();
  });
  $('#saveBiz')?.addEventListener('click', () => {
    const box = $('#bf'); clearErrors(box);
    const d = formData(box);
    if (!d.name) return fieldError(box, 'name', 'Business name is required');
    let phone = '';
    if (d.phone) { try { phone = Store.normPhone(d.phone, db.settings.cc); } catch (e) { return fieldError(box, 'phone', e.message); } }
    db.business.name = d.name; db.business.phone = phone; db.settings.cc = cc;
    commit('changed business details'); toast('Saved'); renderShell(); route();
  });
  $('#addU')?.addEventListener('click', () => userModal(null));
  $$('[data-u]').forEach(b => b.onclick = () => userModal(db.users.find(u => u.id === b.dataset.u)));
  $('#savePw').onclick = async () => {
    const box = $('#pf'); clearErrors(box);
    const d = formData(box);
    if (await Store.hashPass(ME.phone, d.old) !== ME.pass) return fieldError(box, 'old', 'Current password is wrong');
    if (d.new.length < 4) return fieldError(box, 'new', 'At least 4 characters');
    ME.pass = await Store.hashPass(ME.phone, d.new); commit('changed own password'); toast('Password changed'); $$('input', box).forEach(i => { i.value = ''; });
  };
  $('#exp').onclick = () => {
    const blob = new Blob([JSON.stringify(db, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `catering-backup-${todayISO()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000); toast('Backup downloaded');
  };
  $('#imp').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    if (!(await confirmBox('Restore this backup?', 'Everything on this device will be replaced by the backup.', 'Restore', true))) return;
    try { Store.replaceAll(JSON.parse(await file.text())); toast('Backup restored'); start(); } catch (er) { toast(er.message, 'err'); }
  };
  $('#clrS')?.addEventListener('click', async () => {
    if (!(await confirmBox('Remove example bookings?', 'Only the 4 example bookings and their customers are removed.', 'Remove', true))) return;
    db.bookings = db.bookings.filter(b => !b.sample); db.customers = db.customers.filter(c => !c.sample);
    commit('removed example bookings'); toast('Examples removed'); pageSettings();
  });
  $('#saveKey')?.addEventListener('click', () => { db.settings.waKey = $('#waKey').value.trim(); db.settings.waAuto = false; commit('changed WhatsApp key'); toast('Saved'); });
}
function userModal(u) {
  let role = u ? u.role : 'staff';
  const m = openModal(`<h2>${icon(u ? 'edit' : 'userPlus')} ${u ? 'Edit ' + esc(u.name) : 'Add person'}</h2><div id="uf">
    <div class="field"><label class="f">Name</label><input name="name" value="${esc(u ? u.name : '')}"></div>
    <div class="field"><label class="f">Phone number</label><input name="phone" type="tel" inputmode="tel" value="${esc(u ? u.phone : '')}" ${u ? 'disabled' : ''}></div>
    <div class="field"><label class="f">Login as</label><div class="seg"><button type="button" data-r="owner" class="${role === 'owner' ? 'on' : ''}">Owner</button><button type="button" data-r="staff" class="${role === 'staff' ? 'on' : ''}">Staff</button></div></div>
    <div class="field"><label class="f">${u ? 'New password (leave empty to keep)' : 'Password'}</label><input name="pass" type="text" autocomplete="off"></div>
    ${u ? `<label class="check"><input type="checkbox" name="active" ${u.active !== false ? 'checked' : ''}> Can log in</label>` : ''}</div>
    <div class="mfoot"><button class="btn lg" data-close>Cancel</button><button class="btn lg primary" id="saveU">${icon('check')} Save</button></div>`);
  $$('[data-r]', m.el).forEach(b => b.onclick = () => { role = b.dataset.r; $$('[data-r]', m.el).forEach(x => x.classList.toggle('on', x === b)); });
  $('#saveU', m.el).onclick = async () => {
    const box = $('#uf', m.el); clearErrors(box);
    const d = formData(box);
    if (!d.name) return fieldError(box, 'name', 'Please type the name');
    if (u) {
      u.name = d.name; u.role = role; u.active = d.active;
      if (d.pass) { if (d.pass.length < 4) return fieldError(box, 'pass', 'At least 4 characters'); u.pass = await Store.hashPass(u.phone, d.pass); }
    } else {
      let phone;
      try { phone = Store.normPhone(d.phone, DB().settings.cc); } catch (e) { return fieldError(box, 'phone', e.message); }
      if (DB().users.some(x => x.phone === phone)) return fieldError(box, 'phone', 'This number already has a login');
      if (d.pass.length < 4) return fieldError(box, 'pass', 'At least 4 characters');
      DB().users.push({ id: Store.uid(), name: d.name, phone, role, pass: await Store.hashPass(phone, d.pass), active: true });
    }
    commit(`${u ? 'edited' : 'added'} login for ${d.name}`); m.close(); toast('Saved'); pageSettings();
  };
}

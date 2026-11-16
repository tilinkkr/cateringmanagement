'use strict';
/* Booking wizard (new + edit) and booking detail page. */

const EVENT_TYPES = ['Wedding', 'Engagement', 'Reception', 'Birthday', 'House Warming', 'Corporate', 'Religious / Pooja', 'Memorial', 'Other'];
const ROLES = { customer: 'Customer', staff: 'Cook / Staff', helper: 'Helper', supplier: 'Supplier', owner: 'Owner', driver: 'Driver', other: 'Other' };
const DIETS = { '': '—', veg: 'Veg', 'non-veg': 'Non-veg', egg: 'Egg', jain: 'Jain' };
const PAY_MODES = ['Cash', 'UPI', 'Bank transfer', 'Cheque', 'Card'];
const STEP_NAMES = ['Customer', 'Event', 'Food', 'Reminders & Payment', 'Check & Save'];

/* ---------- reminder schedule preview (same rules as the server) */
function parseOffsetsJS(spec) {
  const out = {};
  (spec || '').split(',').forEach(p => {
    const m = p.trim().toLowerCase().match(/^(\d+)\s*([dh])$/);
    if (m && +m[1] > 0) out[`before_${m[1]}${m[2]}`] = (+m[1]) * (m[2] === 'd' ? 1440 : 60);
  });
  if (!out.before_2d) out.before_2d = 2880;
  return Object.entries(out).sort((a, b) => b[1] - a[1]);
}
function offsetLabel(k) {
  if (k === 'before_2d') return '2 days before — WARNING';
  const m = k.match(/before_(\d+)([dh])/);
  const n = +m[1];
  return `${n} ${m[2] === 'd' ? (n === 1 ? 'day' : 'days') : (n === 1 ? 'hour' : 'hours')} before`;
}
function hm(s) { const [h, m] = (s || '0:0').split(':').map(Number); return h * 60 + m; }
function shiftQuiet(dt, qsS, qeS) {
  const qs = hm(qsS), qe = hm(qeS);
  if (qs === qe) return dt;
  const t = dt.getHours() * 60 + dt.getMinutes();
  const inQ = qs > qe ? (t >= qs || t < qe) : (qs <= t && t < qe);
  if (!inQ) return dt;
  const day = new Date(dt);
  if (qs > qe && t < qe) day.setDate(day.getDate() - 1);
  day.setHours(0, qs - 30, 0, 0);
  return day;
}
function schedulePreview(date, time) {
  if (!date) return [];
  const s = S.cfg.settings;
  const start = parseD(date);
  const [h, m] = (time || '12:00').split(':').map(Number);
  start.setHours(h, m, 0, 0);
  const now = new Date();
  const list = parseOffsetsJS(s.reminder_offsets).map(([k, mins]) => {
    const due = shiftQuiet(new Date(start.getTime() - mins * 60000), s.quiet_start, s.quiet_end);
    return { k, label: offsetLabel(k), due, past: due <= now };
  });
  const overdue = list.filter(x => x.past);
  if (overdue.length) overdue[overdue.length - 1].sendNow = true;
  return list;
}

/* ---------- wizard */
function blankDraft() {
  return {
    customer: { name: '', phone: '', alt_phone: '', address: '' }, event_type: '', title: '', event_date: '', end_date: '',
    multi_day: false, event_time: '', time_unknown: false, venue: '', venue_map: '', guest_count: '', status: 'confirmed',
    assigned_staff_id: '', extra: {}, special_instructions: '', notes: '',
    items: [{ item_name: '', quantity: '', unit: 'plates', diet: '', notes: '' }],
    contacts: [], remind_customer: S.cfg.settings.remind_customer === '1',
    total_amount: '', advance_amount: '', advance_mode: 'Cash', allow_past: false,
  };
}

async function pageWizard(eid, q = {}) {
  let W = { step: 0, draft: blankDraft(), eid, version: null, maxStep: 0, dateInfo: null, found: null };
  if (eid) {
    const e = await api('GET', `/api/events/${eid}`);
    if (e.deleted_at) throw new ApiErr('This booking is deleted. Restore it first.');
    const custC = e.contacts.find(c => c.role === 'customer' && c.phone === e.customer_phone);
    Object.assign(W.draft, {
      customer: { name: e.customer_name, phone: e.customer_phone, alt_phone: e.customer_alt_phone || '', address: e.customer_address || '' },
      event_type: e.event_type || '', title: e.title, event_date: e.event_date, end_date: e.end_date || '', multi_day: !!e.end_date,
      event_time: e.event_time || '', time_unknown: !e.event_time, venue: e.venue || '', venue_map: e.venue_map || '',
      guest_count: e.guest_count, status: e.status, assigned_staff_id: e.assigned_staff_id || '', extra: e.extra || {},
      special_instructions: e.special_instructions || '', notes: e.notes || '',
      items: e.items.length ? e.items.map(i => ({ item_name: i.item_name, quantity: i.quantity, unit: i.unit, diet: i.diet || '', notes: i.notes || '', menu_item_id: i.menu_item_id })) : blankDraft().items,
      contacts: e.contacts.filter(c => c !== custC).map(c => ({ name: c.name, phone: c.phone, role: c.role })),
      remind_customer: !!custC, total_amount: e.total_amount || '',
    });
    W.version = e.version; W.maxStep = 4; W.paid = e.paid;
  } else {
    let pre = null;
    try { pre = JSON.parse(sessionStorage.getItem('cm.prefill') || 'null'); sessionStorage.removeItem('cm.prefill'); } catch (e) { pre = null; }
    if (pre) {
      const custC = (pre.contacts || []).find(c => c.role === 'customer');
      Object.assign(W.draft, pre, {
        customer: { ...W.draft.customer, ...(pre.customer || {}) },
        items: pre.items?.length ? pre.items : W.draft.items,
        contacts: (pre.contacts || []).filter(c => c !== custC),
        remind_customer: pre.contacts ? !!custC : W.draft.remind_customer,
        time_unknown: pre.event_time === null, event_date: '',
      });
    }
    if (q.date) W.draft.event_date = q.date;
  }
  S.dirty = false;
  const D = W.draft;

  const setPath = (path, val) => { const ks = path.split('.'); let o = D; ks.slice(0, -1).forEach(k => { o = o[k] = o[k] ?? {}; }); o[ks.at(-1)] = val; S.dirty = true; };
  const getPath = path => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), D);

  const field = (path, label, opts = {}) => {
    const v = getPath(path) ?? '';
    const id = 'f_' + path.replace(/\W/g, '_');
    const req = opts.req ? ' <span class="req">*</span>' : '';
    let input;
    if (opts.type === 'textarea') input = `<textarea id="${id}" data-k="${path}" placeholder="${esc(opts.ph || '')}">${esc(v)}</textarea>`;
    else if (opts.type === 'select') input = `<select id="${id}" data-k="${path}">${opts.options.map(([ov, ol]) => `<option value="${esc(ov)}" ${String(ov) === String(v) ? 'selected' : ''}>${esc(ol)}</option>`).join('')}</select>`;
    else input = `<input id="${id}" data-k="${path}" type="${opts.type || 'text'}" value="${esc(v)}" placeholder="${esc(opts.ph || '')}" ${opts.attrs || ''}>`;
    return `<div class="field" data-field="${path}"><label class="f" for="${id}">${label}${req}</label>${input}${opts.hint ? `<div class="hint">${opts.hint}</div>` : ''}</div>`;
  };

  const stepper = () => `<div class="steps">${STEP_NAMES.map((n, i) => `<button class="step ${i === W.step ? 'on' : ''} ${i < W.step || (i <= W.maxStep && i !== W.step) ? 'done' : ''}" data-step="${i}" ${i > W.maxStep ? 'disabled' : ''}>
      <span class="n">${i < W.step ? '✓' : i + 1}</span><span class="lbl">${n}</span></button>`).join('')}</div>`;

  /* --- step bodies */
  const step0 = () => `
    <div class="card"><h2>${icon('user')} Who is the customer?</h2>
      <p class="muted">Type the phone number first — if this customer booked before, their details fill in automatically.</p>
      <div class="grid2">
        ${field('customer.phone', 'Mobile number (WhatsApp)', { req: true, type: 'tel', ph: 'e.g. 98470 12345', attrs: 'inputmode="tel" autocomplete="off"' })}
        ${field('customer.name', 'Customer name', { req: true, ph: 'e.g. Ramesh Kumar' })}
      </div>
      <div id="foundBox"></div>
      <div class="grid2">
        ${field('customer.alt_phone', 'Another phone number (optional)', { type: 'tel', attrs: 'inputmode="tel"' })}
        ${field('customer.address', 'Customer address (optional)')}
      </div>
    </div>`;

  const staffOpts = [['', '— Nobody yet —'], ...S.cfg.staff.filter(s => s.active).map(s => [s.id, s.name])];
  const customFields = () => (S.cfg.custom_fields || []).filter(f => f.active).map(f => {
    const path = 'extra.' + f.key;
    if (f.field_type === 'choice') return field(path, esc(f.label), { type: 'select', options: [['', '—'], ...(f.options || '').split(',').map(o => [o.trim(), o.trim()])] });
    if (f.field_type === 'yesno') return field(path, esc(f.label), { type: 'select', options: [['', '—'], ['yes', 'Yes'], ['no', 'No']] });
    return field(path, esc(f.label), { type: f.field_type === 'number' ? 'number' : f.field_type === 'date' ? 'date' : 'text' });
  }).join('');

  const step1 = () => `
    <div class="card"><h2>${icon('calendar')} What kind of event?</h2>
      <div class="choice-grid">${EVENT_TYPES.map(t => `<button class="choice ${D.event_type === t ? 'on' : ''}" data-type="${esc(t)}">${esc(t)}</button>`).join('')}</div>
      <div style="margin-top:1rem">${field('title', 'Event name (optional)', { ph: 'e.g. Ramesh & Priya Wedding', hint: 'If left empty we use the event type and customer name.' })}</div>
    </div>
    <div class="card"><h2>${icon('clock')} When is it?</h2>
      <div class="grid2">
        <div>${field('event_date', 'Event date', { req: true, type: 'date' })}
          <label class="check"><input type="checkbox" data-k="multi_day" ${D.multi_day ? 'checked' : ''}> More than one day (e.g. 2-day wedding)</label>
          <div id="endWrap" class="${D.multi_day ? '' : 'hidden'}">${field('end_date', 'Last day', { type: 'date' })}</div>
        </div>
        <div>
          <div id="timeWrap" class="${D.time_unknown ? 'hidden' : ''}">${field('event_time', 'Serving time', { req: true, type: 'time', hint: 'The time food must be ready / served.' })}</div>
          <label class="check"><input type="checkbox" data-k="time_unknown" ${D.time_unknown ? 'checked' : ''}> Time not fixed yet — customer will tell later</label>
        </div>
      </div>
      <div id="dateBox"></div>
    </div>
    <div class="card"><h2>${icon('pin')} Where and how many people?</h2>
      <div class="grid2">
        ${field('venue', 'Venue / place', { ph: 'Hall name, house address…' })}
        ${field('venue_map', 'Google Maps link (optional)', { ph: 'Paste the location link' })}
      </div>
      <div class="field" data-field="guest_count"><label class="f">Number of guests <span class="req">*</span></label>
        <div class="stepper"><button class="btn" data-g="-10" aria-label="10 less">−</button>
          <input data-k="guest_count" type="number" min="0" inputmode="numeric" value="${esc(D.guest_count)}">
          <button class="btn" data-g="10" aria-label="10 more">+</button></div>
        <div class="hint">− and + change the number by 10.</div></div>
    </div>
    <div class="card"><h2>${icon('info')} Booking status & extra details</h2>
      <div class="choice-grid" style="margin-bottom:1rem">
        <button class="choice ${D.status === 'confirmed' ? 'on' : ''}" data-status="confirmed">Confirmed booking</button>
        <button class="choice ${D.status === 'enquiry' ? 'on' : ''}" data-status="enquiry">Enquiry only (not confirmed)</button>
        ${eid ? `<button class="choice ${D.status === 'completed' ? 'on' : ''}" data-status="completed">Completed</button>
        <button class="choice ${D.status === 'cancelled' ? 'on' : ''}" data-status="cancelled">Cancelled</button>` : ''}
      </div>
      ${D.status === 'enquiry' ? '<div class="help">Enquiries are shown on the calendar but no WhatsApp reminders are sent until you change it to Confirmed.</div>' : ''}
      <div class="grid2">
        ${field('assigned_staff_id', 'Person in charge', { type: 'select', options: staffOpts })}
        ${customFields()}
      </div>
      ${field('special_instructions', 'Special instructions (allergy, Jain, no onion/garlic…)', { type: 'textarea', hint: 'Printed in bold on the kitchen sheet and sent to staff in reminders.' })}
      ${field('notes', 'Other notes', { type: 'textarea' })}
    </div>`;

  const menuNames = S.menu.filter(m => m.active).map(m => m.name);
  const itemRow = (it, i) => {
    const m = S.menu.find(x => x.name.toLowerCase() === (it.item_name || '').toLowerCase());
    const warn = it.item_name && (!m || !m.recipe_lines) ? `<div class="hint" style="color:var(--amber)">${icon('info', 16)} ${m ? 'No recipe yet' : 'Not in menu list'} — not included in the stock plan</div>` : '';
    return `<div class="item-row">
      <div class="wide"><label>Food item ${i + 1}</label><input list="menuList" data-item="${i}" data-f="item_name" value="${esc(it.item_name)}" placeholder="Type or pick from the list">${warn}</div>
      <div><label>Quantity</label><input type="number" min="0" step="any" inputmode="decimal" data-item="${i}" data-f="quantity" value="${esc(it.quantity)}"></div>
      <div><label>Unit</label><select data-item="${i}" data-f="unit">${S.cfg.units.map(u => `<option ${u === it.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
      <div><label>Type</label><select data-item="${i}" data-f="diet">${Object.entries(DIETS).map(([k, l]) => `<option value="${k}" ${k === (it.diet || '') ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="wide"><label>Note (optional)</label><input data-item="${i}" data-f="notes" value="${esc(it.notes)}" placeholder="e.g. less spicy"></div>
      <div><button class="btn danger" data-del-item="${i}" title="Remove this item">${icon('trash')} Remove</button></div>
    </div>`;
  };
  const estimate = () => D.items.reduce((sum, it) => {
    const m = S.menu.find(x => x.name.toLowerCase() === (it.item_name || '').toLowerCase());
    return sum + (m && it.unit === m.unit ? (m.price || 0) * (+it.quantity || 0) : 0);
  }, 0);
  const step2 = () => `
    <div class="card"><h2>${icon('utensils')} What food is ordered?</h2>
      <p class="muted">Add one row per dish. Pick from the list so the stock plan knows the ingredients.</p>
      <datalist id="menuList">${menuNames.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
      <div id="itemRows">${D.items.map(itemRow).join('')}</div>
      <div class="row">
        <button class="btn primary" id="addItem">${icon('plus')} Add another food item</button>
        <button class="btn" id="platesEqGuests">${icon('users')} Set all plates = ${+D.guest_count || 0} guests</button>
      </div>
      <div class="help" style="margin-top:1rem" id="estBox"></div>
    </div>`;

  const contactRow = (c, i) => `<div class="contact-row">
      <div><label>Name</label><input data-contact="${i}" data-f="name" value="${esc(c.name)}" placeholder="e.g. Cook Babu"></div>
      <div><label>WhatsApp number</label><input type="tel" inputmode="tel" data-contact="${i}" data-f="phone" value="${esc(c.phone)}"></div>
      <div><label>Who is this?</label><select data-contact="${i}" data-f="role">${Object.entries(ROLES).filter(([k]) => k !== 'customer').map(([k, l]) => `<option value="${k}" ${k === c.role ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div><button class="btn danger" data-del-contact="${i}">${icon('trash')} Remove</button></div>
    </div>`;
  const quickPeople = () => S.cfg.staff.filter(s => s.active && s.phone && !D.contacts.some(c => c.phone === s.phone))
    .map(s => `<button class="btn small" data-quick="${s.id}">${icon('plus', 18)} ${esc(s.name)}</button>`).join('');
  const step3 = () => {
    const sched = schedulePreview(D.event_date, D.time_unknown ? '' : D.event_time);
    return `
    <div class="card"><h2>${icon('bell')} Who should get WhatsApp reminders?</h2>
      <label class="check" style="font-size:1.05rem"><input type="checkbox" data-k="remind_customer" ${D.remind_customer ? 'checked' : ''}>
        Send reminders to the customer — <b>${esc(D.customer.name || 'customer')}</b> (${esc(D.customer.phone)})</label>
      <h3 style="margin-top:1rem">Other people to remind (cook, helpers, supplier…)</h3>
      <div id="contactRows">${D.contacts.map(contactRow).join('') || '<p class="muted">Nobody else yet.</p>'}</div>
      <div class="row"><button class="btn primary" id="addContact">${icon('plus')} Add a person to remind</button>${quickPeople()}</div>
    </div>
    <div class="card"><h2>${icon('clock')} When will reminders go?</h2>
      ${D.status !== 'confirmed' ? '<div class="alert amber">' + icon('info') + '<div><b>No reminders for enquiries</b>Reminders start when the booking is Confirmed.</div></div>' : ''}
      <ul class="schedule">
        <li>${icon('send')} <b>Booking confirmation</b> — right after saving (customer only)</li>
        ${sched.map(x => `<li>${x.k === 'before_2d' ? `<span class="badge b-red">${icon('alert', 16)} WARNING</span>` : icon('bell')}
          <span><b>${x.label}</b> — ${fmtDT(isoDate(x.due) + ' ' + pad(x.due.getHours()) + ':' + pad(x.due.getMinutes()))}
          ${x.sendNow ? `<span class="badge b-amber">${inQuietNow() ? 'will be sent at ' + fmtTime(S.cfg.settings.quiet_end) + ' (night pause)' : 'will be sent right away'}</span>` : x.past ? '<span class="badge b-grey">already passed — skipped</span>' : ''}</span></li>`).join('')}
      </ul>
      <p class="hint">Change the reminder times in Settings. You can add extra reminders for any person after saving.</p>
    </div>
    <div class="card"><h2>${icon('wallet')} Payment</h2>
      <div class="grid3">
        ${field('total_amount', 'Total amount for the event', { type: 'number', attrs: 'min="0" inputmode="decimal"' })}
        ${eid ? `<div class="field"><label class="f">Already paid</label><input value="${money(W.paid)}" disabled></div>` :
          field('advance_amount', 'Advance received now', { type: 'number', attrs: 'min="0" inputmode="decimal"' })}
        ${eid ? '' : field('advance_mode', 'Paid by', { type: 'select', options: PAY_MODES.map(p => [p, p]) })}
      </div>
      ${estimate() ? `<p class="muted">Menu price estimate: <b>${money(estimate())}</b></p>` : ''}
      ${eid ? '<p class="hint">Add more payments on the booking page.</p>' : ''}
    </div>`;
  };

  const step4 = () => {
    const items = D.items.filter(i => i.item_name);
    const edit = n => `<button class="btn small" data-goto="${n}">${icon('edit', 18)} Change</button>`;
    const people = (D.remind_customer ? [`${D.customer.name} (customer)`] : []).concat(D.contacts.filter(c => c.name).map(c => `${c.name} (${ROLES[c.role] || c.role})`));
    return `
    <div class="alert blue">${icon('info')}<div><b>Please check everything once</b>Then press the green “Save Booking” button at the bottom.</div></div>
    <div class="grid2">
      <div class="card"><div class="row between"><h2>${icon('user')} Customer</h2>${edit(0)}</div>
        <dl class="summary"><dt>Name</dt><dd>${esc(D.customer.name)}</dd><dt>Phone</dt><dd>${esc(D.customer.phone)}</dd>
        ${D.customer.address ? `<dt>Address</dt><dd>${esc(D.customer.address)}</dd>` : ''}</dl></div>
      <div class="card"><div class="row between"><h2>${icon('calendar')} Event</h2>${edit(1)}</div>
        <dl class="summary"><dt>Event</dt><dd>${esc(D.title || `${D.event_type || 'Event'} - ${D.customer.name}`)} ${D.status === 'enquiry' ? '<span class="badge b-blue">Enquiry</span>' : ''}</dd>
        <dt>Date & time</dt><dd>${fmtDate(D.event_date)}${D.multi_day && D.end_date ? ' to ' + fmtDate(D.end_date) : ''} · ${D.time_unknown ? '<span class="badge b-amber">Time not fixed</span>' : fmtTime(D.event_time)}</dd>
        <dt>Venue</dt><dd>${esc(D.venue || '—')}</dd><dt>Guests</dt><dd>${esc(D.guest_count || 0)}</dd>
        ${D.special_instructions ? `<dt>Special instructions</dt><dd class="special">${esc(D.special_instructions)}</dd>` : ''}</dl></div>
      <div class="card"><div class="row between"><h2>${icon('utensils')} Food (${items.length})</h2>${edit(2)}</div>
        ${items.length ? `<ul>${items.map(i => `<li><b>${esc(i.item_name)}</b> — ${esc(i.quantity)} ${esc(i.unit)}${i.notes ? ` <span class="muted">(${esc(i.notes)})</span>` : ''}</li>`).join('')}</ul>` : '<p class="badge b-amber">No food items yet</p>'}</div>
      <div class="card"><div class="row between"><h2>${icon('bell')} Reminders & payment</h2>${edit(3)}</div>
        <dl class="summary"><dt>Reminders go to</dt><dd>${people.length ? esc(people.join(', ')) : '<span class="badge b-red">Nobody — no reminders will be sent</span>'}</dd>
        <dt>Total</dt><dd>${money(D.total_amount)}</dd>${eid ? '' : `<dt>Advance</dt><dd>${money(D.advance_amount)} ${D.advance_amount ? '(' + esc(D.advance_mode) + ')' : ''}</dd>`}</dl></div>
    </div>`;
  };

  const STEPS = [step0, step1, step2, step3, step4];

  /* --- validation per step */
  const digits = s => String(s || '').replace(/\D/g, '');
  function validate(step) {
    const errs = [];
    if (step === 0) {
      if (digits(D.customer.phone).length < 10) errs.push(['customer.phone', 'Please type a 10-digit mobile number']);
      if (!D.customer.name.trim()) errs.push(['customer.name', 'Please type the customer name']);
    }
    if (step === 1) {
      if (!D.event_date) errs.push(['event_date', 'Please choose the event date']);
      if (D.multi_day && D.end_date && D.end_date < D.event_date) errs.push(['end_date', 'Last day cannot be before the first day']);
      if (!D.time_unknown && !D.event_time) errs.push(['event_time', 'Please choose the time, or tick “Time not fixed yet”']);
      if (D.guest_count === '' || +D.guest_count < 0) errs.push(['guest_count', 'Please type the number of guests']);
    }
    if (step === 3) {
      D.contacts.forEach((c, i) => { if ((c.name || c.phone) && digits(c.phone).length < 10) errs.push([`contact${i}`, `Phone number of ${c.name || 'person ' + (i + 1)} is not complete`]); });
    }
    $$('.field.error').forEach(f => { f.classList.remove('error'); $('.err-text', f)?.remove(); });
    errs.forEach(([k, msg]) => {
      const f = $(`[data-field="${k}"]`);
      if (f) { f.classList.add('error'); f.insertAdjacentHTML('beforeend', `<div class="err-text">${icon('alert', 16)} ${esc(msg)}</div>`); }
    });
    if (errs.length) { toast(errs[0][1], 'err'); const f = $('.field.error input, .field.error select'); f?.focus(); }
    return !errs.length;
  }

  /* --- render */
  function render() {
    $('#view').innerHTML = `
      <div class="page-head">
        <h1>${icon(eid ? 'edit' : 'plus', 30)} ${eid ? `Change booking #${eid}` : 'New Booking'}</h1>
        <a class="btn" href="${eid ? '#/events/' + eid : '#/'}">${icon('x')} Cancel</a>
      </div>
      ${stepper()}
      <div id="stepBody">${STEPS[W.step]()}</div>
      <div class="wizard-foot">
        ${W.step > 0 ? `<button class="btn big" id="backBtn">${icon('left')} Back</button>` : '<span></span>'}
        ${W.step < 4 ? `<button class="btn primary big" id="nextBtn">Next: ${STEP_NAMES[W.step + 1]} ${icon('right')}</button>`
          : `<button class="btn primary big" id="saveBtn">${icon('check')} Save Booking</button>`}
      </div>`;
    bind();
  }
  function go(step) { W.step = step; W.maxStep = Math.max(W.maxStep, step); render(); window.scrollTo(0, 0); }

  async function checkDate() {
    const box = $('#dateBox');
    if (!box || !D.event_date) return;
    try {
      const r = await api('GET', `/api/events/check-date?date=${D.event_date}${eid ? '&exclude=' + eid : ''}`);
      W.dateInfo = r;
      let html = '';
      if (r.past) html += `<div class="alert red">${icon('alert')}<div><b>This date is in the past</b>
          <label class="check"><input type="checkbox" data-k="allow_past" ${D.allow_past ? 'checked' : ''}> Yes, I am recording an old event</label></div></div>`;
      if (r.events.length) html += `<div class="alert ${r.full ? 'red' : 'amber'}">${icon('alert')}<div>
          <b>${r.full ? 'FULL: ' : ''}${r.events.length} other booking${r.events.length > 1 ? 's' : ''} on this day${r.full ? ` (limit is ${r.capacity})` : ''}</b>
          ${r.events.map(e => `#${e.id} ${esc(e.title)} — ${e.event_time ? fmtTime(e.event_time) : 'time not fixed'}, ${e.guest_count} guests${e.status === 'enquiry' ? ' (enquiry)' : ''}`).join('<br>')}
        </div></div>`;
      else if (!r.past) html = `<div class="alert green">${icon('check')}<div><b>This date is free</b>No other bookings on ${fmtDate(D.event_date)}.</div></div>`;
      box.innerHTML = html;
      $$('[data-k]', box).forEach(el => el.addEventListener('change', () => setPath(el.dataset.k, el.checked)));
    } catch (e) { /* not critical */ }
  }

  async function lookupPhone() {
    const ph = D.customer.phone;
    const box = $('#foundBox');
    if (!box || digits(ph).length < 10) { if (box) box.innerHTML = ''; return; }
    try {
      const c = await api('GET', `/api/customers/lookup?phone=${encodeURIComponent(ph)}`);
      if (!c) { box.innerHTML = `<div class="alert blue">${icon('user')}<div><b>New customer</b>This number is not in our list yet.</div></div>`; return; }
      W.found = c;
      const sameName = c.name.toLowerCase() === (D.customer.name || '').trim().toLowerCase();
      if (!D.customer.name) { D.customer.name = c.name; D.customer.address = D.customer.address || c.address || ''; D.customer.alt_phone = D.customer.alt_phone || c.alt_phone || ''; render(); return; }
      box.innerHTML = `<div class="alert green">${icon('check')}<div><b>Existing customer: ${esc(c.name)}</b>${c.bookings} earlier booking${c.bookings === 1 ? '' : 's'}.
        ${sameName ? '' : `<br><button class="btn small" id="useFound">${icon('copy', 18)} Use saved name “${esc(c.name)}”</button>`}</div></div>`;
      $('#useFound')?.addEventListener('click', () => { D.customer.name = c.name; D.customer.address = c.address || D.customer.address; render(); });
    } catch (e) { /* ignore */ }
  }

  function bind() {
    $$('[data-step]').forEach(b => b.onclick = () => { if (+b.dataset.step < W.step || validate(W.step)) go(+b.dataset.step); });
    $('#backBtn')?.addEventListener('click', () => go(W.step - 1));
    $('#nextBtn')?.addEventListener('click', async () => {
      if (!validate(W.step)) return;
      if (W.step === 1 && W.dateInfo?.past && !D.allow_past) { toast('The date is in the past. Tick “recording an old event” or choose another date.', 'err'); return; }
      if (W.step === 1 && W.dateInfo?.full && !(await confirmBox({ title: 'This day is already full', text: `There are already ${W.dateInfo.events.length} bookings on ${fmtDate(D.event_date)}. Do you still want to take this booking?`, ok: 'Yes, take it' }))) return;
      if (W.step === 2 && !D.items.some(i => i.item_name) && !(await confirmBox({ title: 'No food items yet', text: 'You have not added any food. You can add it later. Continue?', ok: 'Continue without food' }))) return;
      go(W.step + 1);
    });
    $('#saveBtn')?.addEventListener('click', ev => save(ev.currentTarget));
    $$('[data-goto]').forEach(b => b.onclick = () => go(+b.dataset.goto));

    $$('#stepBody [data-k]').forEach(el => {
      const evt = el.type === 'checkbox' || el.tagName === 'SELECT' || el.type === 'date' || el.type === 'time' ? 'change' : 'input';
      el.addEventListener(evt, () => {
        setPath(el.dataset.k, el.type === 'checkbox' ? el.checked : el.value);
        const k = el.dataset.k;
        if (k === 'multi_day') $('#endWrap').classList.toggle('hidden', !el.checked);
        if (k === 'time_unknown') { $('#timeWrap').classList.toggle('hidden', el.checked); if (el.checked) D.event_time = ''; }
        if (k === 'event_date') { D.allow_past = false; checkDate(); }
        if (k === 'customer.phone') { clearTimeout(W.lt); W.lt = setTimeout(lookupPhone, 500); }
        if (k === 'remind_customer' || k === 'total_amount') { /* nothing else */ }
      });
    });
    $$('[data-type]').forEach(b => b.onclick = () => { D.event_type = b.dataset.type; S.dirty = true; $$('[data-type]').forEach(x => x.classList.toggle('on', x === b)); });
    $$('[data-status]').forEach(b => b.onclick = () => { D.status = b.dataset.status; S.dirty = true; render(); });
    $$('[data-g]').forEach(b => b.onclick = () => { D.guest_count = Math.max(0, (+D.guest_count || 0) + +b.dataset.g); S.dirty = true; $('[data-k="guest_count"]').value = D.guest_count; });

    // food rows
    const updEst = () => { const box = $('#estBox'); if (box) { const e = estimate(); box.innerHTML = e ? `${icon('wallet', 18)} Menu price estimate: <b>${money(e)}</b> <button class="btn small" id="useEst">Use as total amount</button>` : `${icon('info', 18)} Prices from the menu list are added up here.`; $('#useEst')?.addEventListener('click', () => { D.total_amount = e; toast(`Total set to ${money(e)}`); }); } };
    $$('[data-item]').forEach(el => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
      const it = D.items[+el.dataset.item];
      it[el.dataset.f] = el.value; S.dirty = true;
      if (el.dataset.f === 'item_name') {
        const m = S.menu.find(x => x.name.toLowerCase() === el.value.trim().toLowerCase());
        if (m) { it.menu_item_id = m.id; if (!it.diet && m.diet) { it.diet = m.diet; } if (m.unit && it.unit !== m.unit) it.unit = m.unit; if (!it.quantity && +D.guest_count) it.quantity = +D.guest_count; }
      }
      updEst();
    }));
    $$('[data-item][data-f="item_name"]').forEach(el => el.addEventListener('change', () => render()));
    $('#addItem')?.addEventListener('click', () => { D.items.push({ item_name: '', quantity: '', unit: 'plates', diet: '', notes: '' }); render(); $$('[data-f="item_name"]').at(-1)?.focus(); });
    $$('[data-del-item]').forEach(b => b.onclick = () => { D.items.splice(+b.dataset.delItem, 1); if (!D.items.length) D.items.push({ item_name: '', quantity: '', unit: 'plates', diet: '', notes: '' }); S.dirty = true; render(); });
    $('#platesEqGuests')?.addEventListener('click', () => {
      if (!+D.guest_count) return toast('Please fill the number of guests first (step 2)', 'err');
      D.items.forEach(i => { if (i.unit === 'plates' && i.item_name) i.quantity = +D.guest_count; }); S.dirty = true; render(); toast('Plates updated to ' + D.guest_count);
    });
    if (W.step === 2) updEst();

    // contacts
    $$('[data-contact]').forEach(el => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => { D.contacts[+el.dataset.contact][el.dataset.f] = el.value; S.dirty = true; }));
    $$('.contact-row').forEach((r, i) => r.setAttribute('data-field', 'contact' + i));
    $('#addContact')?.addEventListener('click', () => { D.contacts.push({ name: '', phone: '', role: 'staff' }); render(); $$('[data-contact][data-f="name"]').at(-1)?.focus(); });
    $$('[data-del-contact]').forEach(b => b.onclick = () => { D.contacts.splice(+b.dataset.delContact, 1); S.dirty = true; render(); });
    $$('[data-quick]').forEach(b => b.onclick = () => { const s = S.cfg.staff.find(x => x.id === +b.dataset.quick); D.contacts.push({ name: s.name, phone: s.phone, role: s.role === 'admin' ? 'owner' : 'staff' }); S.dirty = true; render(); });

    if (W.step === 0) lookupPhone();
    if (W.step === 1) checkDate();
  }

  async function save(btn) {
    const payload = {
      customer: { name: D.customer.name.trim(), phone: D.customer.phone, alt_phone: D.customer.alt_phone, address: D.customer.address },
      event_type: D.event_type, title: D.title, event_date: D.event_date, end_date: D.multi_day ? D.end_date : '',
      event_time: D.time_unknown ? '' : D.event_time, venue: D.venue, venue_map: D.venue_map, guest_count: D.guest_count || 0,
      status: D.status, assigned_staff_id: D.assigned_staff_id || null, extra: D.extra,
      special_instructions: D.special_instructions, notes: D.notes, total_amount: D.total_amount || 0,
      items: D.items.filter(i => i.item_name || i.quantity),
      contacts: (D.remind_customer ? [{ name: D.customer.name.trim(), phone: D.customer.phone, role: 'customer' }] : []).concat(D.contacts),
      allow_past: D.allow_past,
    };
    if (!eid) { payload.advance_amount = D.advance_amount || 0; payload.advance_mode = D.advance_mode; }
    else payload.version = W.version;
    try {
      const res = await withBusy(btn, () => api(eid ? 'PUT' : 'POST', eid ? `/api/events/${eid}` : '/api/events', payload));
      S.dirty = false;
      toast(eid ? 'Changes saved' : 'Booking saved. Reminders are planned.');
      location.hash = `#/events/${res.id}`;
    } catch (e) {
      if (e.status === 409) {
        const reload = await confirmBox({ title: 'Someone else changed this booking', text: esc(e.message), ok: 'Reload the booking', cancel: 'Stay here' });
        if (reload) { S.dirty = false; pageWizard(eid); }
      } else if (e.body?.code === 'past_date') { go(1); showError(e); }
      else showError(e);
    }
  }

  render();
}

/* ---------- booking detail */
const REM_STATUS = {
  pending: ['Scheduled', 'b-blue'], retry: ['Retrying', 'b-amber'], sending: ['Sending…', 'b-blue'], sent: ['Sent ✓', 'b-green'],
  failed: ['FAILED', 'b-red'], skipped: ['Skipped', 'b-grey'], cancelled: ['Cancelled', 'b-grey'], expired: ['Expired', 'b-grey'],
};
function inQuietNow() {
  const s = S.cfg.settings, n = new Date(), t = n.getHours() * 60 + n.getMinutes(), qs = hm(s.quiet_start), qe = hm(s.quiet_end);
  return qs === qe ? false : qs > qe ? (t >= qs || t < qe) : (qs <= t && t < qe);
}
function remBadge(r) {
  const [t, c] = REM_STATUS[r.status] || [r.status, 'b-grey'];
  let held = '';
  if (['pending', 'retry'].includes(r.status) && r.due_at && parseDT(r.due_at) <= new Date()) {
    held = inQuietNow() ? `<br><span class="small muted">Night pause — goes at ${fmtTime(S.cfg.settings.quiet_end)}</span>`
      : '<br><span class="small muted">Going out within a minute</span>';
  }
  return `<span class="badge ${c}">${t}</span>${held}`;
}
function waHref(phone, text = '') { return `https://wa.me/${String(phone).replace(/\D/g, '')}${text ? '?text=' + encodeURIComponent(text) : ''}`; }

async function pageEvent(eid) {
  const e = await api('GET', `/api/events/${eid}`);
  const red = e.urgency === 'red';
  const active = ['confirmed', 'enquiry'].includes(e.status) && !e.deleted_at;
  const s = S.cfg.settings;
  const statusBtns = e.deleted_at ? `<button class="btn primary" data-act="restore">${icon('undo')} Restore booking</button>` : `
      ${e.status === 'enquiry' ? `<button class="btn primary" data-status="confirmed">${icon('check')} Confirm booking</button>` : ''}
      ${e.status === 'confirmed' ? `<button class="btn" data-status="completed">${icon('check')} Mark completed</button>` : ''}
      ${['completed', 'cancelled'].includes(e.status) ? `<button class="btn" data-status="confirmed">${icon('undo')} Re-open</button>` : ''}
      ${active ? `<button class="btn danger" data-status="cancelled">${icon('x')} Cancel booking</button>` : ''}`;
  $('#view').innerHTML = `
    <div class="print-only"><h1>${esc(S.me.business_name)} — Kitchen Sheet</h1></div>
    <div class="row between no-print" style="margin-bottom:1rem">
      <a class="btn" href="#/events">${icon('left')} All bookings</a>
      <div class="row">
        ${!e.deleted_at ? `<a class="btn primary big" href="#/events/${e.id}/edit">${icon('edit')} Change booking</a>` : ''}
        <button class="btn" data-act="print">${icon('printer')} Print kitchen sheet</button>
        <button class="btn" data-act="copy">${icon('copy')} Book again</button>
      </div>
    </div>
    ${e.deleted_at ? `<div class="alert red">${icon('trash')}<div><b>This booking is deleted</b>Deleted on ${fmtDT(e.deleted_at)} by ${esc(e.updated_by)}. Press Restore to bring it back.</div></div>` : ''}
    ${red && active ? `<div class="alert red">${icon('alert', 34)}<div><b style="font-size:1.25rem">WARNING: this event is ${countdownText(e).toLowerCase() === 'today' ? 'TODAY' : countdownText(e) === 'TOMORROW' ? 'TOMORROW' : 'in ' + e.days_left + ' days'}</b>
        ${e.final_confirmed_at ? `${icon('check', 18)} Customer re-confirmed by ${esc(e.final_confirmed_by)} on ${fmtDT(e.final_confirmed_at)}.` :
        'Please call the customer and check date, time, venue, guest count and menu. Then press the button below.'}
        <div class="row no-print" style="margin-top:.6rem">
          ${e.final_confirmed_at ? `<button class="btn small" data-act="unconfirm">${icon('undo', 18)} Undo re-confirmation</button>` :
            `<button class="btn primary big" data-act="reconfirm">${icon('check')} Customer re-confirmed everything</button>`}
          <a class="btn" href="tel:${esc(e.customer_phone)}">${icon('phone')} Call ${esc(e.customer_name)}</a></div></div></div>` : ''}
    ${e.flags.length ? `<div class="row" style="margin-bottom:1rem">${flagBadges(e.flags)}</div>` : ''}

    <div class="card">
      <div class="detail-head">
        <div style="flex:1;min-width:260px">
          <div class="row" style="gap:.5rem">${statusBadge(e)} ${countdown(e)} <span class="muted">Booking #${e.id}</span></div>
          <h1 style="margin:.4rem 0">${esc(e.title)}</h1>
          <div class="when">${icon('calendar')} ${fmtDate(e.event_date)}${e.end_date ? ' to ' + fmtDate(e.end_date) : ''}</div>
          <div class="when">${icon('clock')} ${e.event_time ? fmtTime(e.event_time) : '<span style="color:var(--red)">Time not fixed yet</span>'}</div>
        </div>
        <div class="row no-print">${statusBtns}</div>
      </div>
    </div>

    <div class="grid2" style="margin-top:1rem">
      <div class="stack">
        <div class="card"><h2>${icon('user')} Customer</h2>
          <dl class="kv"><dt>Name</dt><dd>${esc(e.customer_name)}</dd><dt>Phone</dt><dd>${esc(e.customer_phone)}</dd>
            ${e.customer_alt_phone ? `<dt>Other phone</dt><dd>${esc(e.customer_alt_phone)}</dd>` : ''}
            ${e.customer_address ? `<dt>Address</dt><dd>${esc(e.customer_address)}</dd>` : ''}</dl>
          <div class="row no-print" style="margin-top:.8rem">
            <a class="btn" href="tel:${esc(e.customer_phone)}">${icon('phone')} Call</a>
            <a class="btn wa" target="_blank" rel="noopener" href="${waHref(e.customer_phone)}">${icon('chat')} WhatsApp</a></div></div>
        <div class="card"><h2>${icon('pin')} Event details</h2>
          <dl class="kv"><dt>Type</dt><dd>${esc(e.event_type || '—')}</dd>
            <dt>Venue</dt><dd>${esc(e.venue || '—')} ${e.venue_map ? `<a href="${esc(e.venue_map)}" target="_blank" rel="noopener" class="no-print">${icon('external', 16)} Map</a>` : ''}</dd>
            <dt>Guests</dt><dd style="font-size:1.2rem">${e.guest_count}</dd>
            <dt>Person in charge</dt><dd>${esc(e.assigned_name || '—')}</dd>
            ${(S.cfg.custom_fields || []).filter(f => f.active && e.extra[f.key]).map(f => `<dt>${esc(f.label)}</dt><dd>${esc(e.extra[f.key] === 'yes' ? 'Yes' : e.extra[f.key] === 'no' ? 'No' : e.extra[f.key])}</dd>`).join('')}
            ${e.notes ? `<dt>Notes</dt><dd>${esc(e.notes)}</dd>` : ''}</dl>
          ${e.special_instructions ? `<div class="special" style="margin-top:.8rem">${icon('alert')} ${esc(e.special_instructions)}</div>` : ''}</div>
        <div class="card"><h2>${icon('utensils')} Food items</h2>
          ${e.items.length ? `<div class="table-wrap"><table><thead><tr><th>Item</th><th class="num">Quantity</th><th>Type</th><th>Note</th></tr></thead>
            <tbody>${e.items.map(i => `<tr><td><b>${esc(i.item_name)}</b></td><td class="num" style="font-size:1.1rem"><b>${i.quantity}</b> ${esc(i.unit)}</td><td>${esc(DIETS[i.diet || ''] || '')}</td><td>${esc(i.notes || '')}</td></tr>`).join('')}</tbody></table></div>`
            : `<div class="alert amber">${icon('alert')}<div><b>No food items yet</b><a href="#/events/${e.id}/edit">Add food items ${icon('right', 16)}</a></div></div>`}</div>
        <div class="card"><h2>${icon('box')} Ingredients needed</h2>
          <p class="muted small">Calculated from the recipes × quantity + ${esc(s.wastage_pct)}% wastage.</p>
          ${e.requirements.length ? `<div class="table-wrap"><table><thead><tr><th>Ingredient</th><th class="num">Needed</th></tr></thead>
            <tbody>${e.requirements.map(r => `<tr><td>${esc(r.name)}</td><td class="num"><b>${qty(r.qty)}</b> ${esc(r.unit)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No recipes linked to these items.</p>'}
          ${e.unplanned_items.length ? `<div class="alert amber" style="margin-top:.8rem">${icon('info')}<div><b>Not in the stock plan:</b>${e.unplanned_items.map(u => esc(u.item_name)).join(', ')} — add a recipe in Menu & Recipes.</div></div>` : ''}
          <div class="row no-print" style="margin-top:.8rem">${e.stock_issued ? `<span class="badge b-green">${icon('check', 16)} Stock already taken out for this event</span>` :
            e.requirements.length && !e.deleted_at && e.status !== 'cancelled' ? `<button class="btn" data-act="issue">${icon('box')} Take these out of stock</button>` : ''}</div></div>
      </div>

      <div class="stack">
        <div class="card no-print"><h2>${icon('wallet')} Payment</h2>
          <div class="money"><div>Total<b>${money(e.total_amount)}</b></div><div>Paid<b>${money(e.paid)}</b></div>
            <div class="${e.balance > 0 ? 'due' : ''}">Balance<b>${money(e.balance)}</b></div></div>
          ${e.payments.length ? `<div class="table-wrap"><table><tbody>${e.payments.map(p => `<tr><td>${fmtDateShort(p.paid_on)}</td><td>${esc(p.mode || '')}${p.note ? ` · ${esc(p.note)}` : ''}</td>
            <td class="num"><b>${money(p.amount)}</b></td><td class="right"><button class="btn small ghost" data-delpay="${p.id}" title="Remove payment">${icon('trash', 18)}</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No payments yet.</p>'}
          ${!e.deleted_at ? `<details style="margin-top:.8rem"><summary>${icon('plus', 18)} Add a payment</summary>
            <div class="grid2" id="payForm" style="margin-top:.6rem">
              <div class="field"><label class="f">Amount</label><input name="amount" type="number" min="0" inputmode="decimal" value="${e.balance > 0 ? e.balance : ''}"></div>
              <div class="field"><label class="f">Paid by</label><select name="mode">${PAY_MODES.map(p => `<option>${p}</option>`).join('')}</select></div>
              <div class="field"><label class="f">Date</label><input name="paid_on" type="date" value="${todayISO()}"></div>
              <div class="field"><label class="f">Note</label><input name="note" placeholder="optional"></div>
            </div><button class="btn primary" data-act="pay">${icon('check')} Save payment</button></details>` : ''}
        </div>

        <div class="card no-print"><h2>${icon('bell')} WhatsApp reminders</h2>
          ${e.status === 'enquiry' ? `<div class="alert amber">${icon('info')}<div><b>Enquiry — no reminders yet</b>Press “Confirm booking” to start reminders.</div></div>` : ''}
          <p class="muted small">Going to: ${e.contacts.map(c => `${esc(c.name)} (${esc(ROLES[c.role] || c.role)})`).join(', ') || '<b style="color:var(--red)">nobody</b>'}</p>
          ${e.reminders.length ? e.reminders.map(r => `<div class="rem-item">
              <span class="when">${fmtDT(r.status === 'sent' ? r.sent_at : r.due_at)}<br><span class="small muted">${relTime(r.status === 'sent' ? r.sent_at : r.due_at)}</span></span>
              <span style="flex:1;min-width:160px"><b>${esc(r.label)}</b>${r.note ? ` — ${esc(r.note)}` : ''}<br><span class="small">${esc(r.recipient_name)} · ${esc(r.phone)}</span>
                ${r.last_error && ['failed', 'retry', 'skipped', 'cancelled', 'expired'].includes(r.status) ? `<br><span class="small muted">${esc(r.last_error)}</span>` : ''}</span>
              ${remBadge(r)}
              <span class="row" style="gap:.3rem">
                ${['pending', 'retry', 'failed', 'skipped'].includes(r.status) && active ? `<button class="btn small" data-send="${r.id}">${icon('send', 18)} Send now</button>` : ''}
                ${r.wa_link ? `<a class="btn small wa" target="_blank" rel="noopener" href="${esc(r.wa_link)}">${icon('chat', 18)} Open in WhatsApp</a>` : ''}
                ${['pending', 'retry', 'failed'].includes(r.status) ? `<button class="btn small ghost" data-cancelrem="${r.id}" title="Cancel this reminder">${icon('x', 18)}</button>` : ''}
              </span></div>`).join('') : '<p class="muted">No reminders.</p>'}
          ${!e.deleted_at ? `<details style="margin-top:.8rem" ${e.reminders.length ? '' : 'open'}><summary>${icon('plus', 18)} Add your own reminder (any person, any time)</summary>
            <div id="remForm" style="margin-top:.6rem">
              <div class="field"><label class="f">Remind whom?</label><select name="pick">
                ${e.contacts.map(c => `<option value="${esc(c.phone)}|${esc(c.name)}">${esc(c.name)} (${esc(ROLES[c.role] || c.role)})</option>`).join('')}
                ${S.cfg.staff.filter(x => x.active && x.phone && !e.contacts.some(c => c.phone === x.phone)).map(x => `<option value="${esc(x.phone)}|${esc(x.name)}">${esc(x.name)} (staff)</option>`).join('')}
                <option value="new">+ Somebody else…</option></select></div>
              <div class="grid2 hidden" id="remNew">
                <div class="field"><label class="f">Name</label><input name="name"></div>
                <div class="field"><label class="f">WhatsApp number</label><input name="phone" type="tel" inputmode="tel"></div></div>
              <div class="field"><label class="f">Date and time</label><input name="due_at" type="datetime-local" value="${isoDate(new Date())}T${pad(Math.min(new Date().getHours() + 1, 23))}:00"></div>
              <div class="field"><label class="f">Message / what to remember</label><input name="note" placeholder="e.g. Collect balance payment, bring 20 extra chairs"></div>
              <button class="btn primary" data-act="addrem">${icon('bell')} Set reminder</button></div></details>` : ''}
        </div>

        <div class="card no-print"><details><summary>${icon('info', 18)} Change history</summary>
          ${e.history.map(h => `<div class="small" style="padding:.4rem 0;border-bottom:1px solid var(--line)"><b>${esc(h.staff_name || '')}</b> ${esc(h.action)} · ${fmtDT(h.at)}
            ${h.detail ? `<br><span class="muted">${esc(h.detail).slice(0, 300)}</span>` : ''}</div>`).join('')}
          <p class="small muted">Created by ${esc(e.created_by || '')} on ${fmtDT(e.created_at)}</p></details>
          ${!e.deleted_at ? `<button class="btn danger" data-act="delete" style="margin-top:.8rem">${icon('trash')} Delete this booking</button>` : ''}
        </div>
      </div>
    </div>`;

  const reload = () => pageEvent(eid);
  const act = async (fn, okMsg) => { try { await fn(); if (okMsg) toast(okMsg); await reload(); refreshBadges(); } catch (err) { showError(err); } };

  $$('[data-status]').forEach(b => b.onclick = async () => {
    const st = b.dataset.status;
    const texts = {
      cancelled: ['Cancel this booking?', 'All WhatsApp reminders for this event will be stopped. You can re-open it later.', 'Yes, cancel booking', true],
      completed: ['Mark as completed?', 'The event is done. Reminders stop. ' + (e.stock_issued || !e.requirements.length ? '' : 'Tip: also press “Take these out of stock”.'), 'Yes, completed', false],
      confirmed: ['Confirm this booking?', 'WhatsApp reminders will be planned and the customer gets a confirmation message.', 'Yes, confirm', false],
    }[st];
    if (texts && !(await confirmBox({ title: texts[0], text: texts[1], ok: texts[2], danger: texts[3] }))) return;
    act(() => api('POST', `/api/events/${eid}/status`, { status: st }), 'Status changed');
  });
  const A = {
    print: () => window.print(),
    copy: async () => {
      try {
        const d = await api('POST', `/api/events/${eid}/duplicate`);
        sessionStorage.setItem('cm.prefill', JSON.stringify(d));
        toast('Copied. Choose the new date.'); location.hash = '#/events/new';
      } catch (err) { showError(err); }
    },
    restore: () => act(() => api('POST', `/api/events/${eid}/restore`), 'Booking restored'),
    reconfirm: () => act(() => api('POST', `/api/events/${eid}/reconfirm`, {}), 'Marked as re-confirmed'),
    unconfirm: () => act(() => api('POST', `/api/events/${eid}/reconfirm`, { undo: true })),
    delete: async () => {
      if (!(await confirmBox({ title: 'Delete this booking?', text: 'Reminders will stop. The owner can still find it under All Bookings → Deleted and restore it.', ok: 'Yes, delete', danger: true }))) return;
      try { await api('DELETE', `/api/events/${eid}`); toast('Booking deleted'); location.hash = '#/events'; } catch (err) { showError(err); }
    },
    issue: async () => {
      if (!(await confirmBox({ title: 'Take ingredients out of stock?', text: 'The ingredients for this booking will be subtracted from stock (oldest / first-expiring first). This can be done only once.', ok: 'Yes, take out' }))) return;
      try {
        const res = await api('POST', `/api/events/${eid}/issue-stock`);
        const short = res.filter(r => r.shortfall > 0);
        toast(short.length ? `Done. Not enough stock for: ${short.map(r => r.ingredient).join(', ')}` : 'Stock updated', short.length ? 'err' : 'ok');
        reload();
      } catch (err) { showError(err); }
    },
    pay: ev => {
      const d = formData($('#payForm'));
      act(() => withBusy(ev.currentTarget, () => api('POST', `/api/events/${eid}/payments`, d)), 'Payment saved');
    },
    addrem: ev => {
      const d = formData($('#remForm'));
      let name = d.name, phone = d.phone;
      if (d.pick && d.pick !== 'new') [phone, name] = d.pick.split('|');
      act(() => withBusy(ev.currentTarget, () => api('POST', `/api/events/${eid}/reminders`, { name, phone, due_at: d.due_at, note: d.note })), 'Reminder set');
    },
  };
  $$('[data-act]').forEach(b => b.onclick = ev => A[b.dataset.act](ev));
  $('#remForm select[name=pick]')?.addEventListener('change', ev => $('#remNew').classList.toggle('hidden', ev.target.value !== 'new'));
  if ($('#remForm select[name=pick]')?.value === 'new') $('#remNew').classList.remove('hidden');
  $$('[data-delpay]').forEach(b => b.onclick = async () => {
    if (!(await confirmBox({ title: 'Remove this payment?', text: 'Only do this if it was entered by mistake.', ok: 'Remove', danger: true }))) return;
    act(() => api('DELETE', `/api/payments/${b.dataset.delpay}`), 'Payment removed');
  });
  $$('[data-send]').forEach(b => b.onclick = async () => {
    try {
      const r = await withBusy(b, () => api('POST', `/api/reminders/${b.dataset.send}/send-now`));
      if (r.ok) toast(S.me.provider === 'test' ? 'Prepared (test mode) — tap “Open in WhatsApp” to send' : 'WhatsApp sent');
      else toast('Could not send: ' + r.message, 'err');
      reload();
    } catch (err) { showError(err); }
  });
  $$('[data-cancelrem]').forEach(b => b.onclick = async () => {
    if (!(await confirmBox({ title: 'Stop this reminder?', text: 'This one reminder will not be sent.', ok: 'Stop it', danger: true }))) return;
    act(() => api('POST', `/api/reminders/${b.dataset.cancelrem}/cancel`), 'Reminder stopped');
  });
}

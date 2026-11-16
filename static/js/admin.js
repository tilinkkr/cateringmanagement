'use strict';
/* Reminders, outbox, stock, menu & recipes, customers, settings. */

/* ---------- reminders */
async function pageReminders(tab = 'upcoming') {
  const TABS = { upcoming: 'Coming up', failed: 'FAILED', sent: 'Sent', closed: 'Skipped / cancelled' };
  const [list, failed] = await Promise.all([api('GET', `/api/reminders?status=${tab}`), tab === 'failed' ? null : api('GET', '/api/reminders?status=failed')]);
  const failCount = tab === 'failed' ? list.length : failed.length;
  $('#view').innerHTML = `
    <div class="page-head"><h1>${icon('bell', 30)} WhatsApp Reminders</h1>
      <a class="btn" href="#/outbox">${icon('inbox')} Message Outbox</a></div>
    ${failCount ? `<div class="alert red">${icon('alert')}<div><b>${failCount} message${failCount > 1 ? 's' : ''} could not be delivered</b>
      Please call these people, or press “Send now” to try again.</div></div>` : ''}
    <div class="help" style="margin-bottom:1rem">${icon('info', 18)} Reminders are checked every minute. Default schedule: 7 days, <b>2 days (warning)</b>, 1 day and 4 hours before each confirmed event. No messages are sent at night (${esc(S.cfg.settings.quiet_start)}–${esc(S.cfg.settings.quiet_end)}) — they are moved earlier instead.</div>
    <div class="tabs">${Object.entries(TABS).map(([k, l]) => `<button class="tab ${k === tab ? 'on' : ''}" data-t="${k}">${l}${k === 'failed' && failCount ? ` <span class="count">${failCount}</span>` : ''}</button>`).join('')}</div>
    ${list.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>To</th><th>Booking</th><th>Type</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map(r => `<tr class="${r.status === 'failed' ? 'r-red' : ''}">
        <td class="nowrap"><b>${fmtDT(tab === 'sent' ? r.sent_at : r.due_at)}</b><br><span class="small muted">${relTime(tab === 'sent' ? r.sent_at : r.due_at)}</span></td>
        <td>${esc(r.recipient_name)}<br><span class="small muted">${esc(r.phone)}</span></td>
        <td><a href="#/events/${r.event_id}">${esc(r.event_title)} ${icon('right', 16)}</a><br><span class="small muted">${fmtDateShort(r.event_date)} ${fmtTime(r.event_time)}</span></td>
        <td>${esc(r.label)}${r.note ? `<br><span class="small">${esc(r.note)}</span>` : ''}</td>
        <td>${remBadge(r)}${r.last_error && r.status !== 'sent' ? `<br><span class="small muted">${esc(r.last_error).slice(0, 120)}</span>` : ''}${r.attempts > 1 ? `<br><span class="small muted">${r.attempts} tries</span>` : ''}</td>
        <td><div class="row" style="gap:.3rem">
          ${['pending', 'retry', 'failed'].includes(r.status) ? `<button class="btn small" data-send="${r.id}">${icon('send', 18)} Send now</button>` : ''}
          ${r.wa_link ? `<a class="btn small wa" target="_blank" rel="noopener" href="${esc(r.wa_link)}">${icon('chat', 18)} WhatsApp</a>` : ''}
          <a class="btn small" href="tel:${esc(r.phone)}">${icon('phone', 18)} Call</a></div></td></tr>`).join('')}
    </tbody></table></div>` : emptyBox('bell', tab === 'failed' ? 'No failed messages. 👍' : 'Nothing here.')}`;
  $$('.tab[data-t]').forEach(b => b.onclick = () => pageReminders(b.dataset.t));
  $$('[data-send]').forEach(b => b.onclick = async () => {
    try {
      const r = await withBusy(b, () => api('POST', `/api/reminders/${b.dataset.send}/send-now`));
      toast(r.ok ? (S.me.provider === 'test' ? 'Prepared (test mode) — see Outbox to send' : 'Sent') : 'Could not send: ' + r.message, r.ok ? 'ok' : 'err');
      pageReminders(tab); refreshBadges();
    } catch (e) { showError(e); }
  });
}

async function pageOutbox() {
  const list = await api('GET', '/api/outbox');
  $('#view').innerHTML = `
    <div class="page-head"><h1>${icon('inbox', 30)} Message Outbox</h1><a class="btn" href="#/reminders">${icon('bell')} Reminders</a></div>
    ${S.me.provider === 'test' ? `<div class="alert blue">${icon('info')}<div><b>Test mode</b>Messages are NOT sent automatically yet.
      Tap <b>Open in WhatsApp</b> to send each one from this computer's WhatsApp (WhatsApp Web / Desktop). The owner can connect automatic sending in Settings.</div></div>` : ''}
    ${list.length ? list.map(o => `<div class="card">
      <div class="row between"><div><b>${esc(o.recipient_name || '')}</b> · ${esc(o.phone)} ·
        ${o.event_id ? `<a href="#/events/${o.event_id}">${esc(o.event_title || 'Booking #' + o.event_id)}</a>` : ''}</div>
        <div class="row">${o.ok ? '<span class="badge b-green">Prepared / sent</span>' : `<span class="badge b-red">Failed</span>`}
        <span class="muted small">${fmtDT(o.created_at)} · ${esc(o.provider)}</span></div></div>
      ${o.error ? `<p class="small" style="color:var(--red)">${esc(o.error)}</p>` : ''}
      <pre style="white-space:pre-wrap;font-family:inherit;background:var(--surface-2);padding:.8rem;border-radius:10px;margin:.6rem 0">${esc(o.message)}</pre>
      <a class="btn wa" target="_blank" rel="noopener" href="${esc(o.wa_link)}">${icon('chat')} Open in WhatsApp</a></div>`).join('')
      : emptyBox('inbox', 'No messages yet. They appear here when reminders are due.')}`;
}

/* ---------- stock */
const ING_UNITS = ['kg', 'litre', 'pieces', 'packets', 'boxes', 'grams', 'dozen'];
async function pageStock() {
  const q = Object.fromEntries(new URLSearchParams((location.hash.split('?')[1]) || ''));
  const tab = q.tab || 'levels';
  const TABS = { levels: [icon('box', 20), 'Stock levels'], plan: [icon('cart', 20), 'Shopping plan'], expiry: [icon('clock', 20), 'Expiring soon'] };
  $('#view').innerHTML = `
    <div class="page-head"><h1>${icon('box', 30)} Stock & Shopping</h1>
      <button class="btn accent" id="addIng">${icon('plus')} Add ingredient</button></div>
    <div class="tabs">${Object.entries(TABS).map(([k, [ic, l]]) => `<a class="tab ${k === tab ? 'on' : ''}" href="#/stock?tab=${k}">${ic} ${l}</a>`).join('')}</div>
    <div id="stockBody"><p class="muted">Loading…</p></div>`;
  $('#addIng').onclick = () => ingredientModal(null);
  if (tab === 'plan') return stockPlan(+(q.days || 30));
  const data = await api('GET', '/api/stock');
  if (tab === 'expiry') {
    $('#stockBody').innerHTML = data.expiring.length ? `<div class="table-wrap"><table><thead><tr><th>Ingredient</th><th class="num">Quantity left</th><th>Expiry date</th><th></th></tr></thead><tbody>
      ${data.expiring.map(b => { const exp = b.expiry_date < todayISO(); return `<tr class="${exp ? 'r-red' : 'r-amber'}"><td><b>${esc(b.name)}</b></td><td class="num">${qty(b.qty_left)} ${esc(b.unit)}</td>
        <td>${exp ? `<span class="badge b-red">EXPIRED ${fmtDateShort(b.expiry_date)}</span>` : `<span class="badge b-amber">${fmtDateShort(b.expiry_date)}</span>`}</td>
        <td>${exp ? `<button class="btn small danger" data-writeoff="${b.ingredient_id}">${icon('trash', 18)} Throw away (remove from stock)</button>` : 'Use first'}</td></tr>`; }).join('')}
      </tbody></table></div>` : emptyBox('check', 'Nothing expires in the next 3 days.');
    $$('[data-writeoff]').forEach(b => b.onclick = async () => {
      if (!(await confirmBox({ title: 'Remove expired stock?', text: 'All expired quantity of this ingredient will be removed from stock.', ok: 'Yes, remove', danger: true }))) return;
      try { const r = await api('POST', `/api/ingredients/${b.dataset.writeoff}/adjust`, { action: 'write_off_expired' }); toast(`Removed ${r.qty}`); pageStock(); } catch (e) { showError(e); }
    });
    return;
  }
  const items = data.items;
  const SB = { out: ['OUT OF STOCK', 'b-red'], low: ['LOW — reorder', 'b-amber'], ok: ['OK', 'b-green'] };
  $('#stockBody').innerHTML = `
    <div class="row" style="margin-bottom:1rem"><div class="search">${icon('search')}<input id="sq" placeholder="Search ingredient"></div></div>
    <div class="table-wrap"><table><thead><tr><th>Ingredient</th><th class="num">In stock</th><th>Status</th><th class="num">Reorder when below</th>
      <th class="num">Suggested order</th><th class="num">Lasts about</th><th>Class</th><th></th></tr></thead><tbody id="stockRows">
      ${items.map(i => `<tr class="${i.status === 'out' ? 'r-red' : i.status === 'low' ? 'r-amber' : ''}" data-name="${esc(i.name.toLowerCase())}">
        <td><b>${esc(i.name)}</b>${i.expiring_soon ? `<br><span class="badge b-amber">${qty(i.expiring_soon)} ${esc(i.unit)} expiring soon</span>` : ''}</td>
        <td class="num" style="font-size:1.1rem"><b>${qty(i.on_hand)}</b> ${esc(i.unit)}</td>
        <td><span class="badge ${SB[i.status][1]}">${SB[i.status][0]}</span></td>
        <td class="num">${qty(i.rop)} ${esc(i.unit)}${i.reorder_level != null ? '<br><span class="small muted">(set by hand)</span>' : ''}</td>
        <td class="num">${i.eoq ? `${qty(i.eoq)} ${esc(i.unit)}` : '—'}</td>
        <td class="num">${i.days_cover != null ? `${i.days_cover} days` : '—'}</td>
        <td><span class="badge ${i.abc === 'A' ? 'b-red' : i.abc === 'B' ? 'b-amber' : 'b-grey'}" title="A = most money spent, watch closely">${i.abc}</span></td>
        <td class="actions"><div class="row" style="gap:.3rem">
          <button class="btn small primary" data-recv="${i.id}">${icon('plus', 18)} Received</button>
          <button class="btn small" data-use="${i.id}">${icon('minus', 18)} Used / wasted</button>
          <button class="btn small ghost" data-edit="${i.id}" title="Edit">${icon('edit', 18)}</button>
          <button class="btn small ghost" data-hist="${i.id}" title="History">${icon('list', 18)}</button></div></td></tr>`).join('')}
    </tbody></table></div>
    <details class="help" style="margin-top:1rem"><summary>${icon('info', 18)} How are these numbers calculated?</summary>
      <ul>
        <li><b>Reorder when below</b> (reorder point) = average daily use × supplier days + safety stock. Safety stock covers busy days (${Math.round(+S.cfg.settings.service_level * 100)}% service level).</li>
        <li><b>Suggested order</b> (Economic Order Quantity) balances the cost of ordering (${money(S.cfg.settings.order_cost)} per order) against the cost of keeping stock.</li>
        <li><b>Lasts about</b> = stock ÷ forecast daily use (smoothed from the last 60 days).</li>
        <li><b>Class A/B/C</b>: A items are the ~80% of your spending — check them most often.</li>
        <li>Bookings are planned separately in the <a href="#/stock?tab=plan">Shopping plan</a> from each menu and recipe.</li>
        <li>Stock is always used <b>first-expiry-first-out</b>.</li></ul></details>`;
  $('#sq').addEventListener('input', ev => { const v = ev.target.value.toLowerCase(); $$('#stockRows tr').forEach(tr => tr.classList.toggle('hidden', !tr.dataset.name.includes(v))); });
  const find = id => items.find(i => i.id === +id);
  $$('[data-recv]').forEach(b => b.onclick = () => receiveModal(find(b.dataset.recv)));
  $$('[data-use]').forEach(b => b.onclick = () => useModal(find(b.dataset.use)));
  $$('[data-edit]').forEach(b => b.onclick = () => ingredientModal(find(b.dataset.edit)));
  $$('[data-hist]').forEach(b => b.onclick = () => historyModal(find(b.dataset.hist)));
}

async function stockPlan(days) {
  const p = await api('GET', `/api/stock/plan?days=${days}`);
  const byEvent = {};
  p.lines.forEach(l => (byEvent[l.event_id] = byEvent[l.event_id] || { ...l, lines: [] }).lines.push(l));
  $('#stockBody').innerHTML = `
    <div class="row" style="margin-bottom:1rem"><span class="f">Plan for bookings in the next</span>
      ${[7, 14, 30, 60].map(d => `<a class="tab ${d === days ? 'on' : ''}" href="#/stock?tab=plan&days=${d}">${d} days</a>`).join('')}
      <button class="btn no-print" onclick="window.print()">${icon('printer')} Print shopping list</button></div>
    <h2 class="section-title">${icon('cart')} Shopping list</h2>
    ${p.shopping.length ? `<div class="table-wrap"><table><thead><tr><th>Ingredient</th><th class="num">Short by</th><th class="num">Suggested to buy</th><th class="num">Approx. cost</th><th>Order by</th><th>Needed for</th></tr></thead><tbody>
      ${p.shopping.map(s => `<tr class="${s.overdue ? 'r-red' : ''}"><td><b>${esc(s.ingredient)}</b></td><td class="num">${qty(s.shortage)} ${esc(s.unit)}</td>
        <td class="num"><b>${qty(s.suggested_qty)} ${esc(s.unit)}</b></td><td class="num">${money(s.est_cost)}</td>
        <td>${s.overdue ? `<span class="badge b-red">${icon('alert', 16)} LATE — was ${fmtDateShort(s.order_by)}</span>` : `<b>${fmtDate(s.order_by)}</b>`}</td>
        <td class="small">${esc([...new Set(s.events)].join(', '))}</td></tr>`).join('')}</tbody></table></div>`
      : `<div class="alert green">${icon('check')}<div><b>Enough stock for all bookings in the next ${days} days</b>Based on the recipes of each booking.</div></div>`}
    <h2 class="section-title">${icon('calendar')} Per booking</h2>
    ${Object.values(byEvent).map(ev => { const short = ev.lines.filter(l => l.shortage > 0); return `<details class="card">
      <summary><span class="row" style="display:inline-flex">${fmtDateShort(ev.event_date)} · ${esc(ev.event_title)} ${ev.event_status === 'enquiry' ? '<span class="badge b-blue">Enquiry — not reserved</span>' : ''}
        ${short.length ? `<span class="badge b-red">${short.length} short</span>` : '<span class="badge b-green">All in stock</span>'}</span></summary>
      <div class="table-wrap" style="margin-top:.6rem"><table><thead><tr><th>Ingredient</th><th class="num">Needed</th><th class="num">From stock</th><th class="num">Short</th><th>Order by</th></tr></thead><tbody>
        ${ev.lines.map(l => `<tr class="${l.shortage > 0 ? 'r-red' : ''}"><td>${esc(l.ingredient)}</td><td class="num">${qty(l.required)} ${esc(l.unit)}</td><td class="num">${qty(l.covered)}</td>
          <td class="num">${l.shortage > 0 ? `<b style="color:var(--red)">${qty(l.shortage)}</b>` : '—'}</td><td>${l.shortage > 0 ? fmtDateShort(l.order_by) : ''}</td></tr>`).join('')}</tbody></table></div>
      <a class="btn small" href="#/events/${ev.event_id}" style="margin-top:.6rem">Open booking ${icon('right', 16)}</a></details>`; }).join('') || emptyBox('calendar', 'No bookings with recipes in this period.')}
    <p class="help">${icon('info', 18)} Bookings are planned in date order. Stock that will be expired by the event date is not counted. “Order by” = event date − supplier days. Wastage of ${esc(S.cfg.settings.wastage_pct)}% is added.</p>`;
}

function receiveModal(i) {
  const m = openModal(`<h2>${icon('plus')} Stock received: ${esc(i.name)}</h2>
    <div class="grid2" id="rf">
      <div class="field"><label class="f">Quantity received (${esc(i.unit)}) <span class="req">*</span></label><input name="qty" type="number" min="0" step="any" inputmode="decimal"></div>
      <div class="field"><label class="f">Expiry date</label><input name="expiry_date" type="date">
        <div class="hint">${i.shelf_life_days ? `Leave empty = ${i.shelf_life_days} days from today` : 'Leave empty if it does not expire'}</div></div>
      <div class="field"><label class="f">Price per ${esc(i.unit)}</label><input name="unit_cost" type="number" min="0" step="any" value="${i.unit_cost || ''}"></div>
      <div class="field"><label class="f">Note / supplier</label><input name="note"></div></div>
    <div class="modal-foot"><button class="btn" data-close>${icon('x')} Cancel</button><button class="btn primary big" data-ok>${icon('check')} Save</button></div>`);
  $('[data-ok]', m.el).onclick = async ev => {
    const d = formData($('#rf', m.el));
    if (!(+d.qty > 0)) return toast('Please type the quantity', 'err');
    try { await withBusy(ev.currentTarget, () => api('POST', `/api/ingredients/${i.id}/receive`, d)); m.close(); toast('Stock added'); pageStock(); } catch (e) { showError(e); }
  };
}
function useModal(i) {
  const m = openModal(`<h2>${icon('minus')} Correct stock: ${esc(i.name)}</h2>
    <p>In stock now: <b>${qty(i.on_hand)} ${esc(i.unit)}</b></p>
    <div id="uf">
      <div class="choice-grid" style="margin-bottom:1rem">
        <label class="choice"><input type="radio" name="action" value="remove" checked> Remove (used / wasted)</label>
        <label class="choice"><input type="radio" name="action" value="add"> Add (count was wrong)</label></div>
      <div class="grid2"><div class="field"><label class="f">Quantity (${esc(i.unit)})</label><input name="qty" type="number" min="0" step="any" inputmode="decimal"></div>
        <div class="field"><label class="f">Reason</label><select name="reason"><option>Used in kitchen</option><option>Spoiled / wasted</option><option>Stock count correction</option><option>Given away</option></select></div></div></div>
    <div class="modal-foot"><button class="btn" data-close>${icon('x')} Cancel</button><button class="btn primary big" data-ok>${icon('check')} Save</button></div>`);
  $('[data-ok]', m.el).onclick = async ev => {
    const d = formData($('#uf', m.el));
    if (!(+d.qty > 0)) return toast('Please type the quantity', 'err');
    try {
      const r = await withBusy(ev.currentTarget, () => api('POST', `/api/ingredients/${i.id}/adjust`, d));
      m.close(); toast(r.shortfall ? `Only ${r.issued} was in stock` : 'Stock updated', r.shortfall ? 'err' : 'ok'); pageStock();
    } catch (e) { showError(e); }
  };
}
function ingredientModal(i) {
  const v = i || { name: '', unit: 'kg', reorder_level: '', lead_time_days: S.cfg.settings.default_lead_time || 2, unit_cost: '', shelf_life_days: '', active: 1 };
  const m = openModal(`<h2>${icon(i ? 'edit' : 'plus')} ${i ? 'Edit ingredient' : 'New ingredient'}</h2>
    <div class="grid2" id="inf">
      <div class="field"><label class="f">Name <span class="req">*</span></label><input name="name" value="${esc(v.name)}"></div>
      <div class="field"><label class="f">Unit</label><select name="unit">${ING_UNITS.map(u => `<option ${u === v.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
      <div class="field"><label class="f">Price per unit</label><input name="unit_cost" type="number" min="0" step="any" value="${esc(v.unit_cost)}"></div>
      <div class="field"><label class="f">Supplier delivery time (days)</label><input name="lead_time_days" type="number" min="0" value="${esc(v.lead_time_days)}"></div>
      <div class="field"><label class="f">Stays fresh for (days)</label><input name="shelf_life_days" type="number" min="0" value="${esc(v.shelf_life_days ?? '')}"><div class="hint">Empty = does not expire</div></div>
      <div class="field"><label class="f">Reorder level (optional)</label><input name="reorder_level" type="number" min="0" step="any" value="${esc(v.reorder_level ?? '')}"><div class="hint">Empty = calculated automatically</div></div>
      ${i ? `<label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> In use</label>` : ''}</div>
    <div class="modal-foot"><button class="btn" data-close>${icon('x')} Cancel</button><button class="btn primary big" data-ok>${icon('check')} Save</button></div>`);
  $('[data-ok]', m.el).onclick = async ev => {
    const d = formData($('#inf', m.el));
    if (!i) d.active = true;
    try { await withBusy(ev.currentTarget, () => api(i ? 'PUT' : 'POST', i ? `/api/ingredients/${i.id}` : '/api/ingredients', d)); m.close(); toast('Saved'); pageStock(); } catch (e) { showError(e); }
  };
}
async function historyModal(i) {
  const h = await api('GET', `/api/stock/${i.id}/history`);
  openModal(`<h2>${icon('list')} ${esc(i.name)} — history</h2>
    <h3>Batches in stock (used in this order)</h3>
    ${h.batches.length ? `<div class="table-wrap"><table><thead><tr><th>Received</th><th class="num">Left</th><th>Expiry</th><th>Note</th></tr></thead><tbody>
      ${h.batches.map(b => `<tr><td>${fmtDateShort(b.received_at)}</td><td class="num">${qty(b.qty_left)} ${esc(i.unit)}</td><td>${b.expiry_date ? fmtDateShort(b.expiry_date) : '—'}</td><td>${esc(b.note || '')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">None.</p>'}
    <h3 style="margin-top:1rem">Last movements</h3>
    <div class="table-wrap"><table><tbody>${h.moves.map(mv => `<tr><td class="nowrap">${fmtDT(mv.created_at)}</td><td class="num" style="color:${mv.qty < 0 ? 'var(--red)' : 'var(--green)'}"><b>${mv.qty > 0 ? '+' : ''}${Math.round(mv.qty * 1000) / 1000}</b></td>
      <td>${esc(mv.reason)}${mv.event_id ? ` <a href="#/events/${mv.event_id}">#${mv.event_id}</a>` : ''}</td><td class="small muted">${esc(mv.created_by || '')}</td></tr>`).join('')}</tbody></table></div>
    <div class="modal-foot"><button class="btn primary" data-close>${icon('check')} Close</button></div>`, { wide: true });
}

/* ---------- menu & recipes */
async function pageMenu() {
  const [menu, stock] = await Promise.all([api('GET', '/api/menu'), api('GET', '/api/stock')]);
  S.menu = menu;
  const ings = stock.items;
  $('#view').innerHTML = `
    <div class="page-head"><h1>${icon('utensils', 30)} Menu & Recipes</h1><button class="btn accent" id="addMenu">${icon('plus')} Add menu item</button></div>
    <div class="help" style="margin-bottom:1rem">${icon('info', 18)} For each dish, enter how much of each ingredient one plate needs. Then every booking automatically shows the ingredients to buy.</div>
    <div class="table-wrap"><table><thead><tr><th>Dish</th><th>Category</th><th>Type</th><th class="num">Price</th><th>Recipe</th><th></th></tr></thead><tbody>
      ${menu.map(m => `<tr class="${m.active ? '' : 'muted'}"><td><b>${esc(m.name)}</b>${m.active ? '' : ' <span class="badge b-grey">Not in use</span>'}</td><td>${esc(m.category || '')}</td>
        <td>${esc(DIETS[m.diet || ''] || '')}</td><td class="num">${money(m.price)} / ${esc(m.unit)}</td>
        <td>${m.recipe_lines ? `<span class="badge b-green">${m.recipe_lines} ingredients</span>` : '<span class="badge b-amber">No recipe</span>'}</td>
        <td><button class="btn small" data-edit="${m.id}">${icon('edit', 18)} Change</button></td></tr>`).join('')}
    </tbody></table></div>`;
  $('#addMenu').onclick = () => menuModal(null, ings);
  $$('[data-edit]').forEach(b => b.onclick = () => menuModal(menu.find(m => m.id === +b.dataset.edit), ings));
}
async function menuModal(m, ings) {
  const recipe = m ? await api('GET', `/api/menu/${m.id}/recipe`) : [];
  const v = m || { name: '', category: '', unit: 'plates', price: '', diet: 'veg', active: 1 };
  const rows = recipe.map(r => ({ ingredient_id: r.ingredient_id, qty_per_unit: r.qty_per_unit }));
  const md = openModal(`<h2>${icon(m ? 'edit' : 'plus')} ${m ? 'Change menu item' : 'New menu item'}</h2>
    <div class="grid2" id="mf">
      <div class="field"><label class="f">Dish name <span class="req">*</span></label><input name="name" value="${esc(v.name)}"></div>
      <div class="field"><label class="f">Category</label><input name="category" value="${esc(v.category || '')}" placeholder="Main course, Dessert…"></div>
      <div class="field"><label class="f">Price</label><input name="price" type="number" min="0" step="any" value="${esc(v.price)}"></div>
      <div class="field"><label class="f">Per</label><select name="unit">${S.cfg.units.map(u => `<option ${u === v.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
      <div class="field"><label class="f">Type</label><select name="diet">${Object.entries(DIETS).map(([k, l]) => `<option value="${k}" ${k === (v.diet || '') ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> In use (shown when booking)</label></div>
    <h3 style="margin-top:1rem">Recipe — ingredients for ONE <span id="unitLbl">${esc(v.unit === 'plates' ? 'plate' : v.unit)}</span></h3>
    <div id="recRows"></div>
    <button class="btn" id="addRec">${icon('plus')} Add ingredient</button>
    <div class="modal-foot"><button class="btn" data-close>${icon('x')} Cancel</button><button class="btn primary big" data-ok>${icon('check')} Save</button></div>`, { wide: true });
  const draw = () => {
    $('#recRows', md.el).innerHTML = rows.map((r, i) => `<div class="contact-row" style="grid-template-columns:2fr 1fr auto">
      <div><label>Ingredient</label><select data-r="${i}" data-f="ingredient_id"><option value="">— choose —</option>${ings.map(g => `<option value="${g.id}" ${g.id === +r.ingredient_id ? 'selected' : ''}>${esc(g.name)} (${esc(g.unit)})</option>`).join('')}</select></div>
      <div><label>Amount per ${esc(v.unit === 'plates' ? 'plate' : v.unit)}</label><input type="number" min="0" step="any" data-r="${i}" data-f="qty_per_unit" value="${esc(r.qty_per_unit)}"></div>
      <div><button class="btn danger" data-delr="${i}">${icon('trash')}</button></div></div>`).join('') || '<p class="muted">No ingredients yet.</p>';
    $$('[data-r]', md.el).forEach(el => el.addEventListener('input', () => { rows[+el.dataset.r][el.dataset.f] = el.value; }));
    $$('[data-r]', md.el).forEach(el => el.addEventListener('change', () => { rows[+el.dataset.r][el.dataset.f] = el.value; }));
    $$('[data-delr]', md.el).forEach(b => b.onclick = () => { rows.splice(+b.dataset.delr, 1); draw(); });
  };
  draw();
  $('#addRec', md.el).onclick = () => { rows.push({ ingredient_id: '', qty_per_unit: '' }); draw(); };
  $('[data-ok]', md.el).onclick = async ev => {
    const d = formData($('#mf', md.el));
    d.recipe = rows.filter(r => r.ingredient_id && +r.qty_per_unit > 0).map(r => ({ ingredient_id: +r.ingredient_id, qty_per_unit: +r.qty_per_unit }));
    try { await withBusy(ev.currentTarget, () => api(m ? 'PUT' : 'POST', m ? `/api/menu/${m.id}` : '/api/menu', d)); md.close(); toast('Menu saved'); pageMenu(); } catch (e) { showError(e); }
  };
}

/* ---------- customers */
async function pageCustomers(qv = '') {
  const list = await api('GET', '/api/customers' + (qv ? `?q=${encodeURIComponent(qv)}` : ''));
  $('#view').innerHTML = `
    <div class="page-head"><h1>${icon('users', 30)} Customers</h1></div>
    <div class="row" style="margin-bottom:1rem"><div class="search">${icon('search')}<input id="cq" placeholder="Search name, phone or address" value="${esc(qv)}"></div></div>
    ${list.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Phone</th><th class="num">Bookings</th><th>Last event</th><th></th></tr></thead><tbody>
      ${list.map(c => `<tr class="click" data-id="${c.id}"><td><b>${esc(c.name)}</b>${c.address ? `<br><span class="small muted">${esc(c.address)}</span>` : ''}</td>
        <td>${esc(c.phone)}</td><td class="num">${c.bookings}</td><td>${c.last_event ? fmtDateShort(c.last_event) : '—'}</td>
        <td><span class="row" style="gap:.3rem;color:var(--primary);font-weight:700">Open ${icon('right', 18)}</span></td></tr>`).join('')}</tbody></table></div>`
      : emptyBox('users', 'No customers found.')}`;
  let t;
  $('#cq').addEventListener('input', ev => { clearTimeout(t); t = setTimeout(() => pageCustomers(ev.target.value.trim()).then(() => { const i = $('#cq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }), 350); });
  $$('tr.click').forEach(tr => tr.onclick = () => customerModal(list.find(c => c.id === +tr.dataset.id)));
}
async function customerModal(c) {
  const evs = await api('GET', `/api/events?customer_id=${c.id}&order=desc`);
  const m = openModal(`<h2>${icon('user')} ${esc(c.name)}</h2>
    <div class="grid2" id="cf">
      <div class="field"><label class="f">Name</label><input name="name" value="${esc(c.name)}"></div>
      <div class="field"><label class="f">Phone</label><input name="phone" type="tel" value="${esc(c.phone)}"></div>
      <div class="field"><label class="f">Other phone</label><input name="alt_phone" type="tel" value="${esc(c.alt_phone || '')}"></div>
      <div class="field"><label class="f">Address</label><input name="address" value="${esc(c.address || '')}"></div></div>
    <div class="field"><label class="f">Notes</label><textarea name="notes" form="cf">${esc(c.notes || '')}</textarea></div>
    <div class="row"><a class="btn" href="tel:${esc(c.phone)}">${icon('phone')} Call</a><a class="btn wa" target="_blank" rel="noopener" href="${waHref(c.phone)}">${icon('chat')} WhatsApp</a>
      <button class="btn accent" data-new>${icon('plus')} New booking for this customer</button></div>
    <h3 style="margin-top:1.2rem">Bookings (${evs.length})</h3>
    <div class="ev-list">${evs.map(evCard).join('') || '<p class="muted">None.</p>'}</div>
    <div class="modal-foot"><button class="btn" data-close>${icon('x')} Close</button><button class="btn primary big" data-ok>${icon('check')} Save changes</button></div>`, { wide: true });
  $$('.ev', m.el).forEach(a => a.addEventListener('click', () => m.close()));
  $('[data-new]', m.el).onclick = () => {
    sessionStorage.setItem('cm.prefill', JSON.stringify({ customer: { name: c.name, phone: c.phone, alt_phone: c.alt_phone || '', address: c.address || '' } }));
    m.close(); location.hash = '#/events/new';
  };
  $('[data-ok]', m.el).onclick = async ev => {
    const d = formData($('#cf', m.el));
    d.notes = $('textarea[name=notes]', m.el).value;
    try { await withBusy(ev.currentTarget, () => api('PUT', `/api/customers/${c.id}`, d)); m.close(); toast('Customer saved'); pageCustomers(); } catch (e) { showError(e); }
  };
}

/* ---------- settings */
async function pageSettings() {
  await loadConfig();
  const me = await api('GET', '/api/me');
  const s = S.cfg.settings;
  const admin = S.me.role === 'admin';
  const dis = admin ? '' : 'disabled';
  const inp = (k, label, type = 'text', hint = '', attrs = '') => `<div class="field"><label class="f">${label}</label>
    <input name="${k}" type="${type}" value="${esc(s[k] ?? '')}" ${dis} ${attrs}>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  const chk = (k, label) => `<label class="check"><input type="checkbox" name="${k}" ${s[k] === '1' ? 'checked' : ''} ${dis}> ${label}</label>`;
  const COMMON = ['7d', '3d', '2d', '1d', '12h', '4h', '2h'];
  const offs = (s.reminder_offsets || '').split(',').map(x => x.trim());
  $('#view').innerHTML = `
    <div class="page-head"><h1>${icon('settings', 30)} Settings</h1></div>
    ${admin ? '' : `<div class="alert amber">${icon('lock')}<div><b>Only the owner can change these settings</b>You can change your own PIN below.</div></div>`}
    <div id="sf">
    <div class="card"><h2>${icon('home')} Business</h2>
      <div class="grid2">${inp('business_name', 'Business name')}${inp('business_phone', 'Business phone (shown in messages)', 'tel')}
        ${inp('owner_phone', 'Owner WhatsApp number (gets urgent alerts)', 'tel', 'Alerts when a customer is not re-confirmed or a message fails.')}
        ${inp('currency', 'Currency symbol')}${inp('country_code', 'Country code', 'text', '91 = India. Used when a number is typed without it.')}
        ${inp('max_events_per_day', 'Maximum bookings per day', 'number', 'You get a warning when a day is full.', 'min="1"')}</div></div>
    <div class="card"><h2>${icon('bell')} Reminders</h2>
      <label class="f">Send reminders this long before each event</label>
      <div class="choice-grid" id="offChoices">${COMMON.map(o => `<button type="button" class="choice ${offs.includes(o) || o === '2d' ? 'on' : ''}" data-off="${o}" ${o === '2d' ? 'disabled title="The 2-day warning is always sent"' : ''} ${dis}>${offsetLabel('before_' + o).replace(' — WARNING', ' (always)')}</button>`).join('')}</div>
      <input type="hidden" name="reminder_offsets" value="${esc(s.reminder_offsets)}">
      <div class="grid3" style="margin-top:1rem">${inp('quiet_start', 'No messages after', 'time')}${inp('quiet_end', 'No messages before', 'time')}
        ${inp('ack_hours', 'Alert owner if not re-confirmed within (hours)', 'number', '', 'min="1"')}</div>
      ${chk('send_booking_confirmation', 'Send a confirmation message to the customer when a booking is saved')}
      ${chk('notify_on_change', 'Send a message to everyone when date or time is changed')}
      ${chk('remind_customer', 'Remind the customer by default on new bookings')}</div>
    <div class="card"><h2>${icon('chat')} WhatsApp sending</h2>
      <div class="choice-grid">
        ${[['test', 'Test mode (send by hand)'], ['meta', 'Meta WhatsApp Cloud API'], ['twilio', 'Twilio WhatsApp']].map(([k, l]) => `<label class="choice ${s.whatsapp_provider === k ? 'on' : ''}"><input type="radio" name="whatsapp_provider" value="${k}" ${s.whatsapp_provider === k ? 'checked' : ''} ${dis} style="display:none"> ${l}</label>`).join('')}</div>
      <p class="hint">For Meta or Twilio, the account keys go in the file <b>config.env</b> next to the program (see README). Keys are never stored in the database.</p>
      <p class="small">Reminder checker: ${me.scheduler.running ? `<span class="badge b-green">running</span> last check ${fmtDT(me.scheduler.last_run)}` : '<span class="badge b-red">NOT running</span>'}
        ${me.scheduler.last_error ? `<span class="badge b-red">${esc(me.scheduler.last_error)}</span>` : ''}</p></div>
    <div class="card"><h2>${icon('box')} Stock planning</h2>
      <div class="grid3">${inp('wastage_pct', 'Extra for wastage (%)', 'number', '', 'min="0" step="any"')}
        <div class="field"><label class="f">Safety level</label><select name="service_level" ${dis}>${[['0.90', '90% — normal'], ['0.95', '95% — safe'], ['0.98', '98% — very safe'], ['0.99', '99% — never run out']].map(([v, l]) => `<option value="${v}" ${(+s.service_level).toFixed(2) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        ${inp('default_lead_time', 'Usual supplier delivery (days)', 'number', '', 'min="0"')}
        ${inp('order_cost', 'Cost of placing one order', 'number', 'Transport, time, phone…', 'min="0" step="any"')}
        ${inp('holding_rate', 'Yearly cost of keeping stock (0.20 = 20%)', 'number', '', 'min="0" step="0.01"')}</div></div>
    </div>
    ${admin ? `<div class="wizard-foot"><span></span><button class="btn primary big" id="saveSettings">${icon('check')} Save settings</button></div>` : ''}

    ${admin ? `<div class="card"><div class="row between"><h2>${icon('users')} Staff & PINs</h2><button class="btn accent" id="addStaff">${icon('plus')} Add person</button></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>WhatsApp</th><th>Status</th><th></th></tr></thead><tbody>
      ${S.cfg.staff.map(st => `<tr><td><b>${esc(st.name)}</b></td><td>${st.role === 'admin' ? 'Owner' : 'Staff'}</td><td>${esc(st.phone || '—')}</td>
        <td>${st.active ? '<span class="badge b-green">Active</span>' : '<span class="badge b-grey">Removed</span>'}</td>
        <td><button class="btn small" data-staff="${st.id}">${icon('edit', 18)} Change</button></td></tr>`).join('')}</tbody></table></div>
      <p class="hint">Each person logs in with their own PIN, so the change history shows who did what.</p></div>

    <div class="card"><div class="row between"><h2>${icon('columns')} Extra booking fields (your own columns)</h2></div>
      <p class="muted">Add your own fields to every booking — they also appear as columns in the booking list and in the Excel export.</p>
      ${S.cfg.custom_fields.map(f => `<div class="row between" style="padding:.5rem 0;border-bottom:1px solid var(--line)"><span><b>${esc(f.label)}</b> <span class="muted small">(${esc(f.field_type)}${f.options ? ': ' + esc(f.options) : ''})</span></span>
        <button class="btn small" data-field-toggle="${f.id}" data-active="${f.active}">${f.active ? icon('x', 18) + ' Hide' : icon('check', 18) + ' Show'}</button></div>`).join('') || '<p class="muted">None yet.</p>'}
      <div class="grid3" id="ff" style="margin-top:1rem">
        <div class="field"><label class="f">Field name</label><input name="label" placeholder="e.g. Number of servers"></div>
        <div class="field"><label class="f">Type</label><select name="field_type"><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="yesno">Yes / No</option><option value="choice">Pick from list</option></select></div>
        <div class="field"><label class="f">List choices (comma separated)</label><input name="options" placeholder="only for “Pick from list”"></div></div>
      <button class="btn primary" id="addField">${icon('plus')} Add field</button></div>` : ''}

    <div class="card"><h2>${icon('lock')} My PIN</h2>
      <div class="grid3" id="pf"><div class="field"><label class="f">Current PIN</label><input name="old_pin" type="password" inputmode="numeric"></div>
        <div class="field"><label class="f">New PIN (4–6 numbers)</label><input name="new_pin" type="password" inputmode="numeric"></div>
        <div class="field" style="align-self:end"><button class="btn primary" id="savePin">${icon('check')} Change my PIN</button></div></div></div>

    <div class="card"><h2>${icon('download')} Backup & export</h2>
      <div class="row">${admin ? `<a class="btn primary" href="/api/backup">${icon('download')} Download full backup</a>` : ''}
        <a class="btn" href="/api/export/events.csv">${icon('download')} Export bookings to Excel</a>
        ${admin ? `<button class="btn danger" id="clearSamples">${icon('trash')} Remove sample bookings</button>` : ''}</div>
      <p class="hint">Keep a backup copy on a pen drive or Google Drive every week. The data file is <b>data/catering.db</b>.</p></div>

    ${admin ? `<div class="card"><details id="auditBox"><summary>${icon('list', 18)} Activity log (who changed what)</summary><div id="auditList"><p class="muted">Loading…</p></div></details></div>` : ''}`;

  if (admin) {
    $$('#offChoices [data-off]').forEach(b => b.onclick = () => {
      b.classList.toggle('on');
      const extra = offs.filter(o => !COMMON.includes(o) && o);
      $('[name=reminder_offsets]').value = $$('#offChoices .choice.on').map(x => x.dataset.off).concat(extra).join(',');
    });
    $$('label.choice input[type=radio]').forEach(r => r.addEventListener('change', () => $$('label.choice').forEach(l => l.classList.toggle('on', $('input', l)?.checked))));
    $('#saveSettings').onclick = async ev => {
      const d = formData($('#sf'));
      ['send_booking_confirmation', 'notify_on_change', 'remind_customer'].forEach(k => { d[k] = d[k] ? '1' : '0'; });
      try { await withBusy(ev.currentTarget, () => api('PUT', '/api/settings', d)); S.me = await api('GET', '/api/me'); toast('Settings saved'); renderShell(); route(); } catch (e) { showError(e); }
    };
    $('#addStaff').onclick = () => staffModal(null);
    $$('[data-staff]').forEach(b => b.onclick = () => staffModal(S.cfg.staff.find(x => x.id === +b.dataset.staff)));
    $('#addField').onclick = async ev => {
      const d = formData($('#ff'));
      if (!d.label) return toast('Please type a field name', 'err');
      try { await withBusy(ev.currentTarget, () => api('POST', '/api/custom-fields', d)); toast('Field added'); pageSettings(); } catch (e) { showError(e); }
    };
    $$('[data-field-toggle]').forEach(b => b.onclick = async () => {
      try { await api('PUT', `/api/custom-fields/${b.dataset.fieldToggle}`, { active: b.dataset.active !== '1' }); pageSettings(); } catch (e) { showError(e); }
    });
    $('#clearSamples').onclick = async () => {
      if (!(await confirmBox({ title: 'Remove the sample bookings?', text: 'The 4 example bookings (customers named “Sample - …”) will be deleted. Your own bookings are not touched.', ok: 'Remove samples', danger: true }))) return;
      try { const r = await api('POST', '/api/sample-data/clear'); toast(`${r.removed} sample bookings removed`); } catch (e) { showError(e); }
    };
    $('#auditBox').addEventListener('toggle', async ev => {
      if (!ev.target.open) return;
      const log = await api('GET', '/api/audit');
      $('#auditList').innerHTML = `<div class="table-wrap"><table><tbody>${log.map(a => `<tr><td class="nowrap small">${fmtDT(a.at)}</td><td><b>${esc(a.staff_name || '')}</b></td>
        <td>${esc(a.entity)}${a.entity_id ? (a.entity === 'event' ? ` <a href="#/events/${a.entity_id}">#${a.entity_id}</a>` : ' #' + a.entity_id) : ''}</td><td>${esc(a.action)}</td>
        <td class="small muted">${esc((a.detail || '').slice(0, 160))}</td></tr>`).join('')}</tbody></table></div>`;
    });
  }
  $('#savePin').onclick = async ev => {
    try { await withBusy(ev.currentTarget, () => api('POST', '/api/me/pin', formData($('#pf')))); toast('PIN changed'); $$('#pf input').forEach(i => { i.value = ''; }); } catch (e) { showError(e); }
  };
}
function staffModal(st) {
  const v = st || { name: '', role: 'staff', phone: '', active: 1 };
  const m = openModal(`<h2>${icon(st ? 'edit' : 'plus')} ${st ? 'Change ' + esc(st.name) : 'Add a person'}</h2>
    <div class="grid2" id="stf">
      <div class="field"><label class="f">Name</label><input name="name" value="${esc(v.name)}"></div>
      <div class="field"><label class="f">WhatsApp number (optional)</label><input name="phone" type="tel" value="${esc(v.phone || '')}"><div class="hint">To add them to reminders with one tap.</div></div>
      <div class="field"><label class="f">Role</label><select name="role"><option value="staff" ${v.role === 'staff' ? 'selected' : ''}>Staff</option><option value="admin" ${v.role === 'admin' ? 'selected' : ''}>Owner (can change settings)</option></select></div>
      <div class="field"><label class="f">${st ? 'New PIN (leave empty to keep)' : 'PIN (4–6 numbers)'}</label><input name="pin" type="password" inputmode="numeric"></div>
      ${st ? `<label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Can log in</label>` : ''}</div>
    <div class="modal-foot"><button class="btn" data-close>${icon('x')} Cancel</button><button class="btn primary big" data-ok>${icon('check')} Save</button></div>`);
  $('[data-ok]', m.el).onclick = async ev => {
    const d = formData($('#stf', m.el));
    if (st && !d.pin) delete d.pin;
    try { await withBusy(ev.currentTarget, () => api(st ? 'PUT' : 'POST', st ? `/api/staff/${st.id}` : '/api/staff', d)); m.close(); toast('Saved'); pageSettings(); } catch (e) { showError(e); }
  };
}

// Run: node web/tests/store.test.js
const assert = require('assert');
const mem = {};
globalThis.localStorage = { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = v; } };
const S = require('../js/store.js');

function fresh() {
  S._setDB(S.emptyDB());
  const db = S.db;
  db.customers.push({ id: 'c1', name: 'Ravi', phone: '+919999900000' });
  db.waNumbers.push({ id: 'w1', name: 'Owner', phone: '+919000011111', role: 'owner' });
  return db;
}
function book(db, date, time, extra = {}) {
  const b = { id: 'b' + db.bookings.length, customerId: 'c1', title: 'Wedding', date, time, guests: 100, status: 'confirmed', items: [], payments: [], ...extra };
  db.bookings.push(b);
  return b;
}
const T = (s) => S.parseDT(s);
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

test('phone formats', () => {
  ['9876543210', '09876543210', '+91 98765 43210', '0091 9876543210'].forEach(p => assert.strictEqual(S.normPhone(p, '91'), '+919876543210'));
  ['0412 345 678', '412345678', '+61 412 345 678', '0061412345678'].forEach(p => assert.strictEqual(S.normPhone(p), '+61412345678')); // Australia is the default
  assert.throws(() => S.normPhone('123'));
});

test('plans customer + team reminders, quiet hours move earlier', () => {
  const db = fresh();
  book(db, '2026-01-20', '07:00');
  S.sync(T('2026-01-01T10:00'));
  const k = Object.fromEntries(db.notes.map(x => [x.kind + ':' + x.role, x.due]));
  assert.strictEqual(k['c2d:customer'], '2026-01-18T07:00');
  assert.strictEqual(k['tday:owner'], '2026-01-19T20:30'); // 04:00 would be night -> previous evening
});

test('late booking sends only the most urgent overdue reminder', () => {
  const db = fresh();
  book(db, '2026-01-10', '19:00');
  S.sync(T('2026-01-09T13:00')); // 30h before
  const cust = db.notes.filter(x => x.role === 'customer');
  assert.strictEqual(cust.find(x => x.kind === 'c2d').status, 'pending');
  assert.strictEqual(S.dueNotes(T('2026-01-09T13:00')).filter(x => x.role === 'customer').length, 1);
});

test('reschedule replaces planned reminders; cancel removes them', () => {
  const db = fresh();
  const b = book(db, '2026-01-20', '12:00');
  S.sync(T('2026-01-01T10:00'));
  b.date = '2026-01-25';
  S.sync(T('2026-01-01T10:05'));
  assert.ok(db.notes.filter(x => x.status === 'pending').every(x => x.start.startsWith('2026-01-25')));
  b.status = 'cancelled';
  S.sync(T('2026-01-01T10:10'));
  assert.strictEqual(db.notes.filter(x => x.status === 'pending').length, 0);
});

test('owner alert when not re-confirmed within 24h; none after re-confirm', () => {
  const db = fresh();
  const b = book(db, '2026-01-10', '12:00');
  S.sync(T('2026-01-09T14:00'));
  assert.ok(db.notes.some(x => x.kind === 'unconfirmed'));
  const db2 = fresh();
  book(db2, '2026-01-10', '12:00', { reconfirmedAt: 'x' });
  S.sync(T('2026-01-09T14:00'));
  assert.ok(!db2.notes.some(x => x.kind === 'unconfirmed'));
});

test('night: non-urgent held, sample bookings never messaged, past expire', () => {
  const db = fresh();
  book(db, '2026-01-20', '12:00');
  S.queueOneOff(db.bookings[0], 'confirm', T('2026-01-01T23:00'));
  S.sync(T('2026-01-01T23:00'));
  assert.strictEqual(S.dueNotes(T('2026-01-01T23:00')).length, 0);
  assert.strictEqual(S.dueNotes(T('2026-01-02T07:01')).length, 1);
  book(db, '2026-01-21', '12:00', { sample: true, id: 'sx' });
  S.sync(T('2026-01-02T08:00'));
  assert.ok(!db.notes.some(x => x.bookingId === 'sx'));
  S.sync(T('2026-01-30T08:00'));
  assert.ok(db.notes.filter(x => x.status === 'pending').length === 0);
});

test('message text has details', () => {
  const db = fresh();
  const b = book(db, '2026-01-20', '19:30', { items: [{ name: 'Veg Biryani', qty: 100, unit: 'plates' }], venue: 'Hall' });
  S.queueOneOff(b, 'confirm', T('2026-01-01T10:00'));
  const m = S.buildMessage(db.notes[0]);
  assert.ok(m.includes('CONFIRMED') && m.includes('7:30 PM') && m.includes('Veg Biryani — 100 plates'));
});

console.log(`\n${n} tests passed`);

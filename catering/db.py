"""SQLite schema, connection helpers, settings and first-run seed data."""
import json
import sqlite3
from datetime import timedelta

from werkzeug.security import generate_password_hash

from .util import now, iso

SCHEMA = """
CREATE TABLE IF NOT EXISTS staff(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pin_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff' CHECK(role IN ('admin','staff')),
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  alt_phone TEXT,
  address TEXT,
  notes TEXT,
  is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  title TEXT NOT NULL,
  event_type TEXT,
  event_date TEXT NOT NULL,
  end_date TEXT,
  event_time TEXT,
  venue TEXT,
  venue_map TEXT,
  guest_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'confirmed'
        CHECK(status IN ('enquiry','confirmed','completed','cancelled')),
  total_amount REAL NOT NULL DEFAULT 0,
  notes TEXT,
  special_instructions TEXT,
  assigned_staff_id INTEGER REFERENCES staff(id),
  extra TEXT NOT NULL DEFAULT '{}',
  stock_issued INTEGER NOT NULL DEFAULT 0,
  final_confirmed_at TEXT,
  final_confirmed_by TEXT,
  escalated_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT, updated_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_events_date ON events(event_date);

CREATE TABLE IF NOT EXISTS event_items(
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  menu_item_id INTEGER REFERENCES menu_items(id),
  item_name TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'plates',
  diet TEXT,
  notes TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS event_contacts(
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'other',
  UNIQUE(event_id, phone)
);

CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  paid_on TEXT NOT NULL,
  mode TEXT,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders(
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  recipient_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'other',
  kind TEXT NOT NULL,
  note TEXT,
  due_at TEXT NOT NULL,
  event_start TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','retry','sending','sent','failed','skipped','cancelled','expired')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  claimed_at TEXT,
  last_error TEXT,
  message TEXT,
  sent_at TEXT,
  escalated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(event_id, kind, phone)
);
CREATE INDEX IF NOT EXISTS ix_reminders_due ON reminders(status, due_at);

CREATE TABLE IF NOT EXISTS outbox(
  id INTEGER PRIMARY KEY,
  reminder_id INTEGER REFERENCES reminders(id) ON DELETE SET NULL,
  event_id INTEGER,
  phone TEXT NOT NULL,
  recipient_name TEXT,
  message TEXT NOT NULL,
  provider TEXT NOT NULL,
  ok INTEGER NOT NULL,
  provider_ref TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS menu_items(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  category TEXT,
  unit TEXT NOT NULL DEFAULT 'plates',
  price REAL NOT NULL DEFAULT 0,
  diet TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ingredients(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  unit TEXT NOT NULL DEFAULT 'kg',
  reorder_level REAL,
  lead_time_days INTEGER NOT NULL DEFAULT 2,
  unit_cost REAL NOT NULL DEFAULT 0,
  shelf_life_days INTEGER,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS recipes(
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty_per_unit REAL NOT NULL,
  PRIMARY KEY(menu_item_id, ingredient_id)
);

CREATE TABLE IF NOT EXISTS stock_batches(
  id INTEGER PRIMARY KEY,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty_received REAL NOT NULL,
  qty_left REAL NOT NULL,
  expiry_date TEXT,
  unit_cost REAL,
  note TEXT,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_moves(
  id INTEGER PRIMARY KEY,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  batch_id INTEGER,
  qty REAL NOT NULL,
  reason TEXT NOT NULL,
  event_id INTEGER,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_moves_ing ON stock_moves(ingredient_id, created_at);

CREATE TABLE IF NOT EXISTS custom_fields(
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'text' CHECK(field_type IN ('text','number','date','yesno','choice')),
  options TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY,
  staff_name TEXT,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);
"""

DEFAULT_SETTINGS = {
    "business_name": "My Catering Services",
    "business_phone": "",
    "owner_phone": "",
    "country_code": "91",
    "currency": "₹",
    "reminder_offsets": "7d,2d,1d,4h",
    "quiet_start": "21:00",
    "quiet_end": "07:00",
    "ack_hours": "12",
    "send_booking_confirmation": "1",
    "notify_on_change": "1",
    "remind_customer": "1",
    "whatsapp_provider": "test",
    "max_events_per_day": "3",
    "wastage_pct": "5",
    "order_cost": "200",
    "holding_rate": "0.20",
    "service_level": "0.95",
    "default_lead_time": "2",
}


def connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=15, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=15000")
    return conn


def init_db(path: str, seed: bool = True) -> None:
    conn = connect(path)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        for k, v in DEFAULT_SETTINGS.items():
            conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES(?,?)", (k, v))
        if not conn.execute("SELECT 1 FROM staff LIMIT 1").fetchone():
            conn.execute(
                "INSERT INTO staff(name, pin_hash, role, created_at) VALUES(?,?,?,?)",
                ("Owner", generate_password_hash("1234"), "admin", iso(now())),
            )
            if seed:
                seed_sample_data(conn)
        conn.commit()
    finally:
        conn.close()


def get_settings(conn) -> dict:
    s = dict(DEFAULT_SETTINGS)
    s.update({r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings")})
    return s


def setting_float(s: dict, key: str) -> float:
    try:
        return float(s.get(key) or DEFAULT_SETTINGS[key])
    except ValueError:
        return float(DEFAULT_SETTINGS[key])


def audit(conn, staff_name, entity, entity_id, action, detail=None):
    if isinstance(detail, (dict, list)):
        detail = json.dumps(detail, ensure_ascii=False)
    conn.execute(
        "INSERT INTO audit_log(staff_name, entity, entity_id, action, detail, at) VALUES(?,?,?,?,?,?)",
        (staff_name, entity, entity_id, action, detail, iso(now())),
    )


# ---------------------------------------------------------------- sample data
SAMPLE_INGREDIENTS = [
    # name, unit, lead_time, cost, shelf_life
    ("Basmati Rice", "kg", 3, 110, 365),
    ("Chicken", "kg", 1, 240, 2),
    ("Paneer", "kg", 1, 380, 4),
    ("Cooking Oil", "litre", 2, 150, 180),
    ("Onion", "kg", 1, 35, 20),
    ("Tomato", "kg", 1, 30, 6),
    ("Milk", "litre", 1, 56, 2),
    ("Sugar", "kg", 2, 44, 365),
    ("Toor Dal", "kg", 3, 140, 270),
    ("Wheat Flour (Atta)", "kg", 2, 42, 120),
    ("Spice Mix", "kg", 3, 600, 180),
    ("Vegetables (mixed)", "kg", 1, 45, 4),
]

SAMPLE_MENU = [
    # name, category, price, diet, recipe {ingredient: qty per plate}
    ("Veg Biryani", "Main Course", 120, "veg",
     {"Basmati Rice": 0.12, "Vegetables (mixed)": 0.06, "Cooking Oil": 0.015, "Onion": 0.03, "Spice Mix": 0.004}),
    ("Chicken Biryani", "Main Course", 180, "non-veg",
     {"Basmati Rice": 0.12, "Chicken": 0.15, "Cooking Oil": 0.02, "Onion": 0.04, "Spice Mix": 0.005}),
    ("Paneer Butter Masala", "Curry", 90, "veg",
     {"Paneer": 0.06, "Tomato": 0.05, "Onion": 0.03, "Cooking Oil": 0.01, "Spice Mix": 0.003}),
    ("Dal Tadka", "Curry", 50, "veg",
     {"Toor Dal": 0.04, "Tomato": 0.02, "Onion": 0.015, "Cooking Oil": 0.008, "Spice Mix": 0.002}),
    ("Chapati (2 pcs)", "Bread", 20, "veg", {"Wheat Flour (Atta)": 0.06, "Cooking Oil": 0.004}),
    ("Payasam", "Dessert", 40, "veg", {"Milk": 0.12, "Sugar": 0.025, "Basmati Rice": 0.01}),
    ("Plain Rice", "Main Course", 30, "veg", {"Basmati Rice": 0.1}),
]


def seed_sample_data(conn):
    t = now()
    ing_ids = {}
    for name, unit, lead, cost, shelf in SAMPLE_INGREDIENTS:
        cur = conn.execute(
            "INSERT INTO ingredients(name, unit, lead_time_days, unit_cost, shelf_life_days) VALUES(?,?,?,?,?)",
            (name, unit, lead, cost, shelf),
        )
        ing_ids[name] = cur.lastrowid
    # opening stock + 30 days of fake consumption history for the forecasts
    import random
    rnd = random.Random(42)
    for name, iid in ing_ids.items():
        shelf = next(x[4] for x in SAMPLE_INGREDIENTS if x[0] == name)
        qty = rnd.choice([5, 10, 15, 20, 25, 40])
        exp = (t.date() + timedelta(days=shelf)).isoformat()
        cur = conn.execute(
            "INSERT INTO stock_batches(ingredient_id, qty_received, qty_left, expiry_date, note, received_at) "
            "VALUES(?,?,?,?,?,?)", (iid, qty, qty, exp, "Opening stock", iso(t)))
        conn.execute("INSERT INTO stock_moves(ingredient_id, batch_id, qty, reason, created_by, created_at) "
                     "VALUES(?,?,?,?,?,?)", (iid, cur.lastrowid, qty, "Opening stock", "system", iso(t)))
        for d in range(1, 31):
            if rnd.random() < 0.5:
                used = round(rnd.uniform(0.2, 2.0), 2)
                conn.execute("INSERT INTO stock_moves(ingredient_id, qty, reason, created_by, created_at) "
                             "VALUES(?,?,?,?,?)",
                             (iid, -used, "Daily use (history)", "system", iso(t - timedelta(days=d))))

    menu_ids = {}
    for name, cat, price, diet, recipe in SAMPLE_MENU:
        cur = conn.execute("INSERT INTO menu_items(name, category, price, diet) VALUES(?,?,?,?)",
                           (name, cat, price, diet))
        menu_ids[name] = cur.lastrowid
        for ing, q in recipe.items():
            conn.execute("INSERT INTO recipes(menu_item_id, ingredient_id, qty_per_unit) VALUES(?,?,?)",
                         (cur.lastrowid, ing_ids[ing], q))

    samples = [
        ("Sample - Ramesh Kumar", "9876500001", "Wedding Reception", "Wedding", 1, "19:30", 250, "Lakshmi Hall, MG Road",
         [("Chicken Biryani", 150), ("Veg Biryani", 100), ("Paneer Butter Masala", 250), ("Payasam", 250)], 95000, 30000,
         "10 plates Jain (no onion/garlic)"),
        ("Sample - Priya Nair", "9876500002", "Birthday Party", "Birthday", 2, None, 60, "Home - 12 Park Street",
         [("Veg Biryani", 60), ("Dal Tadka", 60), ("Payasam", 60)], 15000, 5000, ""),
        ("Sample - Joseph Mathew", "9876500003", "House Warming Lunch", "House Warming", 6, "12:30", 120, "New house, Kakkanad",
         [("Plain Rice", 120), ("Dal Tadka", 120), ("Chapati (2 pcs)", 120), ("Payasam", 120)], 24000, 10000, ""),
        ("Sample - Anitha S", "9876500004", "Office Annual Day", "Corporate", 15, "13:00", 300, "Infopark Hall 2",
         [("Veg Biryani", 300), ("Paneer Butter Masala", 300)], 70000, 20000, "Need serving staff in uniform"),
    ]
    for cname, phone, title, etype, days_ahead, etime, guests, venue, items, total, adv, special in samples:
        cur = conn.execute("INSERT INTO customers(name, phone, is_sample, created_at) VALUES(?,?,1,?)",
                           (cname, "+91" + phone, iso(t)))
        cid = cur.lastrowid
        cur = conn.execute(
            "INSERT INTO events(customer_id, title, event_type, event_date, event_time, venue, guest_count, status, "
            "total_amount, special_instructions, created_by, updated_by, created_at, updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (cid, title, etype, (t.date() + timedelta(days=days_ahead)).isoformat(), etime, venue, guests,
             "confirmed", total, special, "Owner", "Owner", iso(t), iso(t)))
        eid = cur.lastrowid
        for i, (iname, qty) in enumerate(items):
            conn.execute("INSERT INTO event_items(event_id, menu_item_id, item_name, quantity, unit, sort) "
                         "VALUES(?,?,?,?,?,?)", (eid, menu_ids[iname], iname, qty, "plates", i))
        conn.execute("INSERT INTO event_contacts(event_id, name, phone, role) VALUES(?,?,?,?)",
                     (eid, cname, "+91" + phone, "customer"))
        conn.execute("INSERT INTO payments(event_id, amount, paid_on, mode, note, created_by, created_at) "
                     "VALUES(?,?,?,?,?,?,?)", (eid, adv, t.date().isoformat(), "Cash", "Advance", "Owner", iso(t)))
    conn.execute("INSERT INTO custom_fields(key, label, field_type, options, sort) VALUES(?,?,?,?,?)",
                 ("serving_style", "Serving style", "choice", "Buffet,Banana leaf,Table service,Parcel", 1))

"""REST API (JSON). All write endpoints need a logged-in staff member; /api/board is public."""
import csv
import io
import json
import os
import re
import sqlite3
import tempfile
import time
import uuid
from datetime import datetime, timedelta
from functools import wraps

from flask import Blueprint, current_app, g, jsonify, request, session, send_file, Response
from werkzeug.security import check_password_hash, generate_password_hash

from . import inventory as inv
from . import reminders as rem
from .db import connect, get_settings, audit, DEFAULT_SETTINGS
from .util import (now as _now, iso, parse_date, valid_date, valid_hhmm, event_start, normalize_phone,
                   days_until)
from .whatsapp import wa_link

bp = Blueprint("api", __name__, url_prefix="/api")

STATUSES = ("enquiry", "confirmed", "completed", "cancelled")
UNITS = ("plates", "kg", "litres", "pieces", "boxes", "trays")
_failed_logins = {}


class ApiError(Exception):
    def __init__(self, message, status=400, **extra):
        super().__init__(message)
        self.message, self.status, self.extra = message, status, extra


@bp.errorhandler(ApiError)
def _api_error(e):
    return jsonify({"error": e.message, **e.extra}), e.status


@bp.errorhandler(sqlite3.IntegrityError)
def _integrity(e):
    msg = str(e)
    if "UNIQUE" in msg:
        return jsonify({"error": "This name / number already exists. Please use a different one."}), 409
    return jsonify({"error": "Could not save: " + msg}), 400


# ---------------------------------------------------------------- plumbing
def db():
    if "db" not in g:
        g.db = connect(current_app.config["DB_PATH"])
    return g.db


@bp.teardown_app_request
def _close(exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def body():
    return request.get_json(silent=True) or {}


def me():
    return session.get("staff_name")


def wake_scheduler():
    sch = current_app.config.get("SCHEDULER")
    if sch:
        sch.wake()


def login_required(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        if not session.get("staff_id"):
            raise ApiError("Please log in again", 401)
        row = db().execute("SELECT active FROM staff WHERE id=?", (session["staff_id"],)).fetchone()
        if not row or not row["active"]:
            session.clear()
            raise ApiError("Your login is no longer active", 401)
        return fn(*a, **kw)
    return wrapper


def admin_required(fn):
    @wraps(fn)
    @login_required
    def wrapper(*a, **kw):
        if session.get("role") != "admin":
            raise ApiError("Only the owner can change this", 403)
        return fn(*a, **kw)
    return wrapper


def rows(cur):
    return [dict(r) for r in cur]


def num(v, field, minimum=0.0, integer=False, default=None):
    if v in (None, ""):
        if default is not None:
            return default
        raise ApiError(f"{field} is required")
    try:
        x = int(v) if integer else float(v)
    except (TypeError, ValueError):
        raise ApiError(f"{field} must be a number")
    if x < minimum:
        raise ApiError(f"{field} cannot be less than {minimum:g}")
    return x


def phone_or_error(raw, what="Phone"):
    try:
        return normalize_phone(raw, get_settings(db()).get("country_code") or "91")
    except ValueError as e:
        raise ApiError(f"{what}: {e}")


# ---------------------------------------------------------------- auth
@bp.get("/staff/public")
def staff_public():
    s = get_settings(db())
    return jsonify({"business_name": s["business_name"],
                    "staff": rows(db().execute("SELECT id, name, role FROM staff WHERE active=1 ORDER BY role, name"))})


@bp.post("/login")
def login():
    d = body()
    sid = d.get("staff_id")
    lock = _failed_logins.get(sid, (0, 0))
    if lock[0] >= 5 and time.time() - lock[1] < 120:
        raise ApiError("Too many wrong PINs. Please wait 2 minutes and try again.", 429)
    st = db().execute("SELECT * FROM staff WHERE id=? AND active=1", (sid,)).fetchone()
    if not st or not check_password_hash(st["pin_hash"], str(d.get("pin", ""))):
        _failed_logins[sid] = (lock[0] + 1, time.time())
        raise ApiError("Wrong PIN. Please try again.", 401)
    _failed_logins.pop(sid, None)
    session.clear()
    session.permanent = True
    session.update(staff_id=st["id"], staff_name=st["name"], role=st["role"])
    audit(db(), st["name"], "staff", st["id"], "login")
    db().commit()
    return jsonify({"id": st["id"], "name": st["name"], "role": st["role"]})


@bp.post("/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@bp.get("/me")
@login_required
def whoami():
    sch = current_app.config.get("SCHEDULER")
    s = get_settings(db())
    return jsonify({"id": session["staff_id"], "name": session["staff_name"], "role": session["role"],
                    "business_name": s["business_name"], "currency": s["currency"],
                    "provider": s["whatsapp_provider"],
                    "scheduler": {"running": bool(sch and sch.is_alive()),
                                  "last_run": iso(sch.last_run) if sch and sch.last_run else None,
                                  "last_error": sch.last_error if sch else None}})


@bp.post("/me/pin")
@login_required
def change_my_pin():
    d = body()
    st = db().execute("SELECT * FROM staff WHERE id=?", (session["staff_id"],)).fetchone()
    if not check_password_hash(st["pin_hash"], str(d.get("old_pin", ""))):
        raise ApiError("Old PIN is wrong")
    new = str(d.get("new_pin", ""))
    if not re.fullmatch(r"\d{4,6}", new):
        raise ApiError("New PIN must be 4 to 6 digits")
    with db():
        db().execute("UPDATE staff SET pin_hash=? WHERE id=?", (generate_password_hash(new), st["id"]))
        audit(db(), me(), "staff", st["id"], "change PIN")
    return jsonify({"ok": True})


# ---------------------------------------------------------------- events: read helpers
EVENT_SELECT = """
SELECT e.*, c.name customer_name, c.phone customer_phone, c.alt_phone customer_alt_phone,
       c.address customer_address, st.name assigned_name,
       (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.event_id=e.id) paid,
       (SELECT COUNT(*) FROM event_items i WHERE i.event_id=e.id) item_count,
       (SELECT group_concat(printf('%s (%g %s)', item_name, quantity, unit), ', ')
          FROM (SELECT * FROM event_items i WHERE i.event_id=e.id ORDER BY sort, id)) items_text,
       (SELECT COUNT(*) FROM reminders r WHERE r.event_id=e.id AND r.status='failed') failed_reminders,
       (SELECT MIN(due_at) FROM reminders r WHERE r.event_id=e.id AND r.status IN ('pending','retry')) next_reminder
FROM events e JOIN customers c ON c.id=e.customer_id LEFT JOIN staff st ON st.id=e.assigned_staff_id
"""


def decorate(r, now=None):
    now = now or _now()
    d = dict(r)
    d["extra"] = json.loads(d.get("extra") or "{}")
    d["balance"] = round((d.get("total_amount") or 0) - (d.get("paid") or 0), 2)
    start = event_start(r)
    d["start"] = iso(start)
    d["days_left"] = days_until(start, now)
    flags = []
    st = d["status"]
    if d.get("deleted_at"):
        urgency = "deleted"
    elif st == "cancelled":
        urgency = "cancelled"
    elif st == "completed":
        urgency = "done"
    else:
        end = parse_date(d["end_date"]) if d.get("end_date") else start.date()
        over = end < now.date() or (end == now.date() and start + timedelta(hours=8) < now and not d.get("end_date"))
        if over:
            urgency = "needs_close"
            flags.append({"code": "close", "level": "amber", "text": "Event is over - mark as completed"})
        else:
            dl = d["days_left"]
            urgency = "red" if dl <= 2 else ("amber" if dl <= 7 else "green")
            if st == "enquiry":
                flags.append({"code": "enquiry", "level": "red" if dl <= 7 else "amber",
                              "text": "Enquiry only - not confirmed yet"})
            if not d.get("event_time"):
                flags.append({"code": "time", "level": "red" if dl <= 2 else "amber", "text": "Time not fixed"})
            if not d.get("item_count"):
                flags.append({"code": "items", "level": "red" if dl <= 7 else "amber", "text": "No food items added"})
            if dl <= 2 and d["balance"] > 0:
                flags.append({"code": "balance", "level": "red", "text": "Balance payment due"})
            if dl <= 2 and st == "confirmed" and not d.get("final_confirmed_at"):
                flags.append({"code": "reconfirm", "level": "red", "text": "Not re-confirmed with customer"})
    if d.get("failed_reminders"):
        flags.append({"code": "failed", "level": "red", "text": "WhatsApp reminder FAILED - call the person"})
    d["urgency"] = urgency
    d["flags"] = flags
    return d


def get_event_full(conn, eid, include_deleted=True):
    r = conn.execute(EVENT_SELECT + " WHERE e.id=?", (eid,)).fetchone()
    if not r or (r["deleted_at"] and not include_deleted):
        raise ApiError("Booking not found", 404)
    d = decorate(r)
    d["items"] = rows(conn.execute("SELECT * FROM event_items WHERE event_id=? ORDER BY sort, id", (eid,)))
    d["contacts"] = rows(conn.execute("SELECT * FROM event_contacts WHERE event_id=? ORDER BY role='customer' DESC, id",
                                      (eid,)))
    d["payments"] = rows(conn.execute("SELECT * FROM payments WHERE event_id=? ORDER BY paid_on, id", (eid,)))
    rs = rows(conn.execute("SELECT * FROM reminders WHERE event_id=? ORDER BY due_at, id", (eid,)))
    for x in rs:
        x["label"] = rem.kind_label(x["kind"])
        x["wa_link"] = wa_link(x["phone"], x["message"]) if x["message"] else None
    d["reminders"] = rs
    reqs, unplanned = inv.event_requirements(conn, eid)
    d["requirements"], d["unplanned_items"] = reqs, unplanned
    d["history"] = rows(conn.execute(
        "SELECT staff_name, action, detail, at FROM audit_log WHERE entity='event' AND entity_id=? ORDER BY id DESC "
        "LIMIT 30", (eid,)))
    return d


# ---------------------------------------------------------------- events: list / read
@bp.get("/events")
@login_required
def list_events():
    q = request.args
    where, args = ["1=1"], []
    if q.get("deleted") == "1":
        where.append("e.deleted_at IS NOT NULL")
    else:
        where.append("e.deleted_at IS NULL")
    if q.get("from"):
        where.append("COALESCE(e.end_date, e.event_date)>=?")
        args.append(q["from"])
    if q.get("to"):
        where.append("e.event_date<=?")
        args.append(q["to"])
    if q.get("status"):
        sts = [x for x in q["status"].split(",") if x in STATUSES]
        if sts:
            where.append(f"e.status IN ({','.join('?' * len(sts))})")
            args += sts
    if q.get("q"):
        like = f"%{q['q'].strip()}%"
        where.append("(e.title LIKE ? OR c.name LIKE ? OR c.phone LIKE ? OR e.venue LIKE ? OR e.event_type LIKE ? "
                     "OR CAST(e.id AS TEXT)=?)")
        args += [like, like, like, like, like, q["q"].strip().lstrip("#")]
    if q.get("customer_id"):
        where.append("e.customer_id=?")
        args.append(q["customer_id"])
    order = "e.event_date DESC, e.event_time DESC" if q.get("order") == "desc" else \
        "e.event_date, COALESCE(e.event_time,'12:00')"
    now = _now()
    out = [decorate(r, now) for r in db().execute(
        EVENT_SELECT + " WHERE " + " AND ".join(where) + " ORDER BY " + order + " LIMIT 2000", args)]
    return jsonify(out)


@bp.get("/events/<int:eid>")
@login_required
def get_event(eid):
    return jsonify(get_event_full(db(), eid))


@bp.get("/events/check-date")
@login_required
def check_date():
    d = request.args.get("date", "")
    if not valid_date(d):
        raise ApiError("Invalid date")
    exclude = request.args.get("exclude", type=int) or 0
    same = rows(db().execute(
        "SELECT e.id, e.title, e.event_time, e.guest_count, e.status, c.name customer_name FROM events e "
        "JOIN customers c ON c.id=e.customer_id WHERE e.deleted_at IS NULL AND e.status IN ('confirmed','enquiry') "
        "AND e.id!=? AND e.event_date<=? AND COALESCE(e.end_date, e.event_date)>=? ORDER BY e.event_time",
        (exclude, d, d)))
    s = get_settings(db())
    cap = int(float(s.get("max_events_per_day") or 3))
    return jsonify({"date": d, "events": same, "capacity": cap, "full": len(same) >= cap,
                    "past": d < _now().date().isoformat()})


# ---------------------------------------------------------------- events: write
def upsert_customer(conn, c):
    if c.get("id") and not c.get("phone"):
        row = conn.execute("SELECT id FROM customers WHERE id=?", (c["id"],)).fetchone()
        if not row:
            raise ApiError("Customer not found")
        return row["id"]
    name = (c.get("name") or "").strip()
    if not name:
        raise ApiError("Customer name is required")
    phone = phone_or_error(c.get("phone"), "Customer phone")
    alt = phone_or_error(c["alt_phone"], "Alternate phone") if c.get("alt_phone") else None
    row = conn.execute("SELECT * FROM customers WHERE phone=?", (phone,)).fetchone()
    if row:
        conn.execute("UPDATE customers SET name=?, alt_phone=COALESCE(?, alt_phone), address=COALESCE(?, address), "
                     "notes=COALESCE(?, notes) WHERE id=?",
                     (name, alt, c.get("address") or None, c.get("notes") or None, row["id"]))
        return row["id"]
    return conn.execute("INSERT INTO customers(name, phone, alt_phone, address, notes, created_at) VALUES(?,?,?,?,?,?)",
                        (name, phone, alt, c.get("address") or None, c.get("notes") or None, iso(_now()))).lastrowid


def clean_event(conn, d, creating):
    e = {}
    e["event_date"] = d.get("event_date")
    if not valid_date(e["event_date"]):
        raise ApiError("Please choose the event date")
    if creating and e["event_date"] < _now().date().isoformat() and not d.get("allow_past"):
        raise ApiError("This date is in the past. Tick 'Record an old event' if this is intended.",
                       code="past_date")
    e["end_date"] = d.get("end_date") or None
    if e["end_date"]:
        if not valid_date(e["end_date"]):
            raise ApiError("End date is not valid")
        if e["end_date"] < e["event_date"]:
            raise ApiError("End date cannot be before the start date")
        if e["end_date"] == e["event_date"]:
            e["end_date"] = None
    e["event_time"] = d.get("event_time") or None
    if e["event_time"] and not valid_hhmm(e["event_time"]):
        raise ApiError("Event time is not valid")
    e["event_type"] = (d.get("event_type") or "").strip() or None
    e["title"] = (d.get("title") or "").strip()
    e["venue"] = (d.get("venue") or "").strip() or None
    e["venue_map"] = (d.get("venue_map") or "").strip() or None
    e["guest_count"] = num(d.get("guest_count"), "Number of guests", 0, True, default=0)
    e["status"] = d.get("status") or "confirmed"
    if e["status"] not in STATUSES:
        raise ApiError("Unknown status")
    e["total_amount"] = num(d.get("total_amount"), "Total amount", 0, default=0.0)
    e["notes"] = (d.get("notes") or "").strip() or None
    e["special_instructions"] = (d.get("special_instructions") or "").strip() or None
    e["assigned_staff_id"] = d.get("assigned_staff_id") or None
    extra = d.get("extra") or {}
    if not isinstance(extra, dict):
        raise ApiError("Extra fields are not valid")
    keys = {r["key"] for r in conn.execute("SELECT key FROM custom_fields")}
    e["extra"] = json.dumps({k: v for k, v in extra.items() if k in keys}, ensure_ascii=False)

    items = []
    menu = {r["name"].lower(): r for r in conn.execute("SELECT * FROM menu_items")}
    for i, it in enumerate(d.get("items") or []):
        name = (it.get("item_name") or "").strip()
        if not name and not it.get("quantity"):
            continue                                   # blank row left in the form
        if not name:
            raise ApiError(f"Food item row {i + 1}: please type the item name")
        qty = num(it.get("quantity"), f"Quantity of '{name}'", 0)
        if qty <= 0:
            raise ApiError(f"Quantity of '{name}' must be more than zero")
        unit = it.get("unit") or "plates"
        mid = it.get("menu_item_id")
        m = menu.get(name.lower())
        if m:
            mid = m["id"]
        elif mid and not conn.execute("SELECT 1 FROM menu_items WHERE id=?", (mid,)).fetchone():
            mid = None
        items.append({"menu_item_id": mid if m or mid else None, "item_name": name, "quantity": qty, "unit": unit,
                      "diet": it.get("diet") or None, "notes": (it.get("notes") or "").strip() or None, "sort": i})
    contacts, seen = [], set()
    for c in d.get("contacts") or []:
        if not (c.get("name") or c.get("phone")):
            continue
        cname = (c.get("name") or "").strip()
        if not cname:
            raise ApiError("Every reminder person needs a name")
        ph = phone_or_error(c.get("phone"), f"Phone of {cname}")
        if ph in seen:
            continue
        seen.add(ph)
        contacts.append({"name": cname, "phone": ph, "role": c.get("role") or "other"})
    return e, items, contacts


def _write_children(conn, eid, items, contacts):
    conn.execute("DELETE FROM event_items WHERE event_id=?", (eid,))
    for it in items:
        conn.execute("INSERT INTO event_items(event_id, menu_item_id, item_name, quantity, unit, diet, notes, sort) "
                     "VALUES(?,?,?,?,?,?,?,?)", (eid, it["menu_item_id"], it["item_name"], it["quantity"],
                                                 it["unit"], it["diet"], it["notes"], it["sort"]))
    conn.execute("DELETE FROM event_contacts WHERE event_id=?", (eid,))
    for c in contacts:
        conn.execute("INSERT INTO event_contacts(event_id, name, phone, role) VALUES(?,?,?,?)",
                     (eid, c["name"], c["phone"], c["role"]))


@bp.post("/events")
@login_required
def create_event():
    d = body()
    conn = db()
    s = get_settings(conn)
    with conn:
        cust_id = upsert_customer(conn, d.get("customer") or {})
        e, items, contacts = clean_event(conn, d, creating=True)
        cust = conn.execute("SELECT * FROM customers WHERE id=?", (cust_id,)).fetchone()
        if "contacts" not in d and s["remind_customer"] == "1":
            contacts = [{"name": cust["name"], "phone": cust["phone"], "role": "customer"}]
        if not e["title"]:
            e["title"] = f"{e['event_type'] or 'Event'} - {cust['name']}"
        t = iso(_now())
        cols = list(e.keys())
        eid = conn.execute(
            f"INSERT INTO events(customer_id, {', '.join(cols)}, created_by, updated_by, created_at, updated_at) "
            f"VALUES(?, {', '.join('?' * len(cols))}, ?, ?, ?, ?)",
            [cust_id] + [e[k] for k in cols] + [me(), me(), t, t]).lastrowid
        _write_children(conn, eid, items, contacts)
        adv = num(d.get("advance_amount"), "Advance", 0, default=0.0)
        if adv > 0:
            conn.execute("INSERT INTO payments(event_id, amount, paid_on, mode, note, created_by, created_at) "
                         "VALUES(?,?,?,?,?,?,?)", (eid, adv, _now().date().isoformat(), d.get("advance_mode") or "Cash",
                                                   "Advance", me(), t))
        if e["status"] == "confirmed":
            rem.queue_booking_confirmation(conn, eid)
        rem.sync_event_reminders(conn, eid)
        audit(conn, me(), "event", eid, "created", {"title": e["title"], "date": e["event_date"]})
    wake_scheduler()
    return jsonify(get_event_full(conn, eid)), 201


TRACKED = ("title", "event_type", "event_date", "end_date", "event_time", "venue", "guest_count", "status",
           "total_amount", "special_instructions", "notes", "assigned_staff_id")


@bp.put("/events/<int:eid>")
@login_required
def update_event(eid):
    d = body()
    conn = db()
    with conn:
        old = conn.execute("SELECT * FROM events WHERE id=?", (eid,)).fetchone()
        if not old or old["deleted_at"]:
            raise ApiError("Booking not found (it may have been deleted)", 404)
        if str(d.get("version")) != str(old["version"]):
            raise ApiError(f"{old['updated_by'] or 'Someone'} changed this booking at {old['updated_at'][11:16]} "
                           f"while you were editing. Please reload to see their changes, then edit again.", 409,
                           code="conflict")
        cust_id = upsert_customer(conn, d.get("customer") or {"id": old["customer_id"]})
        e, items, contacts = clean_event(conn, d, creating=False)
        if not e["title"]:
            e["title"] = old["title"]
        if "contacts" not in d:
            contacts = rows(conn.execute("SELECT name, phone, role FROM event_contacts WHERE event_id=?", (eid,)))
        changes = {k: [old[k], e[k]] for k in TRACKED if str(old[k] or "") != str(e[k] or "")}
        sets = ", ".join(f"{k}=?" for k in e)
        conn.execute(f"UPDATE events SET customer_id=?, {sets}, version=version+1, updated_by=?, updated_at=? "
                     f"WHERE id=?", [cust_id] + list(e.values()) + [me(), iso(_now()), eid])
        _write_children(conn, eid, items, contacts)
        new = conn.execute("SELECT * FROM events WHERE id=?", (eid,)).fetchone()
        moved = event_start(old) != event_start(new)
        if moved:
            conn.execute("UPDATE events SET final_confirmed_at=NULL, final_confirmed_by=NULL, escalated_at=NULL "
                         "WHERE id=?", (eid,))
        if new["status"] == "confirmed":
            if old["status"] != "confirmed":
                rem.queue_booking_confirmation(conn, eid)
            elif moved:
                rem.queue_change_notice(conn, eid, new["version"])
        rem.sync_event_reminders(conn, eid)
        audit(conn, me(), "event", eid, "edited", changes or {"items/contacts": "updated"})
    wake_scheduler()
    return jsonify(get_event_full(conn, eid))


@bp.post("/events/<int:eid>/status")
@login_required
def set_status(eid):
    st = body().get("status")
    if st not in STATUSES:
        raise ApiError("Unknown status")
    conn = db()
    with conn:
        old = conn.execute("SELECT * FROM events WHERE id=? AND deleted_at IS NULL", (eid,)).fetchone()
        if not old:
            raise ApiError("Booking not found", 404)
        conn.execute("UPDATE events SET status=?, version=version+1, updated_by=?, updated_at=? WHERE id=?",
                     (st, me(), iso(_now()), eid))
        if st == "confirmed" and old["status"] != "confirmed":
            rem.queue_booking_confirmation(conn, eid)
        rem.sync_event_reminders(conn, eid)
        audit(conn, me(), "event", eid, f"status -> {st}", {"from": old["status"]})
    wake_scheduler()
    return jsonify(get_event_full(conn, eid))


@bp.post("/events/<int:eid>/reconfirm")
@login_required
def reconfirm(eid):
    undo = bool(body().get("undo"))
    conn = db()
    with conn:
        conn.execute("UPDATE events SET final_confirmed_at=?, final_confirmed_by=? WHERE id=?",
                     (None if undo else iso(_now()), None if undo else me(), eid))
        audit(conn, me(), "event", eid, "re-confirmation undone" if undo else "customer re-confirmed")
    return jsonify(get_event_full(conn, eid))


@bp.delete("/events/<int:eid>")
@login_required
def delete_event(eid):
    conn = db()
    with conn:
        conn.execute("UPDATE events SET deleted_at=?, updated_by=?, version=version+1 WHERE id=?",
                     (iso(_now()), me(), eid))
        rem.sync_event_reminders(conn, eid)
        audit(conn, me(), "event", eid, "deleted")
    return jsonify({"ok": True})


@bp.post("/events/<int:eid>/restore")
@login_required
def restore_event(eid):
    conn = db()
    with conn:
        conn.execute("UPDATE events SET deleted_at=NULL, updated_by=?, version=version+1 WHERE id=?", (me(), eid))
        rem.sync_event_reminders(conn, eid)
        audit(conn, me(), "event", eid, "restored")
    wake_scheduler()
    return jsonify(get_event_full(conn, eid))


@bp.post("/events/<int:eid>/duplicate")
@login_required
def duplicate_event(eid):
    """Returns a pre-filled draft (not saved) for 'Book again'."""
    src = get_event_full(db(), eid)
    draft = {k: src[k] for k in ("title", "event_type", "event_time", "venue", "venue_map", "guest_count",
                                 "total_amount", "special_instructions", "notes", "extra")}
    draft["customer"] = {"id": src["customer_id"], "name": src["customer_name"], "phone": src["customer_phone"],
                         "alt_phone": src["customer_alt_phone"], "address": src["customer_address"]}
    draft["items"] = [{k: it[k] for k in ("menu_item_id", "item_name", "quantity", "unit", "diet", "notes")}
                      for it in src["items"]]
    draft["contacts"] = [{k: c[k] for k in ("name", "phone", "role")} for c in src["contacts"]]
    return jsonify(draft)


@bp.post("/events/<int:eid>/issue-stock")
@login_required
def issue_stock(eid):
    conn = db()
    with conn:
        try:
            res = inv.issue_event_stock(conn, eid, me())
        except ValueError as e:
            raise ApiError(str(e))
        audit(conn, me(), "event", eid, "stock issued", res)
    return jsonify(res)


@bp.post("/events/<int:eid>/payments")
@login_required
def add_payment(eid):
    d = body()
    amt = num(d.get("amount"), "Amount", 0.01)
    paid_on = d.get("paid_on") or _now().date().isoformat()
    if not valid_date(paid_on):
        raise ApiError("Payment date is not valid")
    conn = db()
    with conn:
        conn.execute("INSERT INTO payments(event_id, amount, paid_on, mode, note, created_by, created_at) "
                     "VALUES(?,?,?,?,?,?,?)", (eid, amt, paid_on, d.get("mode") or "Cash", d.get("note"), me(),
                                               iso(_now())))
        audit(conn, me(), "event", eid, "payment added", {"amount": amt, "mode": d.get("mode")})
    return jsonify(get_event_full(conn, eid))


@bp.delete("/payments/<int:pid>")
@login_required
def delete_payment(pid):
    conn = db()
    p = conn.execute("SELECT * FROM payments WHERE id=?", (pid,)).fetchone()
    if not p:
        raise ApiError("Payment not found", 404)
    with conn:
        conn.execute("DELETE FROM payments WHERE id=?", (pid,))
        audit(conn, me(), "event", p["event_id"], "payment removed", {"amount": p["amount"]})
    return jsonify(get_event_full(conn, p["event_id"]))


# ---------------------------------------------------------------- reminders
@bp.post("/events/<int:eid>/reminders")
@login_required
def add_custom_reminder(eid):
    d = body()
    name = (d.get("name") or "").strip()
    if not name:
        raise ApiError("Whom should we remind? Please type a name")
    phone = phone_or_error(d.get("phone"))
    try:
        due = datetime.strptime((d.get("due_at") or "").replace("T", " ")[:16], "%Y-%m-%d %H:%M")
    except ValueError:
        raise ApiError("Please choose the reminder date and time")
    if due < _now() - timedelta(minutes=5):
        raise ApiError("Reminder time is in the past")
    conn = db()
    with conn:
        rem.queue_one_off(conn, eid, f"custom_{uuid.uuid4().hex[:8]}", name, phone, d.get("role") or "other", due,
                          note=(d.get("note") or "").strip() or None)
        audit(conn, me(), "event", eid, "custom reminder added", {"to": name, "at": iso(due)})
    wake_scheduler()
    return jsonify(get_event_full(conn, eid))


@bp.get("/reminders")
@login_required
def list_reminders():
    st = request.args.get("status", "upcoming")
    conn = db()
    base = ("SELECT r.*, e.title event_title, e.event_date, e.event_time FROM reminders r "
            "JOIN events e ON e.id=r.event_id WHERE e.deleted_at IS NULL AND ")
    if st == "upcoming":
        q = base + "r.status IN ('pending','retry','sending') ORDER BY r.due_at LIMIT 500"
    elif st == "failed":
        q = base + "r.status='failed' ORDER BY r.due_at DESC LIMIT 500"
    elif st == "sent":
        q = base + "r.status='sent' ORDER BY r.sent_at DESC LIMIT 300"
    else:
        q = base + "r.status IN ('skipped','cancelled','expired') ORDER BY r.due_at DESC LIMIT 300"
    out = rows(conn.execute(q))
    for x in out:
        x["label"] = rem.kind_label(x["kind"])
        x["wa_link"] = wa_link(x["phone"], x["message"]) if x["message"] else None
    return jsonify(out)


@bp.post("/reminders/<int:rid>/send-now")
@login_required
def send_now(rid):
    conn = db()
    ok, msg = rem.send_reminder(conn, rid, force=True)
    audit(conn, me(), "reminder", rid, "send now", {"ok": ok, "result": msg})
    conn.commit()
    r = conn.execute("SELECT * FROM reminders WHERE id=?", (rid,)).fetchone()
    return jsonify({"ok": ok, "message": msg,
                    "wa_link": wa_link(r["phone"], r["message"]) if r and r["message"] else None})


@bp.post("/reminders/<int:rid>/cancel")
@login_required
def cancel_reminder(rid):
    conn = db()
    with conn:
        conn.execute("UPDATE reminders SET status='cancelled', last_error=? WHERE id=? AND status IN "
                     "('pending','retry','failed')", (f"Cancelled by {me()}", rid))
        audit(conn, me(), "reminder", rid, "cancelled")
    return jsonify({"ok": True})


@bp.get("/outbox")
@login_required
def outbox():
    out = rows(db().execute("SELECT o.*, e.title event_title FROM outbox o LEFT JOIN events e ON e.id=o.event_id "
                            "ORDER BY o.id DESC LIMIT 200"))
    for x in out:
        x["wa_link"] = wa_link(x["phone"], x["message"])
    return jsonify(out)


# ---------------------------------------------------------------- dashboard & board
@bp.get("/dashboard")
@login_required
def dashboard():
    conn = db()
    now = _now()
    today = now.date().isoformat()
    events = [decorate(r, now) for r in conn.execute(
        EVENT_SELECT + " WHERE e.deleted_at IS NULL AND e.status IN ('confirmed','enquiry') "
        "AND COALESCE(e.end_date, e.event_date)>=? AND e.event_date<=? "
        "ORDER BY e.event_date, COALESCE(e.event_time,'12:00')",
        ((now.date() - timedelta(days=14)).isoformat(), (now.date() + timedelta(days=30)).isoformat()))]
    upcoming = [e for e in events if e["urgency"] in ("red", "amber", "green")]
    plan = inv.mrp_plan(conn, now.date(), 14)
    stock = inv.stock_overview(conn, now.date())
    s = get_settings(conn)
    return jsonify({
        "now": iso(now),
        "today": [e for e in upcoming if e["event_date"] <= today],
        "urgent": [e for e in upcoming if e["urgency"] == "red" or any(f["level"] == "red" for f in e["flags"])],
        "week": [e for e in upcoming if e["days_left"] <= 7],
        "later": [e for e in upcoming if e["days_left"] > 7],
        "needs_close": [e for e in events if e["urgency"] == "needs_close"],
        "counts": {
            "today": sum(1 for e in upcoming if e["event_date"] <= today),
            "week": sum(1 for e in upcoming if e["days_left"] <= 7),
            "enquiries": sum(1 for e in upcoming if e["status"] == "enquiry"),
            "failed_reminders": conn.execute("SELECT COUNT(*) c FROM reminders r JOIN events e ON e.id=r.event_id "
                                             "WHERE r.status='failed' AND e.deleted_at IS NULL").fetchone()["c"],
            "reminders_24h": conn.execute("SELECT COUNT(*) c FROM reminders WHERE status IN ('pending','retry') "
                                          "AND due_at<=?", (iso(now + timedelta(hours=24)),)).fetchone()["c"],
            "stock_low": sum(1 for x in stock if x["status"] != "ok"),
            "to_buy": len(plan["shopping"]),
            "to_buy_overdue": sum(1 for x in plan["shopping"] if x["overdue"]),
            "balance_due": round(sum(max(e["balance"], 0) for e in upcoming), 2),
        },
        "shopping": plan["shopping"][:8],
        "owner_phone_set": bool(s.get("owner_phone")),
    })


@bp.get("/board")
def board():
    """Public read-only 'common view'. No phone numbers, no money."""
    conn = db()
    now = _now()
    s = get_settings(conn)
    out = []
    for r in conn.execute(
            EVENT_SELECT + " WHERE e.deleted_at IS NULL AND e.status IN ('confirmed','enquiry') "
            "AND COALESCE(e.end_date, e.event_date)>=? AND e.event_date<=? "
            "ORDER BY e.event_date, COALESCE(e.event_time,'12:00')",
            (now.date().isoformat(), (now.date() + timedelta(days=7)).isoformat())):
        d = decorate(r, now)
        items = rows(conn.execute("SELECT item_name, quantity, unit, diet, notes FROM event_items WHERE event_id=? "
                                  "ORDER BY sort, id", (r["id"],)))
        out.append({k: d[k] for k in ("id", "title", "event_type", "event_date", "end_date", "event_time", "venue",
                                      "guest_count", "status", "special_instructions", "days_left", "urgency",
                                      "assigned_name", "final_confirmed_at")}
                   | {"customer_name": d["customer_name"], "items": items,
                      "flags": [f for f in d["flags"] if f["code"] not in ("balance",)]})
    return jsonify({"business_name": s["business_name"], "now": iso(now), "events": out})


# ---------------------------------------------------------------- customers
@bp.get("/customers")
@login_required
def list_customers():
    q = request.args.get("q", "").strip()
    sql = ("SELECT c.*, (SELECT COUNT(*) FROM events e WHERE e.customer_id=c.id AND e.deleted_at IS NULL) bookings, "
           "(SELECT MAX(event_date) FROM events e WHERE e.customer_id=c.id AND e.deleted_at IS NULL) last_event "
           "FROM customers c")
    args = []
    if q:
        sql += " WHERE c.name LIKE ? OR c.phone LIKE ? OR c.address LIKE ?"
        args = [f"%{q}%"] * 3
    return jsonify(rows(db().execute(sql + " ORDER BY c.name LIMIT 1000", args)))


@bp.get("/customers/lookup")
@login_required
def lookup_customer():
    raw = request.args.get("phone", "")
    try:
        phone = normalize_phone(raw, get_settings(db()).get("country_code") or "91")
    except ValueError:
        return jsonify(None)
    r = db().execute("SELECT * FROM customers WHERE phone=?", (phone,)).fetchone()
    if not r:
        return jsonify(None)
    d = dict(r)
    d["bookings"] = db().execute("SELECT COUNT(*) c FROM events WHERE customer_id=? AND deleted_at IS NULL",
                                 (r["id"],)).fetchone()["c"]
    return jsonify(d)


@bp.put("/customers/<int:cid>")
@login_required
def update_customer(cid):
    d = body()
    name = (d.get("name") or "").strip()
    if not name:
        raise ApiError("Name is required")
    phone = phone_or_error(d.get("phone"))
    alt = phone_or_error(d["alt_phone"], "Alternate phone") if d.get("alt_phone") else None
    conn = db()
    with conn:
        old = conn.execute("SELECT * FROM customers WHERE id=?", (cid,)).fetchone()
        conn.execute("UPDATE customers SET name=?, phone=?, alt_phone=?, address=?, notes=? WHERE id=?",
                     (name, phone, alt, d.get("address"), d.get("notes"), cid))
        if old and old["phone"] != phone:   # keep the customer's reminder contacts in step
            conn.execute("UPDATE event_contacts SET phone=?, name=? WHERE phone=? AND role='customer'",
                         (phone, name, old["phone"]))
            for r in conn.execute("SELECT id FROM events WHERE customer_id=?", (cid,)).fetchall():
                rem.sync_event_reminders(conn, r["id"])
        audit(conn, me(), "customer", cid, "edited")
    return jsonify({"ok": True})


# ---------------------------------------------------------------- menu & recipes
@bp.get("/menu")
@login_required
def list_menu():
    out = rows(db().execute("SELECT m.*, (SELECT COUNT(*) FROM recipes r WHERE r.menu_item_id=m.id) recipe_lines "
                            "FROM menu_items m ORDER BY m.active DESC, m.category, m.name"))
    return jsonify(out)


def _save_menu(mid=None):
    d = body()
    name = (d.get("name") or "").strip()
    if not name:
        raise ApiError("Item name is required")
    vals = (name, (d.get("category") or "").strip() or None, d.get("unit") or "plates",
            num(d.get("price"), "Price", 0, default=0.0), d.get("diet") or None, 1 if d.get("active", True) else 0)
    conn = db()
    with conn:
        if mid:
            conn.execute("UPDATE menu_items SET name=?, category=?, unit=?, price=?, diet=?, active=? WHERE id=?",
                         vals + (mid,))
        else:
            mid = conn.execute("INSERT INTO menu_items(name, category, unit, price, diet, active) VALUES(?,?,?,?,?,?)",
                               vals).lastrowid
        if "recipe" in d:
            conn.execute("DELETE FROM recipes WHERE menu_item_id=?", (mid,))
            for line in d["recipe"] or []:
                if not line.get("ingredient_id"):
                    continue
                q = num(line.get("qty_per_unit"), "Quantity per plate", 0)
                if q > 0:
                    conn.execute("INSERT OR REPLACE INTO recipes(menu_item_id, ingredient_id, qty_per_unit) "
                                 "VALUES(?,?,?)", (mid, line["ingredient_id"], q))
        audit(conn, me(), "menu", mid, "saved", {"name": name})
    return jsonify({"id": mid})


@bp.post("/menu")
@login_required
def create_menu():
    return _save_menu()


@bp.put("/menu/<int:mid>")
@login_required
def update_menu(mid):
    return _save_menu(mid)


@bp.get("/menu/<int:mid>/recipe")
@login_required
def get_recipe(mid):
    return jsonify(rows(db().execute(
        "SELECT r.*, i.name, i.unit FROM recipes r JOIN ingredients i ON i.id=r.ingredient_id WHERE r.menu_item_id=? "
        "ORDER BY i.name", (mid,))))


# ---------------------------------------------------------------- stock
@bp.get("/stock")
@login_required
def stock():
    conn = db()
    return jsonify({"items": inv.stock_overview(conn), "expiring": inv.expiring(conn, 3)})


@bp.get("/stock/plan")
@login_required
def stock_plan():
    days = request.args.get("days", default=30, type=int)
    return jsonify(inv.mrp_plan(db(), horizon_days=max(1, min(days, 180))))


@bp.get("/stock/<int:iid>/history")
@login_required
def stock_history(iid):
    conn = db()
    return jsonify({"moves": rows(conn.execute("SELECT * FROM stock_moves WHERE ingredient_id=? ORDER BY id DESC "
                                               "LIMIT 100", (iid,))),
                    "batches": rows(conn.execute("SELECT * FROM stock_batches WHERE ingredient_id=? AND qty_left>0 "
                                                 "ORDER BY COALESCE(expiry_date,'9999')", (iid,)))})


def _save_ingredient(iid=None):
    d = body()
    name = (d.get("name") or "").strip()
    if not name:
        raise ApiError("Ingredient name is required")
    rl = d.get("reorder_level")
    vals = (name, d.get("unit") or "kg", None if rl in (None, "") else num(rl, "Reorder level", 0),
            num(d.get("lead_time_days"), "Lead time", 0, True, default=2), num(d.get("unit_cost"), "Cost", 0, default=0.0),
            None if d.get("shelf_life_days") in (None, "") else num(d.get("shelf_life_days"), "Shelf life", 0, True),
            1 if d.get("active", True) else 0)
    conn = db()
    with conn:
        if iid:
            conn.execute("UPDATE ingredients SET name=?, unit=?, reorder_level=?, lead_time_days=?, unit_cost=?, "
                         "shelf_life_days=?, active=? WHERE id=?", vals + (iid,))
        else:
            iid = conn.execute("INSERT INTO ingredients(name, unit, reorder_level, lead_time_days, unit_cost, "
                               "shelf_life_days, active) VALUES(?,?,?,?,?,?,?)", vals).lastrowid
        audit(conn, me(), "ingredient", iid, "saved", {"name": name})
    return jsonify({"id": iid})


@bp.post("/ingredients")
@login_required
def create_ingredient():
    return _save_ingredient()


@bp.put("/ingredients/<int:iid>")
@login_required
def update_ingredient(iid):
    return _save_ingredient(iid)


@bp.post("/ingredients/<int:iid>/receive")
@login_required
def receive_stock(iid):
    d = body()
    qty = num(d.get("qty"), "Quantity", 0)
    exp = d.get("expiry_date") or None
    if exp and not valid_date(exp):
        raise ApiError("Expiry date is not valid")
    conn = db()
    with conn:
        try:
            inv.receive(conn, iid, qty, exp, d.get("unit_cost") or None, d.get("note") or "Stock received", me())
        except ValueError as e:
            raise ApiError(str(e))
        audit(conn, me(), "ingredient", iid, "stock received", {"qty": qty, "expiry": exp})
    return jsonify({"ok": True})


@bp.post("/ingredients/<int:iid>/adjust")
@login_required
def adjust_stock(iid):
    d = body()
    action = d.get("action")
    conn = db()
    with conn:
        if action == "write_off_expired":
            n = inv.write_off_expired(conn, iid, me())
            audit(conn, me(), "ingredient", iid, "expired written off", {"qty": n})
            return jsonify({"ok": True, "qty": n})
        qty = num(d.get("qty"), "Quantity", 0)
        reason = (d.get("reason") or "").strip() or "Used / wasted"
        if action == "add":
            inv.receive(conn, iid, qty, d.get("expiry_date") or None, None, reason, me())
            res = {"issued": qty, "shortfall": 0}
        else:
            issued, short = inv.fefo_issue(conn, iid, qty, reason, None, me(), include_expired=True)
            res = {"issued": issued, "shortfall": short}
        audit(conn, me(), "ingredient", iid, f"adjust {action or 'remove'}", {"qty": qty, "reason": reason})
    return jsonify({"ok": True, **res})


# ---------------------------------------------------------------- settings / staff / fields
SETTINGS_PUBLIC = list(DEFAULT_SETTINGS.keys())


@bp.get("/settings")
@login_required
def read_settings():
    conn = db()
    s = get_settings(conn)
    return jsonify({"settings": {k: s.get(k) for k in SETTINGS_PUBLIC},
                    "custom_fields": rows(conn.execute("SELECT * FROM custom_fields ORDER BY sort, id")),
                    "staff": rows(conn.execute("SELECT id, name, role, phone, active FROM staff ORDER BY active DESC, name")),
                    "units": UNITS,
                    "offsets_preview": [rem.kind_label(k) for k, _ in rem.parse_offsets(s["reminder_offsets"])]})


@bp.put("/settings")
@admin_required
def write_settings():
    d = body()
    conn = db()
    with conn:
        for k, v in d.items():
            if k not in SETTINGS_PUBLIC:
                continue
            v = "" if v is None else str(v).strip()
            if k in ("owner_phone", "business_phone") and v:
                v = phone_or_error(v, "Owner phone" if k == "owner_phone" else "Business phone")
            if k in ("quiet_start", "quiet_end") and v and not valid_hhmm(v):
                raise ApiError("Quiet hours must look like 21:00")
            if k == "reminder_offsets":
                rem.parse_offsets(v)
            if k == "whatsapp_provider" and v not in ("test", "meta", "twilio"):
                raise ApiError("Unknown WhatsApp provider")
            conn.execute("INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                         (k, v))
        audit(conn, me(), "settings", None, "changed", {k: d[k] for k in d if k in SETTINGS_PUBLIC})
        rem.sync_all(conn)
    wake_scheduler()
    return read_settings()


@bp.post("/staff")
@admin_required
def add_staff():
    d = body()
    name = (d.get("name") or "").strip()
    pin = str(d.get("pin") or "")
    if not name:
        raise ApiError("Name is required")
    if not re.fullmatch(r"\d{4,6}", pin):
        raise ApiError("PIN must be 4 to 6 digits")
    conn = db()
    with conn:
        sid = conn.execute("INSERT INTO staff(name, pin_hash, role, phone, created_at) VALUES(?,?,?,?,?)",
                           (name, generate_password_hash(pin), "admin" if d.get("role") == "admin" else "staff",
                            phone_or_error(d["phone"]) if d.get("phone") else None, iso(_now()))).lastrowid
        audit(conn, me(), "staff", sid, "added", {"name": name})
    return jsonify({"id": sid})


@bp.put("/staff/<int:sid>")
@admin_required
def edit_staff(sid):
    d = body()
    conn = db()
    with conn:
        if sid == session["staff_id"] and (d.get("active") is False or d.get("role") == "staff"):
            raise ApiError("You cannot remove your own owner access")
        if d.get("pin"):
            if not re.fullmatch(r"\d{4,6}", str(d["pin"])):
                raise ApiError("PIN must be 4 to 6 digits")
            conn.execute("UPDATE staff SET pin_hash=? WHERE id=?", (generate_password_hash(str(d["pin"])), sid))
        if "name" in d and d["name"].strip():
            conn.execute("UPDATE staff SET name=? WHERE id=?", (d["name"].strip(), sid))
        if "role" in d:
            conn.execute("UPDATE staff SET role=? WHERE id=?", ("admin" if d["role"] == "admin" else "staff", sid))
        if "active" in d:
            conn.execute("UPDATE staff SET active=? WHERE id=?", (1 if d["active"] else 0, sid))
        if "phone" in d:
            conn.execute("UPDATE staff SET phone=? WHERE id=?", (phone_or_error(d["phone"]) if d["phone"] else None, sid))
        audit(conn, me(), "staff", sid, "edited", {k: v for k, v in d.items() if k != "pin"})
    return jsonify({"ok": True})


@bp.post("/custom-fields")
@admin_required
def add_field():
    d = body()
    label = (d.get("label") or "").strip()
    if not label:
        raise ApiError("Column name is required")
    key = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_") or "field"
    conn = db()
    base, i = key, 2
    while conn.execute("SELECT 1 FROM custom_fields WHERE key=?", (key,)).fetchone():
        key, i = f"{base}_{i}", i + 1
    ft = d.get("field_type") if d.get("field_type") in ("text", "number", "date", "yesno", "choice") else "text"
    with conn:
        fid = conn.execute("INSERT INTO custom_fields(key, label, field_type, options, sort) VALUES(?,?,?,?,?)",
                           (key, label, ft, d.get("options"), int(d.get("sort") or 0))).lastrowid
        audit(conn, me(), "custom_field", fid, "added", {"label": label})
    return jsonify({"id": fid, "key": key})


@bp.put("/custom-fields/<int:fid>")
@admin_required
def edit_field(fid):
    d = body()
    conn = db()
    with conn:
        conn.execute("UPDATE custom_fields SET label=COALESCE(?, label), options=COALESCE(?, options), "
                     "active=COALESCE(?, active), sort=COALESCE(?, sort) WHERE id=?",
                     (d.get("label"), d.get("options"), None if "active" not in d else int(bool(d["active"])),
                      d.get("sort"), fid))
    return jsonify({"ok": True})


@bp.get("/audit")
@admin_required
def audit_list():
    return jsonify(rows(db().execute("SELECT * FROM audit_log ORDER BY id DESC LIMIT 300")))


@bp.post("/sample-data/clear")
@admin_required
def clear_samples():
    conn = db()
    with conn:
        n = conn.execute("UPDATE events SET deleted_at=? WHERE deleted_at IS NULL AND customer_id IN "
                         "(SELECT id FROM customers WHERE is_sample=1)", (iso(_now()),)).rowcount
        for r in conn.execute("SELECT id FROM events WHERE customer_id IN (SELECT id FROM customers WHERE is_sample=1)"
                              ).fetchall():
            rem.sync_event_reminders(conn, r["id"])
        audit(conn, me(), "events", None, "sample bookings removed", {"count": n})
    return jsonify({"removed": n})


# ---------------------------------------------------------------- export & backup
@bp.get("/export/events.csv")
@login_required
def export_events():
    conn = db()
    fields = rows(conn.execute("SELECT key, label FROM custom_fields WHERE active=1 ORDER BY sort, id"))
    buf = io.StringIO()
    buf.write("﻿")                               # BOM so Excel shows ₹ and local scripts correctly
    w = csv.writer(buf)
    w.writerow(["Booking #", "Status", "Event", "Type", "Date", "End date", "Time", "Customer", "Phone", "Venue",
                "Guests", "Food items", "Total", "Paid", "Balance", "Special instructions", "Notes", "Assigned to"]
               + [f["label"] for f in fields] + ["Last changed by", "Last changed at"])
    for r in conn.execute(EVENT_SELECT + " WHERE e.deleted_at IS NULL ORDER BY e.event_date"):
        d = decorate(r)
        w.writerow([d["id"], d["status"], d["title"], d["event_type"], d["event_date"], d["end_date"], d["event_time"],
                    d["customer_name"], d["customer_phone"], d["venue"], d["guest_count"], d["items_text"],
                    d["total_amount"], d["paid"], d["balance"], d["special_instructions"], d["notes"],
                    d["assigned_name"]] + [d["extra"].get(f["key"], "") for f in fields]
                   + [d["updated_by"], d["updated_at"]])
    return Response(buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": f"attachment; filename=bookings-{_now().date()}.csv"})


@bp.get("/backup")
@admin_required
def backup():
    src = connect(current_app.config["DB_PATH"])
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    dst = sqlite3.connect(path)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    with open(path, "rb") as f:
        data = f.read()
    os.remove(path)
    return Response(data, mimetype="application/octet-stream",
                    headers={"Content-Disposition": f"attachment; filename=catering-backup-{_now():%Y%m%d-%H%M}.db"})

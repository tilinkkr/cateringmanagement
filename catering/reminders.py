"""Reminder engine: planning, sending, retrying and escalating WhatsApp reminders.

See docs/SRS.md section 5 for the algorithm description.
"""
import re
from datetime import datetime, timedelta

from .db import get_settings
from .util import (now as _now, iso, parse_dt, parse_hhmm, event_start, normalize_phone,
                   fmt_date_long, fmt_time12, days_until)
from .whatsapp import get_sender

WARNING_KIND = "before_2d"
BACKOFF_MIN = [5, 15, 45, 120]          # minutes between attempts
MAX_ATTEMPTS = 5
CLAIM_TIMEOUT = timedelta(minutes=10)    # a 'sending' row older than this is retried
URGENT_DURING_QUIET = timedelta(hours=10)
OPEN = ("pending", "retry")


# ---------------------------------------------------------------- schedule helpers
def parse_offsets(spec: str):
    """'7d,2d,1d,4h' -> [('before_7d', 7 days), ...] sorted far -> near.
    The 2-day warning is a business rule and is always present."""
    out = {}
    for part in (spec or "").split(","):
        m = re.fullmatch(r"\s*(\d+)\s*([dh])\s*", part.lower())
        if not m or int(m[1]) == 0:
            continue
        n, u = int(m[1]), m[2]
        out[f"before_{n}{u}"] = timedelta(days=n) if u == "d" else timedelta(hours=n)
    out.setdefault(WARNING_KIND, timedelta(days=2))
    return sorted(out.items(), key=lambda kv: -kv[1])


def kind_label(kind: str) -> str:
    if kind == WARNING_KIND:
        return "2 days before - WARNING"
    m = re.fullmatch(r"before_(\d+)([dh])", kind)
    if m:
        n, u = int(m[1]), m[2]
        unit = ("day" if n == 1 else "days") if u == "d" else ("hour" if n == 1 else "hours")
        return f"{n} {unit} before"
    if kind == "booking":
        return "Booking confirmation"
    if kind.startswith("changed"):
        return "Date / time changed"
    if kind.startswith("custom"):
        return "Custom reminder"
    if kind == "alert_unconfirmed":
        return "Owner alert: not re-confirmed"
    if kind.startswith("alert_failed"):
        return "Owner alert: reminder failed"
    return kind


def _quiet(s):
    try:
        return parse_hhmm(s["quiet_start"]), parse_hhmm(s["quiet_end"])
    except (ValueError, TypeError, KeyError):
        return None, None


def in_quiet(dt: datetime, qs, qe) -> bool:
    if qs is None or qs == qe:
        return False
    t = dt.time()
    return (t >= qs or t < qe) if qs > qe else (qs <= t < qe)


def shift_out_of_quiet(due: datetime, qs, qe) -> datetime:
    """Move a reminder that falls in quiet hours EARLIER (to 30 min before quiet start)
    - never later, so it still arrives before the event."""
    if not in_quiet(due, qs, qe):
        return due
    day = due.date()
    if qs > qe and due.time() < qe:      # after midnight -> belongs to previous evening
        day -= timedelta(days=1)
    return datetime.combine(day, qs) - timedelta(minutes=30)


# ---------------------------------------------------------------- planning
def sync_event_reminders(conn, event_id, now=None):
    """Idempotently plan the before_* reminders for one event."""
    now = now or _now()
    ev = conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
    if not ev:
        return
    if ev["deleted_at"] or ev["status"] != "confirmed":
        reason = "Booking deleted" if ev["deleted_at"] else f"Booking is {ev['status']}"
        conn.execute(
            "UPDATE reminders SET status='cancelled', last_error=? WHERE event_id=? AND status IN ('pending','retry') "
            "AND kind NOT LIKE 'custom%'", (reason, event_id))
        return

    s = get_settings(conn)
    qs, qe = _quiet(s)
    start = event_start(ev)
    start_key = iso(start)
    offsets = parse_offsets(s["reminder_offsets"])
    contacts = conn.execute("SELECT * FROM event_contacts WHERE event_id=?", (event_id,)).fetchall()

    desired = {}
    for c in contacts:
        for kind, delta in offsets:
            desired[(kind, c["phone"])] = (shift_out_of_quiet(start - delta, qs, qe), c)

    existing = {(r["kind"], r["phone"]): r for r in conn.execute(
        "SELECT * FROM reminders WHERE event_id=? AND kind LIKE 'before_%'", (event_id,))}

    for key, r in existing.items():
        if key not in desired:
            if r["status"] in OPEN:
                conn.execute("UPDATE reminders SET status='cancelled', last_error='No longer needed' WHERE id=?",
                             (r["id"],))
            continue
        due, c = desired[key]
        same_schedule = r["event_start"] == start_key
        if same_schedule and r["status"] in OPEN and r["due_at"] == iso(due):
            continue                                         # nothing changed
        if same_schedule and r["status"] in ("sent", "failed", "skipped", "expired", "sending"):
            continue                                         # already handled for this date
        conn.execute(
            "UPDATE reminders SET status='pending', due_at=?, event_start=?, recipient_name=?, role=?, attempts=0, "
            "next_attempt_at=NULL, last_error=NULL, escalated=0, sent_at=NULL WHERE id=?",
            (iso(due), start_key, c["name"], c["role"], r["id"]))

    for key, (due, c) in desired.items():
        if key not in existing:
            conn.execute(
                "INSERT INTO reminders(event_id, recipient_name, phone, role, kind, due_at, event_start, status, "
                "created_at) VALUES(?,?,?,?,?,?,?, 'pending', ?)",
                (event_id, c["name"], c["phone"], c["role"], key[0], iso(due), start_key, iso(now)))

    _collapse_overdue(conn, event_id, start_key, now)


def _collapse_overdue(conn, event_id, start_key, now):
    """If several reminders for one person are already overdue (late booking / PC was off),
    only send the one closest to the event; mark the older ones as skipped."""
    rows = conn.execute(
        "SELECT * FROM reminders WHERE event_id=? AND kind LIKE 'before_%' AND event_start=? AND due_at<=? "
        "AND status IN ('pending','retry','sent','sending') ORDER BY phone, due_at DESC",
        (event_id, start_key, iso(now))).fetchall()
    seen = set()
    for r in rows:
        if r["phone"] in seen:
            if r["status"] in OPEN:
                conn.execute("UPDATE reminders SET status='skipped', last_error=? WHERE id=?",
                             ("Skipped - a later reminder replaces it (late booking or computer was off)", r["id"]))
        else:
            seen.add(r["phone"])


def queue_one_off(conn, event_id, kind, name, phone, role, due: datetime, note=None, now=None):
    now = now or _now()
    conn.execute(
        "INSERT OR IGNORE INTO reminders(event_id, recipient_name, phone, role, kind, note, due_at, status, created_at) "
        "VALUES(?,?,?,?,?,?,?, 'pending', ?)", (event_id, name, phone, role, kind, note, iso(due), iso(now)))


def queue_booking_confirmation(conn, event_id, now=None):
    now = now or _now()
    s = get_settings(conn)
    if s["send_booking_confirmation"] != "1":
        return
    for c in conn.execute("SELECT * FROM event_contacts WHERE event_id=? AND role='customer'", (event_id,)):
        queue_one_off(conn, event_id, "booking", c["name"], c["phone"], c["role"], now, now=now)


def queue_change_notice(conn, event_id, version, now=None):
    now = now or _now()
    s = get_settings(conn)
    if s["notify_on_change"] != "1":
        return
    for c in conn.execute("SELECT * FROM event_contacts WHERE event_id=?", (event_id,)):
        queue_one_off(conn, event_id, f"changed_v{version}", c["name"], c["phone"], c["role"], now, now=now)


def sync_all(conn, now=None):
    now = now or _now()
    since = (now.date() - timedelta(days=1)).isoformat()
    for r in conn.execute("SELECT id FROM events WHERE event_date>=? OR id IN "
                          "(SELECT event_id FROM reminders WHERE status IN ('pending','retry'))", (since,)).fetchall():
        sync_event_reminders(conn, r["id"], now)


# ---------------------------------------------------------------- messages
def build_message(conn, ev, r, s, now=None) -> str:
    now = now or _now()
    start = event_start(ev)
    biz = s.get("business_name") or "Catering"
    cust = conn.execute("SELECT * FROM customers WHERE id=?", (ev["customer_id"],)).fetchone()
    items = conn.execute("SELECT * FROM event_items WHERE event_id=? ORDER BY sort, id", (ev["id"],)).fetchall()
    d = days_until(start, now)
    kind = r["kind"]
    staff_view = r["role"] not in ("customer",)

    if kind == "booking":
        head = "✅ Your booking is CONFIRMED. Thank you!"
    elif kind.startswith("changed"):
        head = "📢 Event details have CHANGED. Please note the new details below."
    elif kind == "alert_unconfirmed":
        head = "🚨 OWNER ALERT: event is close and NOT yet re-confirmed with the customer. Please call them."
    elif kind.startswith("alert_failed"):
        head = f"🚨 OWNER ALERT: a WhatsApp reminder could not be delivered. Please call {r['note'] or 'them'}."
    elif kind.startswith("custom"):
        head = "🔔 Reminder" + (f": {r['note']}" if r["note"] else "")
    elif d <= 0:
        head = "⏰ Your event is TODAY."
    elif d == 1:
        head = "⏰ Your event is TOMORROW."
    elif d == 2:
        head = "⚠️ IMPORTANT: Your event is in 2 days."
    else:
        head = f"🔔 Reminder: Your event is in {d} days."
    if staff_view and head.startswith(("⏰ Your", "⚠️ IMPORTANT: Your", "🔔 Reminder: Your")):
        head = head.replace("Your event", "Event")

    lines = [f"*{biz}*", f"Hello {r['recipient_name']},", head, "",
             f"🎉 *{ev['title']}*" + (f"  (Booking #{ev['id']})" if staff_view else ""),
             f"📅 Date: {fmt_date_long(ev['event_date'])}"
             + (f" to {fmt_date_long(ev['end_date'])}" if ev["end_date"] else "")]
    if ev["event_time"]:
        lines.append(f"⏰ Time: {fmt_time12(ev['event_time'])}")
    else:
        lines.append("⏰ Time: NOT FIXED YET - please confirm the time with us")
    if ev["venue"]:
        lines.append(f"📍 Venue: {ev['venue']}")
    if ev["venue_map"]:
        lines.append(f"🗺️ Map: {ev['venue_map']}")
    lines.append(f"👥 Guests: {ev['guest_count']}")
    if items:
        lines.append("🍛 Menu:")
        for it in items:
            qty = f"{it['quantity']:g} {it['unit']}"
            lines.append(f"  • {it['item_name']} - {qty}" + (f" ({it['notes']})" if it["notes"] else ""))
    if ev["special_instructions"]:
        lines.append(f"⚠️ Special: {ev['special_instructions']}")
    if staff_view and cust:
        lines.append(f"👤 Customer: {cust['name']} {cust['phone']}")
    if r["role"] == "customer" and d <= 2 and not kind.startswith(("alert", "custom")):
        lines += ["", "Please reply *YES* to confirm everything is correct, or call us if anything has changed."]
    if s.get("business_phone"):
        lines.append(f"📞 {biz}: {s['business_phone']}")
    return "\n".join(lines)


# ---------------------------------------------------------------- sending
def _claim(conn, rid, now) -> bool:
    cur = conn.execute("UPDATE reminders SET status='sending', claimed_at=? WHERE id=? AND status IN ('pending','retry')",
                       (iso(now), rid))
    conn.commit()
    return cur.rowcount == 1


def send_reminder(conn, rid, sender=None, now=None, force=False):
    """Send one reminder (used by the loop and by the 'Send now' button). Returns (ok, message)."""
    now = now or _now()
    s = get_settings(conn)
    r = conn.execute("SELECT * FROM reminders WHERE id=?", (rid,)).fetchone()
    if not r:
        return False, "Reminder not found"
    if force and r["status"] in ("failed", "skipped", "expired", "cancelled", "sent"):
        conn.execute("UPDATE reminders SET status='retry', attempts=0 WHERE id=?", (rid,))
    if not _claim(conn, rid, now):
        return False, "This reminder is already being sent or is closed"
    ev = conn.execute("SELECT * FROM events WHERE id=?", (r["event_id"],)).fetchone()
    sender = sender or get_sender(s["whatsapp_provider"])
    sample = conn.execute("SELECT is_sample FROM customers WHERE id=?", (ev["customer_id"],)).fetchone()
    if sample and sample["is_sample"] and sender.name not in ("test", "fake"):
        # never send real WhatsApp messages to the made-up sample numbers
        conn.execute("UPDATE reminders SET status='cancelled', last_error='Sample booking - not sent', claimed_at=NULL "
                     "WHERE id=?", (rid,))
        conn.commit()
        return False, "Sample booking - not sent"
    text = build_message(conn, ev, r, s, now)
    res = sender.send(r["phone"], text, {"name": r["recipient_name"]})
    conn.execute("INSERT INTO outbox(reminder_id, event_id, phone, recipient_name, message, provider, ok, provider_ref, "
                 "error, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                 (rid, r["event_id"], r["phone"], r["recipient_name"], text, sender.name, int(res.ok), res.ref,
                  res.error, iso(now)))
    if res.ok:
        conn.execute("UPDATE reminders SET status='sent', sent_at=?, message=?, attempts=attempts+1, last_error=NULL, "
                     "claimed_at=NULL WHERE id=?", (iso(now), text, rid))
        conn.commit()
        return True, "Sent"
    attempts = r["attempts"] + 1
    if attempts >= MAX_ATTEMPTS:
        conn.execute("UPDATE reminders SET status='failed', attempts=?, last_error=?, message=?, claimed_at=NULL "
                     "WHERE id=?", (attempts, res.error, text, rid))
    else:
        nxt = now + timedelta(minutes=BACKOFF_MIN[min(attempts - 1, len(BACKOFF_MIN) - 1)])
        conn.execute("UPDATE reminders SET status='retry', attempts=?, last_error=?, next_attempt_at=?, message=?, "
                     "claimed_at=NULL WHERE id=?", (attempts, res.error, iso(nxt), text, rid))
    conn.commit()
    return False, res.error


def process_due(conn, sender=None, now=None):
    now = now or _now()
    s = get_settings(conn)
    qs, qe = _quiet(s)
    quiet_now = in_quiet(now, qs, qe)
    # release stale claims (crash while sending)
    conn.execute("UPDATE reminders SET status='retry' WHERE status='sending' AND claimed_at<=?",
                 (iso(now - CLAIM_TIMEOUT),))
    rows = conn.execute(
        "SELECT r.*, e.event_date, e.event_time FROM reminders r JOIN events e ON e.id=r.event_id "
        "WHERE r.status IN ('pending','retry') AND r.due_at<=? AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=?) "
        "ORDER BY r.due_at", (iso(now), iso(now))).fetchall()
    sent = 0
    for r in rows:
        start = event_start(r)
        custom = r["kind"].startswith("custom")
        if start <= now and not custom:
            conn.execute("UPDATE reminders SET status='expired', last_error='Event time already passed' WHERE id=?",
                         (r["id"],))
            continue
        if quiet_now and not custom and start - now > URGENT_DURING_QUIET:
            continue                         # wait for the morning
        ok, _ = send_reminder(conn, r["id"], sender, now)
        sent += ok
    conn.commit()
    return sent


def check_escalations(conn, now=None):
    """Owner alerts: (1) event within 48h not re-confirmed, (2) reminder FAILED."""
    now = now or _now()
    s = get_settings(conn)
    try:
        owner = normalize_phone(s.get("owner_phone"), s.get("country_code") or "91")
    except ValueError:
        return
    ack = timedelta(hours=float(s.get("ack_hours") or 12))
    rows = conn.execute(
        "SELECT * FROM events WHERE status='confirmed' AND deleted_at IS NULL AND final_confirmed_at IS NULL "
        "AND escalated_at IS NULL AND event_date BETWEEN ? AND ?",
        (now.date().isoformat(), (now.date() + timedelta(days=2)).isoformat())).fetchall()
    for ev in rows:
        start = event_start(ev)
        if not (now < start <= now + timedelta(hours=48)):
            continue
        warned = conn.execute(
            "SELECT 1 FROM reminders WHERE event_id=? AND role='customer' AND status='sent' AND sent_at<=? "
            "AND (kind LIKE 'before_%' OR kind='booking')", (ev["id"], iso(now - ack))).fetchone()
        if warned or start - now <= timedelta(hours=24):
            queue_one_off(conn, ev["id"], "alert_unconfirmed", "Owner", owner, "owner", now, now=now)
            conn.execute("UPDATE events SET escalated_at=? WHERE id=?", (iso(now), ev["id"]))
    for r in conn.execute("SELECT * FROM reminders WHERE status='failed' AND escalated=0 AND kind NOT LIKE 'alert_%'"
                          ).fetchall():
        if r["phone"] != owner:
            queue_one_off(conn, r["event_id"], f"alert_failed_{r['id']}", "Owner", owner, "owner", now,
                          note=f"{r['recipient_name']} ({r['phone']})", now=now)
        conn.execute("UPDATE reminders SET escalated=1 WHERE id=?", (r["id"],))
    conn.commit()


def run_cycle(conn, sender=None, now=None):
    now = now or _now()
    sync_all(conn, now)
    conn.commit()
    check_escalations(conn, now)
    return process_due(conn, sender, now)

"""Run:  python -m unittest discover tests -v"""
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from catering import inventory as inv                      # noqa: E402
from catering import reminders as rem                      # noqa: E402
from catering.db import connect, init_db                   # noqa: E402
from catering.util import normalize_phone, iso             # noqa: E402
from catering.whatsapp import SendResult                   # noqa: E402


class FakeSender:
    name = "fake"

    def __init__(self, fail=False):
        self.sent, self.fail = [], fail

    def send(self, phone, text, params=None):
        self.sent.append((phone, text))
        return SendResult(False, error="boom") if self.fail else SendResult(True, "X")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, "t.db")
        init_db(self.path, seed=False)
        self.c = connect(self.path)
        self.c.execute("INSERT INTO customers(name, phone, created_at) VALUES('Ravi','+919999900000','x')")
        self.c.commit()

    def tearDown(self):
        self.c.close()

    def make_event(self, start: datetime, status="confirmed", contacts=(("Ravi", "+919999900000", "customer"),)):
        cur = self.c.execute(
            "INSERT INTO events(customer_id, title, event_date, event_time, guest_count, status, created_at, updated_at)"
            " VALUES(1,'Wedding',?,?,100,?, 'x','x')", (start.date().isoformat(), start.strftime("%H:%M"), status))
        eid = cur.lastrowid
        for n, p, r in contacts:
            self.c.execute("INSERT INTO event_contacts(event_id, name, phone, role) VALUES(?,?,?,?)", (eid, n, p, r))
        self.c.commit()
        return eid

    def reminders(self, eid):
        return {r["kind"]: dict(r) for r in self.c.execute("SELECT * FROM reminders WHERE event_id=?", (eid,))}


class TestPhone(unittest.TestCase):
    def test_formats(self):
        for raw in ("9876543210", "09876543210", "+91 98765 43210", "98765-43210", "0091 9876543210"):
            self.assertEqual(normalize_phone(raw), "+919876543210")

    def test_invalid(self):
        for raw in ("", "12345", "abc"):
            with self.assertRaises(ValueError):
                normalize_phone(raw)


class TestReminderPlanning(Base):
    def test_default_schedule_and_quiet_hours(self):
        now = datetime(2026, 1, 1, 10, 0)
        eid = self.make_event(datetime(2026, 1, 20, 19, 30))
        rem.sync_event_reminders(self.c, eid, now)
        r = self.reminders(eid)
        self.assertEqual(set(r), {"before_7d", "before_2d", "before_1d", "before_4h"})
        self.assertEqual(r["before_2d"]["due_at"], "2026-01-18 19:30:00")
        self.assertEqual(r["before_4h"]["due_at"], "2026-01-20 15:30:00")

    def test_quiet_hours_move_earlier(self):
        now = datetime(2026, 1, 1, 10, 0)
        eid = self.make_event(datetime(2026, 1, 20, 7, 0))          # breakfast event
        rem.sync_event_reminders(self.c, eid, now)
        r = self.reminders(eid)
        # 4h before = 03:00 (quiet) -> previous evening 20:30
        self.assertEqual(r["before_4h"]["due_at"], "2026-01-19 20:30:00")
        self.assertEqual(r["before_2d"]["due_at"], "2026-01-18 07:00:00")

    def test_two_day_warning_cannot_be_removed(self):
        self.assertIn("before_2d", dict(rem.parse_offsets("5d,3h")))

    def test_late_booking_collapses_overdue(self):
        start = datetime(2026, 1, 10, 19, 0)
        now = start - timedelta(hours=30)                           # booked 30h before
        eid = self.make_event(start)
        rem.sync_event_reminders(self.c, eid, now)
        r = self.reminders(eid)
        self.assertEqual(r["before_7d"]["status"], "skipped")      # older overdue one dropped
        self.assertEqual(r["before_2d"]["status"], "pending")      # the most urgent overdue one is sent
        self.assertEqual(r["before_1d"]["status"], "pending")      # still in the future
        s = FakeSender()
        rem.process_due(self.c, s, now)
        self.assertEqual(len(s.sent), 1)
        self.assertIn("TOMORROW", s.sent[0][1])
        # booked only 10h before: everything except 4h is overdue -> only one goes out
        eid2 = self.make_event(start, contacts=(("Asha", "+919999900001", "customer"),))
        rem.sync_event_reminders(self.c, eid2, start - timedelta(hours=10))
        st = {k: v["status"] for k, v in self.reminders(eid2).items()}
        self.assertEqual(st, {"before_7d": "skipped", "before_2d": "skipped", "before_1d": "pending",
                              "before_4h": "pending"})

    def test_reschedule_rearms_sent_reminders(self):
        now = datetime(2026, 1, 1, 10, 0)
        start = datetime(2026, 1, 5, 12, 0)
        eid = self.make_event(start)
        rem.sync_event_reminders(self.c, eid, now)
        s = FakeSender()
        rem.process_due(self.c, s, datetime(2026, 1, 3, 12, 1))   # 2d warning goes out
        self.assertEqual(self.reminders(eid)["before_2d"]["status"], "sent")
        self.c.execute("UPDATE events SET event_date='2026-01-15' WHERE id=?", (eid,))
        rem.sync_event_reminders(self.c, eid, datetime(2026, 1, 3, 13, 0))
        r = self.reminders(eid)
        self.assertEqual(r["before_2d"]["status"], "pending")
        self.assertEqual(r["before_2d"]["due_at"], "2026-01-13 12:00:00")

    def test_cancel_and_restore(self):
        now = datetime(2026, 1, 1, 10, 0)
        eid = self.make_event(datetime(2026, 1, 20, 12, 0))
        rem.sync_event_reminders(self.c, eid, now)
        self.c.execute("UPDATE events SET status='cancelled' WHERE id=?", (eid,))
        rem.sync_event_reminders(self.c, eid, now)
        self.assertTrue(all(r["status"] == "cancelled" for r in self.reminders(eid).values()))
        self.c.execute("UPDATE events SET status='confirmed' WHERE id=?", (eid,))
        rem.sync_event_reminders(self.c, eid, now)
        self.assertTrue(all(r["status"] == "pending" for r in self.reminders(eid).values()))

    def test_enquiry_gets_no_reminders(self):
        eid = self.make_event(datetime(2026, 1, 20, 12, 0), status="enquiry")
        rem.sync_event_reminders(self.c, eid, datetime(2026, 1, 1))
        self.assertEqual(self.reminders(eid), {})


class TestReminderSending(Base):
    def test_retry_backoff_then_fail_and_escalate(self):
        self.c.execute("UPDATE settings SET value='9000011111' WHERE key='owner_phone'")
        start = datetime(2026, 1, 10, 12, 0)
        eid = self.make_event(start)
        now = datetime(2026, 1, 1, 9, 0)
        rem.sync_event_reminders(self.c, eid, now)
        bad = FakeSender(fail=True)
        t = datetime(2026, 1, 3, 12, 0)                              # 7d reminder due
        for i in range(5):
            rem.process_due(self.c, bad, t)
            r = self.reminders(eid)["before_7d"]
            if r["status"] == "failed":
                break
            self.assertEqual(r["status"], "retry")
            t = datetime.strptime(r["next_attempt_at"], "%Y-%m-%d %H:%M:%S")
        self.assertEqual(self.reminders(eid)["before_7d"]["status"], "failed")
        self.assertEqual(self.reminders(eid)["before_7d"]["attempts"], 5)
        rem.check_escalations(self.c, t)
        alerts = [k for k in self.reminders(eid) if k.startswith("alert_failed")]
        self.assertEqual(len(alerts), 1)

    def test_no_double_send(self):
        eid = self.make_event(datetime(2026, 1, 10, 12, 0))
        rem.sync_event_reminders(self.c, eid, datetime(2026, 1, 1))
        rid = self.reminders(eid)["before_7d"]["id"]
        self.c.execute("UPDATE reminders SET status='sending', claimed_at=? WHERE id=?", (iso(datetime(2026, 1, 3, 12)), rid))
        self.c.commit()
        s = FakeSender()
        rem.process_due(self.c, s, datetime(2026, 1, 3, 12, 1))
        self.assertEqual(len(s.sent), 0)                             # claimed by someone else
        rem.process_due(self.c, s, datetime(2026, 1, 3, 12, 30))     # stale claim released -> retried
        self.assertEqual(len(s.sent), 1)

    def test_past_events_expire(self):
        eid = self.make_event(datetime(2026, 1, 10, 12, 0))
        rem.sync_event_reminders(self.c, eid, datetime(2026, 1, 1))
        s = FakeSender()
        rem.process_due(self.c, s, datetime(2026, 1, 11))
        self.assertEqual(len(s.sent), 0)
        self.assertTrue(all(r["status"] == "expired" for r in self.reminders(eid).values()))

    def test_unconfirmed_escalation(self):
        self.c.execute("UPDATE settings SET value='9000011111' WHERE key='owner_phone'")
        start = datetime(2026, 1, 10, 12, 0)
        eid = self.make_event(start)
        rem.check_escalations(self.c, start - timedelta(hours=20))
        self.assertIn("alert_unconfirmed", self.reminders(eid))

    def test_quiet_hours_hold_non_urgent(self):
        eid = self.make_event(datetime(2026, 1, 10, 12, 0))
        rem.queue_one_off(self.c, eid, "booking", "Ravi", "+919999900000", "customer", datetime(2026, 1, 1, 22, 0))
        s = FakeSender()
        rem.process_due(self.c, s, datetime(2026, 1, 1, 23, 0))
        self.assertEqual(len(s.sent), 0)
        rem.process_due(self.c, s, datetime(2026, 1, 2, 7, 1))
        self.assertEqual(len(s.sent), 1)


class TestInventory(Base):
    def setUp(self):
        super().setUp()
        c = self.c
        c.execute("INSERT INTO ingredients(id, name, unit, lead_time_days, unit_cost) VALUES(1,'Rice','kg',3,100)")
        c.execute("INSERT INTO ingredients(id, name, unit, lead_time_days, unit_cost) VALUES(2,'Milk','litre',1,50)")
        c.execute("INSERT INTO menu_items(id, name) VALUES(1,'Biryani')")
        c.execute("INSERT INTO recipes VALUES(1,1,0.1)")
        c.execute("INSERT INTO recipes VALUES(1,2,0.05)")
        c.execute("UPDATE settings SET value='0' WHERE key='wastage_pct'")
        c.commit()

    def add_event(self, d, plates):
        eid = self.make_event(datetime.combine(d, time(12)))
        self.c.execute("INSERT INTO event_items(event_id, menu_item_id, item_name, quantity) VALUES(?,1,'Biryani',?)",
                       (eid, plates))
        self.c.commit()
        return eid

    def test_bom_and_time_phased_netting_with_expiry(self):
        today = datetime.now().date()
        inv.receive(self.c, 1, 15)                                      # rice, no expiry
        self.c.execute("INSERT INTO stock_batches(ingredient_id, qty_received, qty_left, expiry_date, received_at) "
                       "VALUES(2, 20, 20, ?, 'x')", ((today + timedelta(days=2)).isoformat(),))
        e1 = self.add_event(today + timedelta(days=1), 100)            # needs 10 rice, 5 milk
        e2 = self.add_event(today + timedelta(days=5), 100)            # needs 10 rice, 5 milk (milk expired by then)
        plan = inv.mrp_plan(self.c, today, 30)
        by = {(l["event_id"], l["ingredient"]): l for l in plan["lines"]}
        self.assertEqual(by[(e1, "Rice")]["shortage"], 0)
        self.assertEqual(by[(e2, "Rice")]["shortage"], 5)
        self.assertEqual(by[(e1, "Milk")]["shortage"], 0)
        self.assertEqual(by[(e2, "Milk")]["shortage"], 5)              # expiry-aware
        self.assertEqual(by[(e2, "Rice")]["order_by"], (today + timedelta(days=2)).isoformat())

    def test_fefo_issue_and_no_double_issue(self):
        today = datetime.now().date()
        self.c.execute("INSERT INTO stock_batches(id, ingredient_id, qty_received, qty_left, expiry_date, received_at) "
                       "VALUES(10, 1, 5, 5, ?, 'a')", ((today + timedelta(days=30)).isoformat(),))
        self.c.execute("INSERT INTO stock_batches(id, ingredient_id, qty_received, qty_left, expiry_date, received_at) "
                       "VALUES(11, 1, 5, 5, ?, 'b')", ((today + timedelta(days=3)).isoformat(),))
        issued, short = inv.fefo_issue(self.c, 1, 6, "test")
        self.assertEqual((issued, short), (6, 0))
        left = {r["id"]: r["qty_left"] for r in self.c.execute("SELECT * FROM stock_batches")}
        self.assertEqual(left[11], 0)                                   # earliest expiry used first
        self.assertEqual(left[10], 4)
        eid = self.add_event(today + timedelta(days=1), 10)
        inv.issue_event_stock(self.c, eid)
        with self.assertRaises(ValueError):
            inv.issue_event_stock(self.c, eid)

    def test_policies(self):
        rop, safety = inv.reorder_point(2.0, 1.0, 4, 0.95)
        self.assertAlmostEqual(safety, 1.6449 * 2, places=2)
        self.assertAlmostEqual(rop, 8 + safety, places=6)
        self.assertAlmostEqual(inv.eoq(1000, 200, 100, 0.2), 141.42, places=1)
        self.assertEqual(inv.abc_classes({1: 800, 2: 150, 3: 50}), {1: "A", 2: "B", 3: "C"})
        self.assertAlmostEqual(inv.ses_forecast([10, 10, 10]), 10)


class TestApi(unittest.TestCase):
    def setUp(self):
        from app import create_app
        self.tmp = tempfile.mkdtemp()
        self.app = create_app(os.path.join(self.tmp, "api.db"), start_scheduler=False, seed=True)
        self.cl = self.app.test_client()
        r = self.cl.post("/api/login", json={"staff_id": 1, "pin": "1234"})
        self.assertEqual(r.status_code, 200)

    def booking(self, **kw):
        d = {"customer": {"name": "Meera", "phone": "98470 12345"}, "event_type": "Wedding",
             "event_date": (datetime.now().date() + timedelta(days=10)).isoformat(), "event_time": "18:00",
             "guest_count": 100, "items": [{"item_name": "Veg Biryani", "quantity": 100}],
             "contacts": [{"name": "Meera", "phone": "9847012345", "role": "customer"},
                          {"name": "Cook Babu", "phone": "9847000000", "role": "staff"}],
             "total_amount": 20000, "advance_amount": 5000}
        d.update(kw)
        return self.cl.post("/api/events", json=d)

    def test_create_edit_conflict_delete_restore(self):
        r = self.booking()
        self.assertEqual(r.status_code, 201, r.json)
        ev = r.json
        self.assertEqual(ev["customer_phone"], "+919847012345")
        self.assertEqual(ev["balance"], 15000)
        self.assertIsNotNone(ev["items"][0]["menu_item_id"])           # matched to menu -> stock plan
        self.assertEqual(len([x for x in ev["reminders"] if x["kind"] == "before_2d"]), 2)
        self.assertTrue(any(x["kind"] == "booking" for x in ev["reminders"]))
        upd = dict(ev, customer={"id": ev["customer_id"]}, event_time="19:00")
        r2 = self.cl.put(f"/api/events/{ev['id']}", json=upd)
        self.assertEqual(r2.status_code, 200, r2.json)
        self.assertTrue(any(x["kind"].startswith("changed") for x in r2.json["reminders"]))
        r3 = self.cl.put(f"/api/events/{ev['id']}", json=upd)          # stale version
        self.assertEqual(r3.status_code, 409)
        self.assertEqual(self.cl.delete(f"/api/events/{ev['id']}").status_code, 200)
        rs = self.cl.get(f"/api/events/{ev['id']}").json["reminders"]
        self.assertFalse(any(x["status"] == "pending" and x["kind"].startswith("before") for x in rs))
        self.assertEqual(self.cl.post(f"/api/events/{ev['id']}/restore").status_code, 200)

    def test_validation_messages(self):
        r = self.booking(customer={"name": "X", "phone": "123"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("phone", r.json["error"].lower())
        r = self.booking(event_date="2020-01-01")
        self.assertEqual(r.json.get("code"), "past_date")
        self.assertEqual(self.booking(event_date="2020-01-01", allow_past=True).status_code, 201)

    def test_board_is_public_and_hides_money(self):
        self.booking(event_date=(datetime.now().date() + timedelta(days=1)).isoformat())
        anon = self.app.test_client()
        b = anon.get("/api/board").json
        self.assertTrue(b["events"])
        txt = str(b)
        self.assertNotIn("+91", txt)
        self.assertNotIn("total_amount", txt)
        self.assertEqual(anon.get("/api/events").status_code, 401)

    def test_dashboard_and_stock(self):
        self.booking()
        d = self.cl.get("/api/dashboard").json
        self.assertIn("counts", d)
        self.assertTrue(self.cl.get("/api/stock").json["items"])
        self.assertIn("shopping", self.cl.get("/api/stock/plan").json)
        self.assertEqual(self.cl.get("/api/export/events.csv").status_code, 200)

    def test_wrong_pin_lockout(self):
        c = self.app.test_client()
        for _ in range(5):
            c.post("/api/login", json={"staff_id": 1, "pin": "0000"})
        self.assertEqual(c.post("/api/login", json={"staff_id": 1, "pin": "1234"}).status_code, 429)


if __name__ == "__main__":
    unittest.main()

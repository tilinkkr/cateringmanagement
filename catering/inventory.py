"""Inventory planning for catering.

Algorithms (see docs/SRS.md section 6):
  * BOM explosion (menu x recipe-per-plate x wastage)       -> event_requirements
  * Time-phased, expiry-aware MRP netting (FEFO simulation) -> mrp_plan
  * Simple exponential smoothing of daily usage              -> usage_stats
  * Reorder point with safety stock  ROP = d*L + Z*sigma*sqrt(L)
  * Economic order quantity          EOQ = sqrt(2DS/H)
  * ABC / Pareto classification on annual consumption value
  * FEFO stock issue (first-expiry-first-out)                -> fefo_issue
"""
import math
from collections import defaultdict
from datetime import date, timedelta
from statistics import NormalDist, mean, pstdev

from .db import get_settings, setting_float
from .util import now as _now, iso, parse_date

EPS = 1e-9


# ---------------------------------------------------------------- BOM explosion
def event_requirements(conn, event_id, wastage_pct=None):
    if wastage_pct is None:
        wastage_pct = setting_float(get_settings(conn), "wastage_pct")
    factor = 1 + wastage_pct / 100.0
    need = {}
    rows = conn.execute(
        "SELECT ei.quantity, r.qty_per_unit, i.id iid, i.name, i.unit, i.lead_time_days, i.unit_cost "
        "FROM event_items ei JOIN recipes r ON r.menu_item_id=ei.menu_item_id "
        "JOIN ingredients i ON i.id=r.ingredient_id WHERE ei.event_id=?", (event_id,)).fetchall()
    for r in rows:
        d = need.setdefault(r["iid"], {"ingredient_id": r["iid"], "name": r["name"], "unit": r["unit"],
                                       "lead_time_days": r["lead_time_days"], "unit_cost": r["unit_cost"], "qty": 0.0})
        d["qty"] += r["quantity"] * r["qty_per_unit"] * factor
    for d in need.values():
        d["qty"] = round(d["qty"], 3)
        d["cost"] = round(d["qty"] * d["unit_cost"], 2)
    unplanned = [dict(r) for r in conn.execute(
        "SELECT ei.item_name, ei.quantity, ei.unit FROM event_items ei WHERE ei.event_id=? AND (ei.menu_item_id IS NULL "
        "OR NOT EXISTS (SELECT 1 FROM recipes r WHERE r.menu_item_id=ei.menu_item_id))", (event_id,))]
    return sorted(need.values(), key=lambda x: x["name"]), unplanned


# ---------------------------------------------------------------- stock helpers
def _batches(conn, ingredient_id=None):
    sql = "SELECT * FROM stock_batches WHERE qty_left>0"
    args = ()
    if ingredient_id:
        sql += " AND ingredient_id=?"
        args = (ingredient_id,)
    return conn.execute(sql + " ORDER BY COALESCE(expiry_date,'9999-12-31'), received_at, id", args).fetchall()


def on_hand(conn, ingredient_id, as_of: date = None):
    as_of = (as_of or _now().date()).isoformat()
    r = conn.execute("SELECT COALESCE(SUM(qty_left),0) q FROM stock_batches WHERE ingredient_id=? AND qty_left>0 "
                     "AND (expiry_date IS NULL OR expiry_date>=?)", (ingredient_id, as_of)).fetchone()
    return round(r["q"], 3)


# ---------------------------------------------------------------- MRP
def mrp_plan(conn, today: date = None, horizon_days=30):
    """Process upcoming bookings in date order. For each, consume only batches that will
    still be fresh on the event date (FEFO). Remaining need = shortage, with an order-by date."""
    today = today or _now().date()
    s = get_settings(conn)
    wastage = setting_float(s, "wastage_pct")
    sim = defaultdict(list)                         # ingredient -> [[expiry, qty_left], ...] FEFO order
    for b in _batches(conn):
        sim[b["ingredient_id"]].append([b["expiry_date"], b["qty_left"]])

    events = conn.execute(
        "SELECT e.*, c.name customer_name FROM events e JOIN customers c ON c.id=e.customer_id "
        "WHERE e.deleted_at IS NULL AND e.status IN ('confirmed','enquiry') AND e.stock_issued=0 "
        "AND e.event_date BETWEEN ? AND ? ORDER BY e.event_date, COALESCE(e.event_time,'12:00')",
        (today.isoformat(), (today + timedelta(days=horizon_days)).isoformat())).fetchall()

    lines, totals = [], {}
    for ev in events:
        ev_date = parse_date(ev["event_date"])
        reqs, unplanned = event_requirements(conn, ev["id"], wastage)
        for rq in reqs:
            need = rq["qty"]
            covered = 0.0
            if ev["status"] == "confirmed":          # enquiries do not reserve stock
                for b in sim[rq["ingredient_id"]]:
                    if need - covered <= EPS:
                        break
                    if b[0] and b[0] < ev["event_date"]:
                        continue                     # will have expired by then
                    take = min(b[1], need - covered)
                    b[1] -= take
                    covered += take
            shortage = round(max(0.0, need - covered), 3)
            order_by = ev_date - timedelta(days=rq["lead_time_days"])
            line = {"event_id": ev["id"], "event_title": ev["title"], "event_date": ev["event_date"],
                    "event_status": ev["status"], "customer_name": ev["customer_name"],
                    "ingredient_id": rq["ingredient_id"], "ingredient": rq["name"], "unit": rq["unit"],
                    "required": round(need, 3), "covered": round(covered, 3), "shortage": shortage,
                    "order_by": order_by.isoformat(), "overdue": shortage > 0 and order_by < today}
            lines.append(line)
            if shortage > 0:
                t = totals.setdefault(rq["ingredient_id"], {"ingredient_id": rq["ingredient_id"], "ingredient": rq["name"],
                                                            "unit": rq["unit"], "shortage": 0.0,
                                                            "order_by": line["order_by"], "events": [],
                                                            "unit_cost": rq["unit_cost"]})
                t["shortage"] = round(t["shortage"] + shortage, 3)
                t["order_by"] = min(t["order_by"], line["order_by"])
                t["events"].append(ev["title"])
    stats = {r["id"]: r for r in stock_overview(conn, today)}
    shopping = []
    for t in totals.values():
        eoq = stats.get(t["ingredient_id"], {}).get("eoq") or 0
        t["suggested_qty"] = round(max(t["shortage"], eoq), 2)
        t["est_cost"] = round(t["suggested_qty"] * t["unit_cost"], 2)
        t["overdue"] = t["order_by"] < today.isoformat()
        shopping.append(t)
    shopping.sort(key=lambda x: x["order_by"])
    return {"lines": lines, "shopping": shopping, "horizon_days": horizon_days}


# ---------------------------------------------------------------- forecasting & policies
def daily_usage(conn, ingredient_id, days=60, today: date = None):
    today = today or _now().date()
    start = today - timedelta(days=days)
    series = {start + timedelta(days=i): 0.0 for i in range(days)}
    for r in conn.execute("SELECT substr(created_at,1,10) d, SUM(-qty) q FROM stock_moves WHERE ingredient_id=? "
                          "AND qty<0 AND event_id IS NULL AND reason NOT LIKE 'Expired%' "
                          "AND created_at>=? AND created_at<? GROUP BY d",   # baseline only; bookings use MRP
                          (ingredient_id, start.isoformat(), today.isoformat())):
        dd = parse_date(r["d"])
        if dd in series:
            series[dd] += r["q"]
    return [series[k] for k in sorted(series)]


def ses_forecast(series, alpha=0.3):
    if not series:
        return 0.0
    level = series[0]
    for x in series[1:]:
        level = alpha * x + (1 - alpha) * level
    return level


def reorder_point(d_mean, d_std, lead_days, service_level=0.95):
    z = NormalDist().inv_cdf(min(max(service_level, 0.5), 0.999))
    safety = z * d_std * math.sqrt(max(lead_days, 0))
    return d_mean * lead_days + safety, safety


def eoq(annual_demand, order_cost, unit_cost, holding_rate):
    h = unit_cost * holding_rate
    if annual_demand <= 0 or h <= 0 or order_cost <= 0:
        return None
    return math.sqrt(2 * annual_demand * order_cost / h)


def abc_classes(values: dict):
    """values: id -> annual consumption value. Pareto split 80% / 15% / 5%."""
    total = sum(values.values())
    out, cum = {}, 0.0
    for k, v in sorted(values.items(), key=lambda kv: -kv[1]):
        if total <= 0:
            out[k] = "C"
            continue
        share_before = cum / total
        cum += v
        out[k] = "A" if share_before < 0.80 else ("B" if share_before < 0.95 else "C")
    return out


def stock_overview(conn, today: date = None):
    today = today or _now().date()
    s = get_settings(conn)
    sl = setting_float(s, "service_level")
    order_cost = setting_float(s, "order_cost")
    holding = setting_float(s, "holding_rate")
    soon = (today + timedelta(days=3)).isoformat()
    rows = []
    for ing in conn.execute("SELECT * FROM ingredients WHERE active=1 ORDER BY name").fetchall():
        series = daily_usage(conn, ing["id"], 60, today)
        used_days = [x for x in series[-30:]]
        d_mean = mean(used_days) if used_days else 0.0
        d_std = pstdev(used_days) if len(used_days) > 1 else 0.0
        forecast = ses_forecast(series)
        rop, safety = reorder_point(max(d_mean, forecast), d_std, ing["lead_time_days"], sl)
        if ing["reorder_level"] is not None:
            rop = ing["reorder_level"]               # manual override wins
        annual = max(d_mean, forecast) * 365
        q = eoq(annual, order_cost, ing["unit_cost"], holding)
        oh = on_hand(conn, ing["id"], today)
        exp_soon = conn.execute("SELECT COALESCE(SUM(qty_left),0) q FROM stock_batches WHERE ingredient_id=? "
                                "AND qty_left>0 AND expiry_date IS NOT NULL AND expiry_date<=?",
                                (ing["id"], soon)).fetchone()["q"]
        status = "out" if oh <= EPS else ("low" if oh <= rop else "ok")
        rows.append({**dict(ing), "on_hand": oh, "avg_daily": round(d_mean, 3), "forecast_daily": round(forecast, 3),
                     "safety_stock": round(safety, 2), "rop": round(rop, 2), "eoq": round(q, 2) if q else None,
                     "annual_value": round(annual * ing["unit_cost"], 2),
                     "days_cover": round(oh / forecast, 1) if forecast > EPS else None,
                     "expiring_soon": round(exp_soon, 3), "status": status})
    classes = abc_classes({r["id"]: r["annual_value"] for r in rows})
    for r in rows:
        r["abc"] = classes.get(r["id"], "C")
    return rows


# ---------------------------------------------------------------- stock movements
def receive(conn, ingredient_id, qty, expiry=None, unit_cost=None, note=None, staff=None):
    if qty <= 0:
        raise ValueError("Quantity must be more than zero")
    t = iso(_now())
    if not expiry:
        ing = conn.execute("SELECT shelf_life_days FROM ingredients WHERE id=?", (ingredient_id,)).fetchone()
        if ing and ing["shelf_life_days"]:
            expiry = (_now().date() + timedelta(days=ing["shelf_life_days"])).isoformat()
    cur = conn.execute("INSERT INTO stock_batches(ingredient_id, qty_received, qty_left, expiry_date, unit_cost, note, "
                       "received_at) VALUES(?,?,?,?,?,?,?)", (ingredient_id, qty, qty, expiry, unit_cost, note, t))
    conn.execute("INSERT INTO stock_moves(ingredient_id, batch_id, qty, reason, created_by, created_at) "
                 "VALUES(?,?,?,?,?,?)", (ingredient_id, cur.lastrowid, qty, note or "Stock received", staff, t))
    if unit_cost:
        conn.execute("UPDATE ingredients SET unit_cost=? WHERE id=?", (unit_cost, ingredient_id))
    return cur.lastrowid


def fefo_issue(conn, ingredient_id, qty, reason, event_id=None, staff=None, today: date = None,
               include_expired=False):
    """Take stock from the batch that expires first. Returns (issued, shortfall)."""
    today = (today or _now().date()).isoformat()
    t = iso(_now())
    left = qty
    for b in _batches(conn, ingredient_id):
        if left <= EPS:
            break
        if b["expiry_date"] and b["expiry_date"] < today and not include_expired:
            continue
        take = min(b["qty_left"], left)
        conn.execute("UPDATE stock_batches SET qty_left=qty_left-? WHERE id=?", (take, b["id"]))
        conn.execute("INSERT INTO stock_moves(ingredient_id, batch_id, qty, reason, event_id, created_by, created_at) "
                     "VALUES(?,?,?,?,?,?,?)", (ingredient_id, b["id"], -take, reason, event_id, staff, t))
        left -= take
    return round(qty - left, 3), round(max(left, 0), 3)


def issue_event_stock(conn, event_id, staff=None):
    ev = conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
    if not ev:
        raise ValueError("Booking not found")
    if ev["stock_issued"]:
        raise ValueError("Stock was already issued for this booking")
    reqs, _ = event_requirements(conn, event_id)
    result = []
    for rq in reqs:
        issued, short = fefo_issue(conn, rq["ingredient_id"], rq["qty"], f"Used for booking #{event_id}",
                                   event_id, staff)
        result.append({"ingredient": rq["name"], "unit": rq["unit"], "required": rq["qty"],
                       "issued": issued, "shortfall": short})
    conn.execute("UPDATE events SET stock_issued=1 WHERE id=?", (event_id,))
    return result


def write_off_expired(conn, ingredient_id, staff=None, today: date = None):
    today = (today or _now().date()).isoformat()
    total = 0.0
    for b in conn.execute("SELECT * FROM stock_batches WHERE ingredient_id=? AND qty_left>0 AND expiry_date<?",
                          (ingredient_id, today)).fetchall():
        conn.execute("UPDATE stock_batches SET qty_left=0 WHERE id=?", (b["id"],))
        conn.execute("INSERT INTO stock_moves(ingredient_id, batch_id, qty, reason, created_by, created_at) "
                     "VALUES(?,?,?,?,?,?)", (ingredient_id, b["id"], -b["qty_left"], "Expired - thrown away", staff,
                                             iso(_now())))
        total += b["qty_left"]
    return round(total, 3)


def expiring(conn, days=3, today: date = None):
    today = today or _now().date()
    return [dict(r) for r in conn.execute(
        "SELECT b.*, i.name, i.unit FROM stock_batches b JOIN ingredients i ON i.id=b.ingredient_id "
        "WHERE b.qty_left>0 AND b.expiry_date IS NOT NULL AND b.expiry_date<=? ORDER BY b.expiry_date",
        ((today + timedelta(days=days)).isoformat(),))]

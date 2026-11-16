"""Small shared helpers: time handling and phone normalisation."""
import re
from datetime import datetime, date, time, timedelta

DT_FMT = "%Y-%m-%d %H:%M:%S"
DATE_FMT = "%Y-%m-%d"


def now() -> datetime:
    return datetime.now().replace(microsecond=0)


def iso(dt: datetime) -> str:
    return dt.strftime(DT_FMT)


def parse_dt(s: str) -> datetime:
    return datetime.strptime(s, DT_FMT)


def parse_date(s: str) -> date:
    return datetime.strptime(s, DATE_FMT).date()


def parse_hhmm(s: str) -> time:
    return datetime.strptime(s, "%H:%M").time()


def valid_date(s) -> bool:
    try:
        parse_date(s)
        return True
    except (TypeError, ValueError):
        return False


def valid_hhmm(s) -> bool:
    try:
        parse_hhmm(s)
        return True
    except (TypeError, ValueError):
        return False


DEFAULT_EVENT_TIME = time(12, 0)


def event_start(ev) -> datetime:
    """Start datetime of an event row. Unknown time -> 12:00 (flagged elsewhere)."""
    d = parse_date(ev["event_date"])
    t = parse_hhmm(ev["event_time"]) if ev["event_time"] else DEFAULT_EVENT_TIME
    return datetime.combine(d, t)


def normalize_phone(raw, default_cc: str = "91") -> str:
    """Return +<country><number>. Accepts 098.., +91 98.., 98..-.., 0091.. etc."""
    digits = re.sub(r"\D", "", str(raw or ""))
    if not digits:
        raise ValueError("Phone number is required")
    if digits.startswith("00"):
        digits = digits[2:]
    if len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if len(digits) == 10:
        digits = default_cc + digits
    if not 11 <= len(digits) <= 15:
        raise ValueError(f"'{raw}' does not look like a valid phone number")
    return "+" + digits


def fmt_date_long(d) -> str:
    if isinstance(d, str):
        d = parse_date(d)
    return d.strftime("%a, %d %b %Y")


def fmt_time12(hhmm) -> str:
    if not hhmm:
        return ""
    return parse_hhmm(hhmm).strftime("%I:%M %p").lstrip("0")


def days_until(start: datetime, ref: datetime) -> int:
    return (start.date() - ref.date()).days


def add_minutes(dt: datetime, minutes: int) -> datetime:
    return dt + timedelta(minutes=minutes)

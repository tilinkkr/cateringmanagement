"""Background thread that runs the reminder cycle every minute (or immediately when woken)."""
import logging
import threading

from .db import connect
from .reminders import run_cycle
from .util import now

log = logging.getLogger("catering.scheduler")


class ReminderScheduler(threading.Thread):
    def __init__(self, db_path, interval=60):
        super().__init__(daemon=True, name="reminder-scheduler")
        self.db_path = db_path
        self.interval = interval
        self._halt = threading.Event()
        self._wake = threading.Event()
        self._lock = threading.Lock()
        self.last_run = None
        self.last_error = None

    def run(self):
        while not self._halt.is_set():
            self.tick()
            self._wake.wait(self.interval)
            self._wake.clear()

    def wake(self):
        """Run a cycle now (e.g. right after a booking is saved)."""
        self._wake.set()

    def tick(self):
        with self._lock:
            conn = connect(self.db_path)
            try:
                n = run_cycle(conn)
                if n:
                    log.info("Sent %s reminder(s)", n)
                self.last_error = None
            except Exception as e:  # keep the loop alive whatever happens
                log.exception("Reminder cycle failed")
                self.last_error = str(e)
            finally:
                conn.close()
                self.last_run = now()

    def stop(self):
        self._halt.set()
        self._wake.set()

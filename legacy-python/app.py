"""Catering Event Manager - start with:  python app.py   (then open http://localhost:5000)

Options:
  --port 5000         port to listen on
  --host 0.0.0.0      allow other computers / phones on the same Wi-Fi to open it
  --no-sample         first run without sample bookings
"""
import argparse
import logging
import os
import secrets
from datetime import timedelta

from flask import Flask, send_from_directory

BASE = os.path.dirname(os.path.abspath(__file__))


def load_env_file(path):
    """Minimal KEY=VALUE loader for config.env (WhatsApp credentials etc.)."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def _secret_key(data_dir):
    path = os.path.join(data_dir, "secret.key")
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write(secrets.token_hex(32))
    with open(path) as f:
        return f.read().strip()


def create_app(db_path=None, start_scheduler=True, seed=True):
    from catering.api import bp
    from catering.db import init_db
    from catering.scheduler import ReminderScheduler

    load_env_file(os.path.join(BASE, "config.env"))
    data_dir = os.path.join(BASE, "data")
    os.makedirs(data_dir, exist_ok=True)
    db_path = db_path or os.path.join(data_dir, "catering.db")
    init_db(db_path, seed=seed)

    app = Flask(__name__, static_folder=os.path.join(BASE, "static"), static_url_path="/static")
    app.config.update(DB_PATH=db_path, SECRET_KEY=_secret_key(data_dir),
                      PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
                      SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax",
                      JSON_AS_ASCII=False)
    app.json.ensure_ascii = False
    app.register_blueprint(bp)

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    @app.get("/board")
    def board_page():
        return send_from_directory(app.static_folder, "board.html")

    @app.after_request
    def no_cache_api(resp):
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "SAMEORIGIN"
        return resp

    if start_scheduler:
        sch = ReminderScheduler(db_path, interval=60)
        sch.start()
        app.config["SCHEDULER"] = sch
    return app


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=int(os.environ.get("PORT", 5000)))
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--no-sample", action="store_true")
    a = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    application = create_app(seed=not a.no_sample)
    print(f"\n  Catering Event Manager is running:  http://localhost:{a.port}")
    print(f"  Common view (kitchen screen):       http://localhost:{a.port}/board")
    print("  First login:  Owner / PIN 1234  (please change it in Settings)\n")
    application.run(host=a.host, port=a.port, debug=False, use_reloader=False, threaded=True)

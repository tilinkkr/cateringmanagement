"""WhatsApp sending adapters.

provider = "test"   -> nothing leaves the computer; messages are stored in the Outbox
                       and staff can tap "Open in WhatsApp" to send by hand.
provider = "meta"   -> Meta WhatsApp Cloud API   (env: WA_META_TOKEN, WA_META_PHONE_NUMBER_ID,
                                                  optional WA_META_TEMPLATE, WA_META_TEMPLATE_LANG)
provider = "twilio" -> Twilio WhatsApp API      (env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
                                                  TWILIO_WHATSAPP_FROM e.g. whatsapp:+14155238886)

Credentials are read from environment variables / config.env, never stored in the database.
"""
import base64
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass


@dataclass
class SendResult:
    ok: bool
    ref: str = ""
    error: str = ""


class TestSender:
    name = "test"

    def send(self, phone: str, text: str, params=None) -> SendResult:
        return SendResult(True, "TEST-" + uuid.uuid4().hex[:8])


def _post(url, data: bytes, headers: dict, timeout=20):
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


class MetaCloudSender:
    """Business-initiated messages need an approved template. Create a template with
    two body variables, e.g.  "Hello {{1}}, {{2}}"  and set WA_META_TEMPLATE to its name.
    Without a template, plain text is sent (works only inside the 24-hour customer window)."""
    name = "meta"

    def __init__(self):
        self.token = os.environ.get("WA_META_TOKEN", "")
        self.phone_id = os.environ.get("WA_META_PHONE_NUMBER_ID", "")
        self.template = os.environ.get("WA_META_TEMPLATE", "")
        self.lang = os.environ.get("WA_META_TEMPLATE_LANG", "en")
        self.version = os.environ.get("WA_META_API_VERSION", "v21.0")

    def send(self, phone, text, params=None) -> SendResult:
        if not (self.token and self.phone_id):
            return SendResult(False, error="Meta WhatsApp is not configured (see config.env)")
        to = phone.lstrip("+")
        if self.template:
            # Template variables may not contain new lines / tabs / 4+ spaces.
            name = (params or {}).get("name", "")
            flat = re.sub(r"\s{2,}", " ", text.replace("\n", " | "))[:1000]
            body = {"messaging_product": "whatsapp", "to": to, "type": "template",
                    "template": {"name": self.template, "language": {"code": self.lang},
                                 "components": [{"type": "body", "parameters": [
                                     {"type": "text", "text": name or "Customer"},
                                     {"type": "text", "text": flat}]}]}}
        else:
            body = {"messaging_product": "whatsapp", "to": to, "type": "text",
                    "text": {"preview_url": False, "body": text[:4000]}}
        url = f"https://graph.facebook.com/{self.version}/{self.phone_id}/messages"
        try:
            status, resp = _post(url, json.dumps(body).encode(),
                                 {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        except Exception as e:  # network down etc.
            return SendResult(False, error=f"Network error: {e}")
        if 200 <= status < 300:
            try:
                ref = json.loads(resp)["messages"][0]["id"]
            except Exception:
                ref = ""
            return SendResult(True, ref)
        return SendResult(False, error=f"HTTP {status}: {resp[:300]}")


class TwilioSender:
    name = "twilio"

    def __init__(self):
        self.sid = os.environ.get("TWILIO_ACCOUNT_SID", "")
        self.token = os.environ.get("TWILIO_AUTH_TOKEN", "")
        self.sender = os.environ.get("TWILIO_WHATSAPP_FROM", "")

    def send(self, phone, text, params=None) -> SendResult:
        if not (self.sid and self.token and self.sender):
            return SendResult(False, error="Twilio WhatsApp is not configured (see config.env)")
        url = f"https://api.twilio.com/2010-04-01/Accounts/{self.sid}/Messages.json"
        data = urllib.parse.urlencode({"From": self.sender, "To": f"whatsapp:{phone}", "Body": text[:1600]}).encode()
        auth = base64.b64encode(f"{self.sid}:{self.token}".encode()).decode()
        try:
            status, resp = _post(url, data, {"Authorization": f"Basic {auth}",
                                             "Content-Type": "application/x-www-form-urlencoded"})
        except Exception as e:
            return SendResult(False, error=f"Network error: {e}")
        if 200 <= status < 300:
            try:
                return SendResult(True, json.loads(resp).get("sid", ""))
            except Exception:
                return SendResult(True)
        return SendResult(False, error=f"HTTP {status}: {resp[:300]}")


def get_sender(provider: str):
    return {"meta": MetaCloudSender, "twilio": TwilioSender}.get(provider, TestSender)()


def wa_link(phone: str, text: str) -> str:
    """Click-to-chat link: opens WhatsApp with the message pre-filled (manual fallback)."""
    return f"https://wa.me/{phone.lstrip('+')}?text={urllib.parse.quote(text)}"

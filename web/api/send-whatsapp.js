// Vercel serverless function: POST /api/send-whatsapp  { to: "+9198...", text: "..." }
// Sends through the Meta WhatsApp Cloud API. Set these in Vercel → Project → Settings → Environment Variables:
//   WA_TOKEN         permanent access token
//   WA_PHONE_ID      WhatsApp phone number ID
//   WA_APP_KEY       any secret word; type the same word in the app's Settings → App key
//   WA_TEMPLATE      (optional) approved template name with 2 body variables {{1}} name, {{2}} message
//   WA_TEMPLATE_LANG (optional, default "en")
// Without WA_TOKEN / WA_PHONE_ID it answers 501, and the app falls back to one-tap sending.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { WA_TOKEN, WA_PHONE_ID, WA_APP_KEY, WA_TEMPLATE, WA_TEMPLATE_LANG } = process.env;
  if (!WA_TOKEN || !WA_PHONE_ID) return res.status(501).json({ error: 'WhatsApp is not connected yet' });
  if (!WA_APP_KEY || req.headers['x-app-key'] !== WA_APP_KEY) return res.status(401).json({ error: 'Wrong app key (Settings → App key)' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const to = String(body.to || '').replace(/\D/g, '');
  const text = String(body.text || '').slice(0, 4000);
  if (to.length < 11 || !text) return res.status(400).json({ error: 'Missing number or text' });
  const payload = WA_TEMPLATE
    ? { messaging_product: 'whatsapp', to, type: 'template', template: { name: WA_TEMPLATE, language: { code: WA_TEMPLATE_LANG || 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: (text.match(/Hello (.+),/) || [])[1] || 'Customer' },
          { type: 'text', text: text.replace(/\n+/g, ' | ').replace(/\s{2,}/g, ' ').slice(0, 1000) }] }] } }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } };
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: out.error?.message || `WhatsApp error ${r.status}` });
    return res.status(200).json({ ok: true, id: out.messages?.[0]?.id });
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach WhatsApp: ' + e.message });
  }
};

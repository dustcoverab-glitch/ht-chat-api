@@ -5,22 +5,18 @@ const supabase = createClient(
  process.env.SUPABASE_SERVICE_KEY
);

// Samma origins som du kör i chat.js
const ALLOWED_ORIGINS = new Set([
  "https://www.htytrengoring.se",
  "https://htytrengoring.se",
]);

function setCors(req, res) {
  const origin = req.headers.origin;

  if (origin && (ALLOWED_ORIGINS.has(origin) || origin.endsWith(".squarespace.com"))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // om du vill vara strikt senare: sätt till din domän istället för *
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
@@ -33,13 +29,34 @@ function esc(s) {
    .replaceAll(">", "&gt;");
}

/* ── Validation helpers ──────────────────────────────────────────────── */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Normaliserar svenska telefonnummer till +46XXXXXXXXX.
 * Accepterar: 070-123 45 67, 0046701234567, +46701234567, 08-123 456 m.m.
 * Returnerar null om formatet är ogiltigt.
 */
function normalisePhone(raw) {
  let p = raw.replace(/[\s\-().]/g, "");
  if (p.startsWith("0046")) p = "+46" + p.slice(4);
  else if (p.startsWith("46") && p.length >= 11) p = "+" + p;
  else if (p.startsWith("0")) p = "+46" + p.slice(1);
  if (!/^\+46\d{7,10}$/.test(p)) return null;
  return p;
}

/* ── E-post till Resend ──────────────────────────────────────────────── */
async function sendLeadEmail(data) {
  if (!process.env.RESEND_API_KEY) throw new Error("Missing RESEND_API_KEY");
  if (!process.env.LEADS_TO_EMAIL) throw new Error("Missing LEADS_TO_EMAIL");
  if (!process.env.LEADS_FROM_EMAIL) throw new Error("Missing LEADS_FROM_EMAIL");

  const html = `
    <h2>Ny lead från chatten</h2>
    <p><strong>Namn:</strong> ${esc(data.name || "-")}</p>
    <p><strong>Telefon:</strong> ${esc(data.phone || "-")}</p>
    <p><strong>Email:</strong> ${esc(data.email || "-")}</p>
    <p><strong>Adress:</strong> ${esc(data.address || "-")}</p>
@@ -48,20 +65,21 @@ async function sendLeadEmail(data) {
    <p><strong>Meddelande:</strong><br>${esc(data.message || "-").replaceAll("\n", "<br>")}</p>
    <hr>
    <p><strong>Session:</strong> ${esc(data.sessionId)}</p>
    <p><strong>Sida:</strong> ${esc(data.pageUrl || "-")}</p>
  `;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.LEADS_FROM_EMAIL,
      to: process.env.LEADS_TO_EMAIL,
      subject: "Ny lead från HT Chatbot",
      html
    })
      html,
    }),
  });

  if (!response.ok) {
@@ -72,9 +90,9 @@ async function sendLeadEmail(data) {
  return true;
}

/* ── Handler ─────────────────────────────────────────────────────────── */
export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

@@ -91,62 +109,101 @@ export default async function handler(req, res) {
      address,
      city,
      service_interest,
      message
      message,
      pageUrl,
      userAgent,
    } = req.body || {};

    const sid = String(sessionId || "").trim();
    const p = String(phone || "").trim();
    const rawPhone = String(phone || "").trim();

    /* ── 1. Obligatoriska fält ───────────────────────────────────────── */
    if (!sid || !rawPhone) {
      return res.status(400).json({ error: "Telefonnummer krävs." });
    }

    if (!sid || !p) {
      return res.status(400).json({ error: "Missing required fields (sessionId, phone)" });
    /* ── 2. Telefon-validering ───────────────────────────────────────── */
    const normPhone = normalisePhone(rawPhone);
    if (!normPhone) {
      return res.status(400).json({
        error: "Ogiltigt telefonnummer. Ange ett svenskt nummer, t.ex. 070-123 45 67.",
      });
    }

    /* ── 3. E-post-validering (om angiven) ───────────────────────────── */
    if (email && !isValidEmail(String(email).trim())) {
      return res.status(400).json({ error: "Ogiltig e-postadress." });
    }

    const { data: inserted, error } = await supabase
    /* ── 4. Dubblettskydd – samma normaliserat nummer inom 24 h ──────── */
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: existing, error: dupErr } = await supabase
      .from("leads")
      .select("id")
      .eq("phone", normPhone)
      .gte("locked_at", since)
      .limit(1);

    if (!dupErr && existing?.length > 0) {
      return res.status(409).json({
        error: "Vi har redan tagit emot din förfrågan. Vi hör av oss inom kort! 😊",
        duplicate: true,
      });
    }

    /* ── 5. Spara lead ───────────────────────────────────────────────── */
    const now = new Date().toISOString();

    const { data: inserted, error: insertErr } = await supabase
      .from("leads")
      .insert({
        session_id: sid,
        name: name ? String(name).trim() : null,
        phone: p,
        email: email ? String(email).trim() : null,
        address: address ? String(address).trim() : null,
        city: city ? String(city).trim() : null,
        session_id:       sid,
        name:             name    ? String(name).trim()    : null,
        phone:            normPhone,
        email:            email   ? String(email).trim()   : null,
        address:          address ? String(address).trim() : null,
        city:             city    ? String(city).trim()    : null,
        service_interest: service_interest ? String(service_interest).trim() : null,
        message: message ? String(message).trim() : null,
        locked_at: new Date().toISOString()
        message:          message ? String(message).trim() : null,
        page_url:         pageUrl    || null,
        user_agent:       userAgent  || null,
        locked_at:        now,
      })
      .select("id")
      .single();

    if (error) {
      console.error(error);
    if (insertErr) {
      console.error("Insert error:", insertErr);
      return res.status(500).json({ error: "Database error" });
    }

    /* ── 6. Skicka e-post via Resend ─────────────────────────────────── */
    try {
      await sendLeadEmail({
        sessionId: sid,
        name,
        phone: p,
        phone: normPhone,
        email,
        address,
        city,
        service_interest,
        message
        message,
        pageUrl,
      });

      await supabase
        .from("leads")
        .update({ notified_at: new Date().toISOString() })
        .update({ notified_at: now })
        .eq("id", inserted.id);

    } catch (mailErr) {
      console.error(mailErr);
      console.error("Email error:", mailErr);
      return res.status(200).json({ success: true, warned: "Email failed, lead saved" });
    }

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error(e);
    console.error("Lead error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}

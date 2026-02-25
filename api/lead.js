import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
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
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function sendLeadEmail(data) {
  if (!process.env.RESEND_API_KEY) throw new Error("Missing RESEND_API_KEY");
  if (!process.env.LEADS_TO_EMAIL) throw new Error("Missing LEADS_TO_EMAIL");
  if (!process.env.LEADS_FROM_EMAIL) throw new Error("Missing LEADS_FROM_EMAIL");

  const html = `
    <h2>Ny lead från chatten</h2>
    <p><strong>Telefon:</strong> ${esc(data.phone || "-")}</p>
    <p><strong>Email:</strong> ${esc(data.email || "-")}</p>
    <p><strong>Adress:</strong> ${esc(data.address || "-")}</p>
    <p><strong>Ort:</strong> ${esc(data.city || "-")}</p>
    <p><strong>Tjänst:</strong> ${esc(data.service_interest || "-")}</p>
    <p><strong>Meddelande:</strong><br>${esc(data.message || "-").replaceAll("\n", "<br>")}</p>
    <hr>
    <p><strong>Session:</strong> ${esc(data.sessionId)}</p>
  `;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: process.env.LEADS_FROM_EMAIL,
      to: process.env.LEADS_TO_EMAIL,
      subject: "Ny lead från HT Chatbot",
      html
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Resend error: ${response.status} ${text}`);
  }

  return true;
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: "Missing Supabase env vars" });
    }

    const {
      sessionId,
      name,
      phone,
      email,
      address,
      city,
      service_interest,
      message
    } = req.body || {};

    const sid = String(sessionId || "").trim();
    const p = String(phone || "").trim();

    if (!sid || !p) {
      return res.status(400).json({ error: "Missing required fields (sessionId, phone)" });
    }

    const { data: inserted, error } = await supabase
      .from("leads")
      .insert({
        session_id: sid,
        name: name ? String(name).trim() : null,
        phone: p,
        email: email ? String(email).trim() : null,
        address: address ? String(address).trim() : null,
        city: city ? String(city).trim() : null,
        service_interest: service_interest ? String(service_interest).trim() : null,
        message: message ? String(message).trim() : null,
        locked_at: new Date().toISOString()
      })
      .select("id")
      .single();

    if (error) {
      console.error(error);
      return res.status(500).json({ error: "Database error" });
    }

    try {
      await sendLeadEmail({
        sessionId: sid,
        name,
        phone: p,
        email,
        address,
        city,
        service_interest,
        message
      });

      await supabase
        .from("leads")
        .update({ notified_at: new Date().toISOString() })
        .eq("id", inserted.id);

    } catch (mailErr) {
      console.error(mailErr);
      return res.status(200).json({ success: true, warned: "Email failed, lead saved" });
    }

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}

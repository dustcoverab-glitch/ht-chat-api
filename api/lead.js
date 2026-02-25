import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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
    <p style="color:#555;font-size:12px;">Skickat från HT:s chattbot</p>
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

    // 1) Save lead
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

    // 2) Send email
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

      // Mark notified
      await supabase
        .from("leads")
        .update({ notified_at: new Date().toISOString() })
        .eq("id", inserted.id);

    } catch (mailErr) {
      // Email failed but lead saved, still return success
      console.error(mailErr);
      return res.status(200).json({ success: true, warned: "Email failed, lead saved" });
    }

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}

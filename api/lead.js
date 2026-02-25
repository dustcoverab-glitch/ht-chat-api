import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function sendLeadEmail(data) {
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
      html: `
        <h2>Ny lead från chatten</h2>
        <p><strong>Namn:</strong> ${data.name || "-"}</p>
        <p><strong>Telefon:</strong> ${data.phone || "-"}</p>
        <p><strong>Email:</strong> ${data.email || "-"}</p>
        <p><strong>Adress:</strong> ${data.address || "-"}</p>
        <p><strong>Ort:</strong> ${data.city || "-"}</p>
        <p><strong>Tjänst:</strong> ${data.service_interest || "-"}</p>
        <p><strong>Session:</strong> ${data.sessionId}</p>
      `
    })
  });

  return response.ok;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      sessionId,
      name,
      phone,
      email,
      address,
      city,
      service_interest
    } = req.body || {};

    if (!sessionId || !phone) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { error } = await supabase.from("leads").insert({
      session_id: sessionId,
      name,
      phone,
      email,
      address,
      city,
      service_interest,
      locked_at: new Date().toISOString()
    });

    if (error) {
      console.error(error);
      return res.status(500).json({ error: "Database error" });
    }

    await sendLeadEmail({
      sessionId,
      name,
      phone,
      email,
      address,
      city,
      service_interest
    });

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}

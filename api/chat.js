import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ALLOWED_ORIGINS = new Set([
  "https://www.htytrengoring.se",
  "https://htytrengoring.se",
]);

/* ======== HEMSIDA LÄNK-KATALOG ======== */

const SITE_LINKS = [
  {
    key: "stentvatt",
    label: "Om stentvätt",
    url: "https://www.htytrengoring.se/stentvatt"
  },
  {
    key: "asfalt",
    label: "Asfaltsförsegling",
    url: "https://www.htytrengoring.se/asfalt"
  },
  {
    key: "kontakt",
    label: "Kontakt",
    url: "https://www.htytrengoring.se/kontakt"
  },
  {
    key: "bokning",
    label: "Boka provtvätt",
    url: "https://www.bokadirekt.se/places/ht-ytrengoring-ab-58864"
  }
];

/* ======== CORS ======== */

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.has(origin) || origin.endsWith(".squarespace.com"))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash("sha256").update(ip).digest("hex");
}

/* ======== MAIN HANDLER ======== */

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    if (!process.env.OPENAI_API_KEY)
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)
      return res.status(500).json({ error: "Missing Supabase env vars" });

    const { text, history, sessionId, pageUrl, userAgent } = req.body || {};
    const userText = String(text || "").trim();
    const sid = String(sessionId || "").trim();

    if (!userText) return res.status(400).json({ error: "Missing text" });
    if (!sid) return res.status(400).json({ error: "Missing sessionId" });

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      null;

    /* ======== LOG SESSION ======== */

    await supabase.from("chat_sessions").upsert({
      id: sid,
      ip_hash: hashIp(ip),
      user_agent: userAgent || null,
      page_url: pageUrl || null
    });

    await supabase.from("chat_messages").insert({
      session_id: sid,
      role: "user",
      content: userText
    });

    /* ======== SYSTEM PROMPT ======== */

    const systemPrompt = `
Du är HT Ytrengörings chattassistent.

Regler:
- Svara på svenska, naturligt och hjälpsamt.
- Utgå alltid från kontexten i konversationen.
- Börja aldrig om med “Hej! Vad vill du ha hjälp med?” efter att konversationen startat.
- Om kunden säger “ja”, “ja tack” eller liknande: tolka det som svar på din senaste fråga.

Säljlogik:
- Vid rena informationsfrågor: svara sakligt utan att pusha.
- Vid tydlig köpintention (offert/boka/komma ut/pris för deras yta): bli mer säljig och föreslå gratis provtvätt/uppmätning.
- När kunden är redo att bli kontaktad: lägg längst ner exakt: [TRIGGER_LEAD_FORM]

Länkar:
- När du hänvisar till en sida: lägg längst ner exakt en av:
[SHOW_LINK:stentvatt] [SHOW_LINK:asfalt] [SHOW_LINK:kontakt] [SHOW_LINK:bokning]
Skriv aldrig något om taggarna.
`;
    const messages = [
      { role: "system", content: systemPrompt },
      ...(Array.isArray(history) ? history.slice(-10) : []),
      { role: "user", content: userText }
    ];

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: messages,
      max_output_tokens: 300
    });

    let reply = "";
    const out = response.output || [];

    for (const item of out) {
      for (const c of (item.content || [])) {
        if (c.type === "output_text" && typeof c.text === "string")
          reply += c.text;
      }
    }

    reply = reply.trim() || "Vi hjälper gärna. Kan du berätta lite mer?";

    /* ======== TAG DETECTION ======== */

    let triggerLeadForm = false;
    let buttons = [];

    if (reply.includes("[TRIGGER_LEAD_FORM]")) {
      triggerLeadForm = true;
      reply = reply.replace("[TRIGGER_LEAD_FORM]", "").trim();
    }

    const linkMatch = reply.match(/\[SHOW_LINK:(.*?)\]/);
    if (linkMatch) {
      const key = linkMatch[1];
      const linkObj = SITE_LINKS.find(l => l.key === key);
      if (linkObj) {
        buttons.push({
          label: linkObj.label,
          url: linkObj.url
        });
      }
      reply = reply.replace(/\[SHOW_LINK:(.*?)\]/, "").trim();
    }

    /* ======== LOG BOT MESSAGE ======== */

    await supabase.from("chat_messages").insert({
      session_id: sid,
      role: "assistant",
      content: reply
    });

    return res.status(200).json({
      reply,
      triggerLeadForm,
      buttons
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}

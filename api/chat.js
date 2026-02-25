import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ALLOWED_ORIGINS = new Set([
  "https://www.htytrengoring.se",
  "https://htytrengoring.se",
]);

const SITE_LINKS = [
  { key: "stentvatt", label: "Om stentvätt", url: "https://www.htytrengoring.se/stentvatt" },
  { key: "asfalt", label: "Asfaltsförsegling", url: "https://www.htytrengoring.se/asfalt" },
  { key: "kontakt", label: "Kontakt", url: "https://www.htytrengoring.se/kontakt" },
  { key: "bokning", label: "Boka provtvätt", url: "https://www.bokadirekt.se/places/ht-ytrengoring-ab-58864" },
];

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

function normalizeRole(r) {
  if (r === "assistant") return "assistant";
  return "user";
}

function looksLikeRestart(text) {
  const t = (text || "").trim().toLowerCase();
  return (
    t.startsWith("hej!") ||
    t.startsWith("hej.") ||
    t.startsWith("hej ") ||
    t.startsWith("vad kan jag hjälpa") ||
    t.startsWith("hur kan jag hjälpa") ||
    t.startsWith("vad vill du ha hjälp")
  );
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: "Missing Supabase env vars" });
    }

    const { text, sessionId, pageUrl, userAgent } = req.body || {};
    const userText = String(text || "").trim();
    const sid = String(sessionId || "").trim();

    if (!userText) return res.status(400).json({ error: "Missing text" });
    if (!sid) return res.status(400).json({ error: "Missing sessionId" });

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      null;

    // 1) Upsert session
    await supabase.from("chat_sessions").upsert({
      id: sid,
      ip_hash: hashIp(ip),
      user_agent: userAgent || null,
      page_url: pageUrl || null
    });

    // 2) Log user message first (so DB always has the latest)
    await supabase.from("chat_messages").insert({
      session_id: sid,
      role: "user",
      content: userText
    });

    // 3) Fetch stable history from DB (fix for “tappar tråden”)
    const { data: rows, error: histErr } = await supabase
      .from("chat_messages")
      .select("role, content, created_at")
      .eq("session_id", sid)
      .order("created_at", { ascending: false })
      .limit(16);

    if (histErr) console.error(histErr);

    const dbHistory = (rows || [])
      .reverse()
      .map(r => ({
        role: normalizeRole(r.role),
        content: String(r.content || "")
      }));

    const systemPrompt = `
Du är HT Ytrengörings chattassistent.

Viktigaste regeln:
- Du får aldrig starta om konversationen. Ingen ny “Hej! Vad vill du ha hjälp med?” efter att chatten redan pågår.

Tolkning:
- Om kunden skriver “ja”, “ja tack”, “ok”, “kör”, tolka det som svar på din senaste fråga och fortsätt därifrån.

Beteende:
- Vid rena frågor: svara sakligt och hjälpsamt, inte säljigt.
- Vid tydlig köpintention (offert, boka, att ni ska komma ut, pris för deras specifika yta): bli mer säljig och styr mot gratis provtvätt/uppmätning.

Lead:
- När kunden är redo att bli kontaktad (t ex tackar ja till bokning/offert eller ber er komma ut):
lägg längst ner exakt: [TRIGGER_LEAD_FORM]

Länkar:
- Om du hänvisar till en sida, lägg längst ner exakt en tagg:
[SHOW_LINK:stentvatt] eller [SHOW_LINK:asfalt] eller [SHOW_LINK:kontakt] eller [SHOW_LINK:bokning]
Skriv aldrig om taggarna.
`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...dbHistory,
      { role: "user", content: userText }
    ];

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: messages,
      max_output_tokens: 320
    });

    let reply = "";
    const out = response.output || [];
    for (const item of out) {
      for (const c of (item.content || [])) {
        if (c.type === "output_text" && typeof c.text === "string") reply += c.text;
      }
    }

    reply = reply.trim() || "Vi hjälper gärna. Kan du berätta lite mer?";

    // Guard: if model still tries to restart, force it to continue instead
    if (dbHistory.length >= 4 && looksLikeRestart(reply)) {
      reply = "Toppen. För att gå vidare: vilken ort gäller det och ungefär hur stor yta handlar det om?";
    }

    // Tag detection
    let triggerLeadForm = false;
    let buttons = [];

    if (reply.includes("[TRIGGER_LEAD_FORM]")) {
      triggerLeadForm = true;
      reply = reply.replace("[TRIGGER_LEAD_FORM]", "").trim();
    }

    // Extra: if customer says yes after we talked about booking/offert, trigger anyway
    const lastFew = dbHistory.slice(-6).map(m => (m.content || "").toLowerCase()).join(" ");
    const userYes = /^(ja|ja tack|yes|ok|okej|kör|absolut|gör det)\b/i.test(userText);
    const contextBooking = /boka|offert|provtvätt|uppmätning|komma ut/i.test(lastFew);
    if (userYes && contextBooking) triggerLeadForm = true;

    const linkMatch = reply.match(/\[SHOW_LINK:(.*?)\]/);
    if (linkMatch) {
      const key = linkMatch[1];
      const linkObj = SITE_LINKS.find(l => l.key === key);
      if (linkObj) buttons.push({ label: linkObj.label, url: linkObj.url });
      reply = reply.replace(/\[SHOW_LINK:(.*?)\]/, "").trim();
    }

    // 4) Log assistant reply
    await supabase.from("chat_messages").insert({
      session_id: sid,
      role: "assistant",
      content: reply
    });

    return res.status(200).json({ reply, triggerLeadForm, buttons });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}

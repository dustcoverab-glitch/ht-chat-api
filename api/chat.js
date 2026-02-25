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
  return r === "assistant" ? "assistant" : "user";
}

function looksLikeRestart(text) {
  const t = (text || "").trim().toLowerCase();
  return (
    t.startsWith("hej!") ||
    t.startsWith("hej ") ||
    t.startsWith("vad kan jag hjälpa") ||
    t.startsWith("hur kan jag hjälpa") ||
    t.startsWith("vad vill du ha hjälp")
  );
}

function stripTags(text) {
  return String(text || "")
    .replace(/\[TRIGGER_LEAD_FORM\]/g, "")
    .replace(/\[SHOW_LINK:.*?\]/g, "")
    .trim();
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

    // 2) Log user message
    await supabase.from("chat_messages").insert({
      session_id: sid,
      role: "user",
      content: userText
    });

    // 3) Fetch stable history from DB
    const { data: rows, error: histErr } = await supabase
      .from("chat_messages")
      .select("role, content, created_at")
      .eq("session_id", sid)
      .order("created_at", { ascending: false })
      .limit(18);

    if (histErr) console.error(histErr);

    const dbHistory = (rows || [])
      .reverse()
      .map(r => ({ role: normalizeRole(r.role), content: String(r.content || "") }));

    // Create a short recent context string for failsafe checks
    const recentContext = dbHistory.slice(-8).map(m => (m.content || "").toLowerCase()).join(" ");

    const systemPrompt = `
Du är HT Ytrengörings chattassistent.

Hårdregel (viktigast):
- Starta ALDRIG om konversationen. Skriv inte “Hej! Vad vill du ha hjälp med?” när chatten redan pågår.

Tolkning:
- Om kunden skriver “ja”, “ja tack”, “ok”, “okej”, “kör”, “absolut”: tolka det som svar på din senaste fråga och fortsätt.

Kontaktuppgifter (superviktigt):
- Du får INTE be kunden skriva in alla kontaktuppgifter i fri text.
- När du behöver telefon, e-post, adress eller vill boka uppmätning/provtvätt/offert:
  1) Säg att du öppnar formuläret i chatten.
  2) Lägg längst ner exakt: [TRIGGER_LEAD_FORM]
- Du får inte skriva en numrerad lista med “1. Namn 2. Adress 3. Telefon ...”.

Beteende:
- Vid rena informationsfrågor: svara sakligt och hjälpsamt, inte påträngande.
- Vid tydlig köpintention (offert, boka, uppmätning, provtvätt, att ni ska komma ut, pris för deras yta): bli mer säljig och styr mot gratis provtvätt/uppmätning.

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
      max_output_tokens: 340
    });

    let raw = "";
    const out = response.output || [];
    for (const item of out) {
      for (const c of (item.content || [])) {
        if (c.type === "output_text" && typeof c.text === "string") raw += c.text;
      }
    }

    raw = raw.trim() || "Vi hjälper gärna. Vad gäller det för typ av yta och ungefär hur stor är den?";

    // 4) Detect tags before stripping
    let triggerLeadForm = raw.includes("[TRIGGER_LEAD_FORM]");
    let buttons = [];

    const linkMatch = raw.match(/\[SHOW_LINK:(.*?)\]/);
    if (linkMatch) {
      const key = linkMatch[1];
      const linkObj = SITE_LINKS.find(l => l.key === key);
      if (linkObj) buttons.push({ label: linkObj.label, url: linkObj.url });
    }

    let reply = stripTags(raw);

    // 5) Guard: if model tries to restart mid-chat, force a continuation question
    if (dbHistory.length >= 4 && looksLikeRestart(reply)) {
      reply = "Toppen. För att gå vidare: vilken ort gäller det och ungefär hur stor yta handlar det om?";
    }

    // 6) Failsafes that force the lead form when it’s clearly needed
    const uLower = userText.toLowerCase();
    const rLower = reply.toLowerCase();

    const userAsksForForm =
      uLower.includes("formulär") ||
      uLower.includes("fylla i") ||
      uLower.includes("här i chatten") ||
      uLower.includes("lämna uppgifter");

    const bookingIntentByUser =
      uLower.includes("offert") ||
      uLower.includes("boka") ||
      uLower.includes("uppmätning") ||
      uLower.includes("mätning") ||
      uLower.includes("provtvätt") ||
      uLower.includes("komma ut");

    const yesWords = /^(ja|ja tack|yes|ok|okej|kör|absolut|gör det)\b/i.test(userText);
    const contextBooking = /boka|offert|uppmätning|provtvätt|komma ut/i.test(recentContext);

    // If user says yes and we recently discussed booking/offert -> show form
    if (!triggerLeadForm && yesWords && contextBooking) triggerLeadForm = true;

    // If user asks for form explicitly -> show it
    if (!triggerLeadForm && userAsksForForm) triggerLeadForm = true;

    // If user expresses booking intent strongly -> show it
    if (!triggerLeadForm && bookingIntentByUser && (uLower.includes("vill") || uLower.includes("intresserad") || yesWords)) {
      triggerLeadForm = true;
    }

    // If assistant accidentally asks for contact details in text -> show it
    const asksForContactDetails =
      rLower.includes("telefon") ||
      rLower.includes("e-post") ||
      rLower.includes("email") ||
      rLower.includes("mejl") ||
      rLower.includes("adress") ||
      (rLower.includes("datum") && rLower.includes("tid"));

    const bookingLanguage =
      rLower.includes("boka") ||
      rLower.includes("uppmätning") ||
      rLower.includes("provtvätt") ||
      rLower.includes("offert") ||
      rLower.includes("återkopplar") ||
      rLower.includes("återkommer");

    if (!triggerLeadForm && asksForContactDetails && bookingLanguage) triggerLeadForm = true;

    // If form is triggered, ensure reply explains it (and does NOT ask for all data)
    if (triggerLeadForm) {
      reply = "Toppen! Jag öppnar ett formulär här i chatten så vi får dina uppgifter samlat. Då kontaktar vi dig inom 24 timmar.";
    }

    // 7) Log assistant message
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

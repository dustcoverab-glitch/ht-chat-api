import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

/**
 * HT Ytrengöring – Chat API
 *
 * Goals:
 * - Crisp, non-fluffy answers (no guessing)
 * - Balanced: customer support + lead generation
 * - Robust session history (Supabase)
 * - Safe lead capture via embedded form trigger tag
 *
 * Key mechanics:
 * - The model may output special tags:
 *    [TRIGGER_LEAD_FORM]
 *    [SHOW_LINK:stentvatt|asfalt|kontakt|bokning]
 * - We strip tags from the visible reply, but use them to:
 *    - trigger a lead form in UI
 *    - show a single contextual button link
 */

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
    // If you want stricter CORS, replace "*" with a safe default.
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

/**
 * The bot must not "restart" the conversation mid-thread.
 * This heuristic catches a few common restart greetings.
 */
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

/**
 * Extract one SHOW_LINK tag if present.
 * We intentionally only support a single button.
 */
function extractLinkKey(raw) {
  const m = String(raw || "").match(/\[SHOW_LINK:(.*?)\]/);
  return m ? m[1] : null;
}

/**
 * Basic utility: avoid accidental empty responses.
 */
function fallbackReply() {
  return "För att hjälpa dig snabbt: gäller det stentvätt eller asfalt, vilken ort är det och ungefär hur stor yta handlar det om?";
}

/**
 * Detect whether user intent is strong booking/offert intent.
 */
function hasBookingIntent(userText) {
  const u = String(userText || "").toLowerCase();
  return (
    u.includes("offert") ||
    u.includes("boka") ||
    u.includes("uppmätning") ||
    u.includes("mätning") ||
    u.includes("provtvätt") ||
    u.includes("komma ut") ||
    u.includes("besiktning") ||
    u.includes("pris för min") ||
    u.includes("vad kostar för min") ||
    u.includes("kan ni komma")
  );
}

/**
 * Detect if user explicitly asks to submit details / wants a form.
 */
function userAsksForForm(userText) {
  const u = String(userText || "").toLowerCase();
  return (
    u.includes("formulär") ||
    u.includes("fylla i") ||
    u.includes("här i chatten") ||
    u.includes("lämna uppgifter") ||
    u.includes("kontaktuppgifter") ||
    u.includes("skicka mina uppgifter")
  );
}

/**
 * Detect "yes" replies that should continue prior booking context.
 */
function isYesWord(userText) {
  return /^(ja|ja tack|yes|ok|okej|kör|absolut|gör det|kör på|stämmer)\b/i.test(String(userText || "").trim());
}

/**
 * Conservative detection if the assistant is asking for contact details in plain text.
 * We use regex to reduce false positives.
 */
function assistantAsksForContactDetails(reply) {
  const r = String(reply || "");
  return /\b(telefon|e-?post|email|mejl|adress)\b/i.test(r.toLowerCase());
}

/**
 * Detect if assistant is "in booking mode" language-wise.
 */
function assistantUsesBookingLanguage(reply) {
  const r = String(reply || "");
  return /\b(boka|uppmätning|provtvätt|offert|återkopplar|återkommer|kontaktar dig)\b/i.test(r.toLowerCase());
}

/**
 * Some claims are inherently risky without a verified knowledge base:
 * - exact prices (e.g., "1 999 kr")
 * - ROT, guarantees, "always/never"
 * - exact time windows
 * If we see these patterns, we gently steer toward asking for context.
 */
function containsRiskyClaims(reply) {
  const r = String(reply || "").toLowerCase();
  const money = /\b\d{2,6}\s*(kr|sek)\b/.test(r) || /\b\d{1,3}\s*(kr|sek)\s*\/\s*(kvm|m2)\b/.test(r);
  const absolutes = /\b(alltid|aldrig|100%|garanti|rot|rutm|r?ut|exakt)\b/.test(r);
  const exactTimes = /\b(idag|imorgon|på måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag)\b/.test(r) && /\bkl\.?\s*\d{1,2}(:\d{2})?\b/.test(r);
  return money || absolutes || exactTimes;
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // Env guards
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: "Missing Supabase env vars" });
    }

    // Parse request
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
      page_url: pageUrl || null,
    });

    // 2) Log user message
    await supabase.from("chat_messages").insert({
      session_id: sid,
      role: "user",
      content: userText,
    });

    // 3) Fetch stable history from DB
    // Increase history a bit for better continuity, but keep it bounded.
    const { data: rows, error: histErr } = await supabase
      .from("chat_messages")
      .select("role, content, created_at")
      .eq("session_id", sid)
      .order("created_at", { ascending: false })
      .limit(24);

    if (histErr) console.error(histErr);

    const dbHistory = (rows || [])
      .reverse()
      .map((r) => ({ role: normalizeRole(r.role), content: String(r.content || "") }));

    // A short recent context string for intent/failsafe checks
    const recentContext = dbHistory
      .slice(-10)
      .map((m) => (m.content || "").toLowerCase())
      .join(" ");

    /**
     * System prompt:
     * - Forces short, concrete answers
     * - Prevents guessing (anti-hallucination)
     * - Forces ONE follow-up question
     * - Balances support + lead conversion
     * - Enforces lead form capture flow
     */
    const systemPrompt = `
Du är HT Ytrengörings chattassistent på hemsidan. Du är både kundtjänst och leadmaskin.

Mål:
- Hjälp kunden snabbt och korrekt.
- Få in rätt lead när det finns köpintention.

Formatkrav (viktigast):
- Svara kort, konkret och utan flum. Max 5 meningar.
- Ställ exakt 1 följdfråga som tar oss närmare offert/bokning.
- Undvik långa listor. Max 3 punkter om du måste.

Sanning och kvalitet:
- Hitta aldrig på fakta. Om du inte vet: skriv "Jag vill inte gissa" och fråga efter underlag.
- Om kunden frågar om pris och du saknar exakt prislista: ge ett rimligt spann och säg vad som påverkar priset (yta, påväxt, åtkomst, fog, impregnering).
- Om kunden frågar om ROT/skattereduktion och du inte är säker: säg att du vill kontrollera upplägget och erbjud uppmätning/provtvätt.

Beteende (balans):
- Vid informationsfrågor: svara sakligt och ställ 1 mjuk följdfråga.
- Vid köpintention (offert, boka, uppmätning, provtvätt, pris för deras yta): bli tydligare, sammanfatta nästa steg och styr mot formulär.

Hårdregel:
- Starta ALDRIG om konversationen. Skriv inte "Hej! Vad vill du ha hjälp med?" när chatten redan pågår.
- Om kunden skriver "ja", "ja tack", "ok", "okej", "kör", "absolut": tolka det som svar på din senaste fråga och fortsätt.

Kontaktuppgifter (superviktigt):
- Du får INTE be kunden skriva kontaktuppgifter i fri text.
- När du behöver telefon, e-post, adress eller vill boka uppmätning/provtvätt/offert:
  1) Säg att du öppnar formuläret i chatten.
  2) Lägg längst ner exakt: [TRIGGER_LEAD_FORM]
- Skriv aldrig en lista på namn/adress/telefon.

Länkar:
- Om du hänvisar till en sida, lägg längst ner exakt en tagg:
[SHOW_LINK:stentvatt] eller [SHOW_LINK:asfalt] eller [SHOW_LINK:kontakt] eller [SHOW_LINK:bokning]
Skriv aldrig om taggarna.
`.trim();

    const messages = [
      { role: "system", content: systemPrompt },
      ...dbHistory,
      { role: "user", content: userText },
    ];

    // 4) Model call
    // If you want higher accuracy at higher cost, switch to "gpt-4.1".
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: messages,
      max_output_tokens: 240, // lower = less fluff
    });

    // 5) Collect raw output text
    let raw = "";
    const out = response.output || [];
    for (const item of out) {
      for (const c of item.content || []) {
        if (c.type === "output_text" && typeof c.text === "string") raw += c.text;
      }
    }
    raw = raw.trim();

    if (!raw) raw = fallbackReply();

    // 6) Parse tags
    let triggerLeadForm = raw.includes("[TRIGGER_LEAD_FORM]");
    const linkKey = extractLinkKey(raw);

    const buttons = [];
    if (linkKey) {
      const linkObj = SITE_LINKS.find((l) => l.key === linkKey);
      if (linkObj) buttons.push({ label: linkObj.label, url: linkObj.url });
    }

    // Visible reply (no tags)
    let reply = stripTags(raw);
    if (!reply) reply = fallbackReply();

    // 7) Guard: block restarts mid-conversation
    if (dbHistory.length >= 4 && looksLikeRestart(reply)) {
      reply = "För att ta det vidare: gäller det stentvätt eller asfalt, vilken ort är det och ungefär hur stor yta handlar det om?";
    }

    // 8) Failsafes for lead form triggering
    const uLower = userText.toLowerCase();
    const contextBooking = /\b(boka|offert|uppmätning|provtvätt|komma ut)\b/i.test(recentContext);

    // A) User says yes + recent booking context => trigger form
    if (!triggerLeadForm && isYesWord(userText) && contextBooking) triggerLeadForm = true;

    // B) User explicitly wants form / submit details => trigger form
    if (!triggerLeadForm && userAsksForForm(userText)) triggerLeadForm = true;

    // C) Strong booking intent => trigger form
    if (!triggerLeadForm && hasBookingIntent(userText)) {
      // If user intent is present, trigger form more readily
      triggerLeadForm = true;
    }

    // D) If assistant accidentally asks for contact details in text while in booking language => trigger form
    // This prevents the bot from collecting details via free text.
    if (!triggerLeadForm && assistantAsksForContactDetails(reply) && assistantUsesBookingLanguage(reply)) {
      triggerLeadForm = true;
    }

    // 9) If form triggers: DO NOT replace the entire reply.
    // Add a short CTA at the end only.
    if (triggerLeadForm) {
      const cta = "Jag öppnar ett formulär här i chatten så vi får uppgifterna samlat, så återkopplar vi snabbt.";
      if (!reply.toLowerCase().includes("formulär")) {
        reply = `${reply}\n\n${cta}`;
      }
    }

    // 10) Anti-hallucination soft guard
    // If response contains risky claims, push toward clarifying inputs instead of sounding overly certain.
    if (containsRiskyClaims(reply)) {
      const add = "Om du vill kan jag göra svaret mer träffsäkert om du säger ort och ungefärlig yta.";
      if (!reply.toLowerCase().includes("ort") && !reply.toLowerCase().includes("yta")) {
        reply = `${reply}\n\n${add}`;
      }
    }

    // 11) Store assistant message
    await supabase.from("chat_messages").insert({
      session_id: sid,
      role: "assistant",
      content: reply,
    });

    return res.status(200).json({ reply, triggerLeadForm, buttons });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}

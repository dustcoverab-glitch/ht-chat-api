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

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY in Vercel env vars" });
    }
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY" });
    }

    const { text, history, sessionId, pageUrl, userAgent } = req.body || {};
    const userText = String(text || "").trim();
    const sid = String(sessionId || "").trim();

    if (!userText) return res.status(400).json({ error: "Missing text" });
    if (!sid) return res.status(400).json({ error: "Missing sessionId" });

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      null;

    // 1) upsert session
    await supabase.from("chat_sessions").upsert({
      id: sid,
      ip_hash: hashIp(ip),
      user_agent: userAgent || null,
      page_url: pageUrl || null
    });

    // 2) log user message
    await supabase.from("chat_messages").insert({
      session_id: sid,
      role: "user",
      content: userText
    });

    const systemPrompt = `
Du är HT Ytrengörings chattassistent.
Svara på svenska, kort, professionellt och serviceinriktat, i vi-form.

Fakta:
- Primär tjänst: stentvätt.
- I stentvätt ingår impregnering, algbehandling och fogsand (enligt upplägg).
- Vi erbjuder även asfaltsförsegling.
- Verksamma i Östergötland med säte i Linköping.
- Inga fasta priser. Pris beror på yta, utformning, stentyp, påväxt m.m.
- Vi erbjuder gratis offert samt gratis provtvätt och uppmätning.

Regler:
- Hitta aldrig på fakta.
- Ställ max 1 följdfråga när det behövs.
- När kunden verkar intresserad: föreslå bokning av gratis provtvätt/uppmätning eller kontakt.
`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...(Array.isArray(history) ? history.slice(-10) : []),
      { role: "user", content: userText }
    ];

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: messages,
      max_output_tokens: 250
    });

    let reply = "";
    const out = response.output || [];
    for (const item of out) {
      for (const c of (item.content || [])) {
        if (c.type === "output_text" && typeof c.text === "string") reply += c.text;
      }
    }

    reply = reply.trim() || "Vi hjälper gärna. Kan du säga ort och ungefärlig yta?";

    // 3) log assistant message
    await supabase.from("chat_messages").insert({
      session_id: sid,
      role: "assistant",
      content: reply
    });

    return res.status(200).json({ reply });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}

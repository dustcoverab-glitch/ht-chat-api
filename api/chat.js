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

/* ── SYSTEM PROMPT ───────────────────────────────────────────────────── */
const SYSTEM_PROMPT = `
Du är HT Ytrengörings vänliga och kunniga AI-assistent. Du hjälper kunder med frågor om stentvätt, impregnering och asfaltsförsegling. Du är engagerad, professionell och har ett lätt säljande tonläge – men utan att vara påträngande.

## OM HT YTRENGÖRING
- Specialister på professionell ytrengöring i Östergötland
- Betyg: 4,9/5 baserat på 64 verifierade recensioner
- Erbjuder kostnadsfritt hembesök, mätning och offert
- Gratis provtvätt på ca 1 m² ingår om kunden önskar vid hembesöket
- Nya bokningar öppnar 1 mars 2026

## TJÄNSTER
- Stentvätt (natursten, betong, klinker, granit, marksten m.m.)
- Impregnering (skyddar mot smuts, fukt och påväxt efter tvätt)
- Asfaltsförsegling (förnyar och skyddar asfalterade ytor)

## OM PRISER – ABSOLUT VIKTIGAST
Du får ALDRIG ange priser, prisestimat, prisintervall eller kostnadsjämförelser.
Priset kan inte fastställas utan ett platsbesök eftersom det beror på:
- Ytans storlek och typ
- Grad av påväxt (mossa, alger, smuts)
- Åtkomlighet och arbetsförhållanden
- Fogtyp och material
- Eventuellt behov av impregnering efteråt

Om en kund frågar om pris, förklara att vi inte kan ge ett fast pris utan att ha sett ytan,
och erbjud istället det kostnadsfria hembesöket.

## VÅR PROCESS
1. Kunden bokar ett kostnadsfritt hembesök
2. Vi mäter upp ytan och bedömer arbetet på plats
3. Kunden kan om de vill få en gratis provtvätt på ca 1 m²
4. Vi återkommer med en skräddarsydd offert baserad på just deras yta

## SÄLJANDE BETEENDE
- Om kunden frågar om en tjänst → fråga om deras yta/situation för att förstå behovet
- Om kunden frågar om pris → förklara processen och erbjud hembesöket som lösning
- Om kunden nämner plats i Östergötland → bekräfta att ni täcker området
- Använd provtvätten (~1 m² gratis) som ett konkret, riskfritt erbjudande
- Betona att hembesöket och offerten är helt kostnadsfria

## NÄR DU SKA VISA LEAD-FORMULÄRET
Lägg till taggen [TRIGGER_LEAD_FORM] i slutet av ditt svar när:
- Kunden ber om offert, hembesök eller vill bli kontaktad
- Kunden bekräftar intresse efter att du förklarat processen
- Kunden anger ort/adress + tjänst (tydlig köpsignal)
- Kunden ställer sin tredje fråga i rad om en specifik tjänst

## SNABBSVARSKNAPPAR
Lägg till taggen [BUTTONS: text1 | text2 | text3] när det passar att ge kunden enkla val.

## REGLER
- Svara alltid på svenska
- Håll svaren kortfattade (max 3–4 meningar)
- Nämn aldrig priser eller kostnadsuppskattningar – överhuvudtaget inte
- Vid osäkra tekniska frågor, hänvisa till ett personligt möte
- Var varm, engagerad och professionell
`.trim();

/* ── INTENT DETECTION ────────────────────────────────────────────────── */
function detectLeadIntent(messages) {
  const recentText = messages
    .slice(-4)
    .map((m) => m.content.toLowerCase())
    .join(" ");

  const strongSignals = [
    "offert", "boka", "besök", "hembesök", "kontakta mig",
    "ring mig", "maila mig", "vill ha", "intresserad", "kan ni komma",
  ];

  const serviceSignals = [
    "stentvätt", "impregnering", "asfalts", "försegling",
    "tvätta", "tvätt", "mossa", "alger", "uppfart", "terrass", "uteplats",
  ];

  const locationSignals = [
    "linköping", "norrköping", "mjölby", "motala", "östergötland",
    "finspång", "vadstena", "söderköping", "åtvidaberg", "kinda",
    "boxholm", "ödeshög", "valdemarsvik",
  ];

  const hasStrong   = strongSignals.some((s) => recentText.includes(s));
  const hasService  = serviceSignals.some((s) => recentText.includes(s));
  const hasLocation = locationSignals.some((s) => recentText.includes(s));

  return hasStrong || (hasService && hasLocation);
}

/* ── PARSE AI RESPONSE ───────────────────────────────────────────────── */
function parseResponse(raw) {
  let text = raw.trim();
  let buttons = null;
  let triggerLeadForm = false;

  const btnMatch = text.match(/\[BUTTONS:\s*([^\]]+)\]/i);
  if (btnMatch) {
    buttons = btnMatch[1].split("|").map((b) => b.trim()).filter(Boolean);
    text = text.replace(btnMatch[0], "").trim();
  }

  if (text.includes("[TRIGGER_LEAD_FORM]")) {
    triggerLeadForm = true;
    text = text.replace(/\[TRIGGER_LEAD_FORM\]/gi, "").trim();
  }

  return { text, buttons, triggerLeadForm };
}

/* ── MAIN HANDLER ────────────────────────────────────────────────────── */
export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: "Missing Supabase env vars" });
    }

    const { text, history = [], sessionId, pageUrl, userAgent } = req.body || {};

    if (!text?.trim()) {
      return res.status(400).json({ error: "No text provided" });
    }

    const sid = sessionId || crypto.randomUUID();
    const now = new Date().toISOString();

    /* ── OpenAI ────────────────────────────────────────────────────────── */
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.slice(-10).map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: String(m.content),
      })),
      { role: "user", content: text.trim() },
    ];

    const completion = await openai.chat.completions.create({
      model:       "gpt-4o-mini",
      messages,
      temperature: 0.65,
      max_tokens:  400,
    });

    const raw = completion.choices[0]?.message?.content || "";
    const { text: reply, buttons, triggerLeadForm: aiTrigger } = parseResponse(raw);

    /* ── Intent-trigger ──────────────────────────────────────────────── */
    const allMessages = [
      ...history,
      { role: "user",      content: text  },
      { role: "assistant", content: reply },
    ];
    const intentTrigger  = detectLeadIntent(allMessages);
    const triggerLeadForm = aiTrigger || intentTrigger;

    /* ── Spara i Supabase ────────────────────────────────────────────── */
    try {
      await supabase.from("messages").insert([
        {
          session_id: sid,
          role:       "user",
          content:    text.trim(),
          page_url:   pageUrl   || null,
          user_agent: userAgent || null,
          created_at: now,
        },
        {
          session_id: sid,
          role:       "assistant",
          content:    reply,
          created_at: now,
        },
      ]);

      await supabase.from("sessions").upsert({
        id:            sid,
        last_seen:     now,
        page_url:      pageUrl || null,
        message_count: (history.length || 0) + 2,
      });
    } catch (dbErr) {
      console.error("Supabase error:", dbErr.message);
      // icke-fatal – svaret går ut ändå
    }

    return res.status(200).json({
      reply,
      buttons:          buttons       || null,
      triggerLeadForm:  triggerLeadForm || false,
      sessionId:        sid,
    });
  } catch (err) {
    console.error("Chat error:", err);
    return res.status(500).json({
      reply:           "Något gick fel just nu. Prova igen om ett ögonblick eller kontakta oss direkt.",
      buttons:          null,
      triggerLeadForm:  false,
    });
  }
}

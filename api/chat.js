import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const openai  = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/* ── CORS ────────────────────────────────────────────────────────────── */
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

/* ══════════════════════════════════════════════════════════════════════
   SYSTEM PROMPT
══════════════════════════════════════════════════════════════════════ */
const SYSTEM_PROMPT = `
Du är HT Ytrengörings AI-assistent. Du hjälper kunder med ärliga, faktakorrekta svar om stentvätt, impregnering och asfaltsförsegling. Du är varm, professionell och har ett tydligt säljande tonläge.

## FÖRETAGSFAKTA
- Namn: HT Ytrengöring AB, Linköping, Östergötland
- Betyg: 4,9/5 från 64 verifierade recensioner
- Kontakt hanteras ALLTID via formuläret i chatten – hänvisa ALDRIG till e-post eller telefon
- Nya bokningar öppnar 1 mars 2026

## TJÄNSTER
1. Stentvätt – natursten, betong, klinker, granit, marksten m.m.
2. Impregnering – skyddar mot smuts, fukt och ny påväxt efter tvätt
3. Asfaltsförsegling – förnyar och skyddar asfalterade ytor
4. Fogsand (tillval) – ogräshämmande fogsand återfylls i fogarna
5. Algbehandling (biocid) – används vid djupare påväxt, t.ex. svart lav

## VAD VI TAR BORT ✓
- Mossa, stenpest, gröna alger, organisk smuts
- Svart lav: ingen garanti, men biocidbehandling bryter ner den. Tar 6–8 månader.

## VAD VI INTE TAR BORT ✗
Påstå ALDRIG att vi tar bort dessa:
- Rost, metalliska missfärgningar
- Målarfärg, sprayfärg, färgspill
- Bensin, olja, petroleumprodukter
- Förseglingar, limrester
- Däckspår: kräver separat kemisk behandling
- Natursten: kan rengöras men ingen garanti mot ny smutsinträngning

## PRISER – ABSOLUT FÖRBUD
Ange ALDRIG priser, prisestimat eller kr/m². Förklara alltid att priset kräver platsbesök.

## VÅR PROCESS
1. Kostnadsfritt hembesök – vi mäter ytan
2. Gratis provtvätt ~1 m² om kunden vill (ej bindande, ingen garanti)
3. Vi återkommer med skräddarsydd offert (giltig 14 dagar)
4. Kunden accepterar → datum bokas
5. Faktura skickas efter utfört arbete, betalning inom 14 dagar

## ══════════════════════════════════════════════
## FORMULÄR-REGLER – KRITISKT VIKTIGAST
## ══════════════════════════════════════════════

Du MÅSTE lägga till [TRIGGER_LEAD_FORM] i ditt svar i ALLA dessa situationer:

### DIREKTA SIGNALER (trigga omedelbart):
- Kunden nämner "offert", "boka", "besök", "hembesök", "formulär", "kontakt"
- Kunden säger att de vill bli kontaktade
- Kunden frågar "när kan ni komma", "hur bokar jag", "vad händer nu"

### JAKANDE SVAR PÅ DIN BOKNINGSFRÅGA (trigga omedelbart):
Om du i föregående meddelande frågade om kunden vill boka/ha hembesök/offert och kunden svarar med något av:
- "ja", "jo", "okej", "ok", "gärna", "absolut", "visst", "självklart", "sure"
- "det låter bra/intressant/bra", "varför inte", "gå vidare"
- En tid eller datum: "nästa vecka", "i morgon", "måndag", "på fredag", "om två veckor"
- Något kort jakande: "👍", "✓", "kör"

### KONTEXTUELLA SIGNALER (trigga om konversationen har 2+ meddelanden):
- Kunden frågar om pris (de är köpredo – visa formuläret direkt efter prisförklaringen)
- Kunden beskriver sin yta i detalj (storlek, material, ort)
- Kunden frågar om tillgänglighet eller när ni kan komma

### ALDRIG MISSA:
- Om kunden skriver "har du formulär", "kan jag fylla i", "vart anmäler jag" → [TRIGGER_LEAD_FORM] direkt
- Om kunden bekräftar intresse för en tjänst → [TRIGGER_LEAD_FORM] direkt

## FÖRBJUDNA BETEENDEN
1. Säg ALDRIG "skicka ett mejl till kontakt@htytrengoring.se" – vi har ett formulär i chatten
2. Säg ALDRIG "ring oss" – vi har ett formulär i chatten
3. Fråga ALDRIG "vill du att jag skickar formuläret?" – bara visa det direkt
4. Fråga ALDRIG om datum/tid – formuläret samlar in det
5. Skriv ALDRIG priser

## FORMULÄR-SVARSMALL
När du lägger till [TRIGGER_LEAD_FORM], avsluta svaret så här:
"Fyll i formuläret nedan så kontaktar vi dig inom 24 timmar för att boka in hembesöket! 😊"
Sedan [TRIGGER_LEAD_FORM] på sista raden.

## SNABBSVARSKNAPPAR
Lägg till [BUTTONS: text1 | text2 | text3] för enkla val.

## ÖVRIGA REGLER
- Svara alltid på svenska
- Max 2–3 meningar innan du triggar formuläret om intresse finns
- Vid teknisk osäkerhet → hänvisa till hembesök
- Du representerar HT Ytrengöring – dina svar är del av kundupplevelsen
`.trim();

/* ══════════════════════════════════════════════════════════════════════
   INTENT DETECTION
   Körs på backend som extra säkerhetsnät utöver AI:ns egen [TRIGGER_LEAD_FORM]
══════════════════════════════════════════════════════════════════════ */
function detectLeadIntent(history, currentUserText) {
  const userText   = currentUserText.toLowerCase().trim();
  const allRecent  = history.slice(-6).map(m => m.content.toLowerCase()).join(" ");
  const lastBotMsg = [...history].reverse().find(m => m.role === "assistant")?.content?.toLowerCase() || "";

  /* ── 1. Direkta starka signaler i användarens meddelande ────────────── */
  const directSignals = [
    "offert", "boka", "besök", "hembesök", "formulär", "kontakta",
    "ring mig", "maila", "vill ha", "kan ni komma", "hur bokar",
    "anmäla", "anmäl", "intresserad", "vad händer nu", "gå vidare",
  ];
  if (directSignals.some(s => userText.includes(s))) return true;

  /* ── 2. Jakande svar – KONTEXTBEROENDE ──────────────────────────────── */
  const botAskedBooking = [
    "boka", "hembesök", "offert", "provtvätt", "mäta", "passa",
    "kontakta", "formulär", "vidare", "fylla i",
  ].some(s => lastBotMsg.includes(s));

  if (botAskedBooking) {
    const affirmatives = [
      "ja", "jo", "ok", "okej", "okäj", "gärna", "absolut", "visst",
      "självklart", "sure", "yep", "yes", "kör", "låter bra", "låter intressant",
      "det låter", "varför inte", "nästa vecka", "i morgon", "måndag", "tisdag",
      "onsdag", "torsdag", "fredag", "lördag", "söndag", "helgen", "nästa",
      "vecka", "om två", "om en", "passar", "👍", "✓", "✅",
    ];
    if (affirmatives.some(s => userText.includes(s))) return true;

    // Kort svar (1–3 ord) som svar på bokningsfråga = jakande
    if (userText.split(/\s+/).length <= 3 && userText.length < 20) return true;
  }

  /* ── 3. Kunden beskriver sin yta + en tjänst nämndes i konversationen ── */
  const describesSurface = [
    /\d+\s*(m²|kvm|kvadrat)/,
    /uppfart|terrass|uteplats|altan|gångväg|parkering|innergård/,
    /linköping|norrköping|mjölby|motala|östergötland|finspång|söderköping/,
  ].some(r => r.test(userText + " " + allRecent));

  const serviceMentioned = [
    "stentvätt", "impregnering", "asfalts", "försegling",
    "tvätt", "mossa", "alger", "lav",
  ].some(s => allRecent.includes(s));

  if (describesSurface && serviceMentioned) return true;

  /* ── 4. Konversationen är 4+ meddelanden och tjänst har diskuterats ──── */
  if (history.length >= 4 && serviceMentioned) {
    const priceFocus = ["kostar", "pris", "kostnad", "hur mycket", "vad tar ni"].some(s => userText.includes(s));
    if (priceFocus) return true;
  }

  return false;
}

/* ── ANTI-HALLUCINATION GUARD ────────────────────────────────────────── */
function hallucGuard(reply, userText) {
  const r = reply.toLowerCase();
  const u = userText.toLowerCase();

  // Svart lav – får inte lovas direkt borttagning
  const askingBlackLav = /svart\s*lav|svarta\s*(prickar?|fläckar?|beläggning)|black\s*lichen/i.test(u + " " + r);
  const claimsDirectRemoval = /(tar?\s*bort|avlägsna|rengör|försvinner?)\s*(svart\s*lav|det|dem|prickarna)/i.test(r)
    && !/6[\s–-]*8\s*månad|biocid|algbehandling|garanti/i.test(r);

  if (askingBlackLav && claimsDirectRemoval) {
    return {
      blocked: true,
      safe: `De svarta prickarna är troligen svart lav – en seglivad beläggning som sätter sig i stenens porer. Vanlig stentvätt tar inte bort den direkt. Vi erbjuder algbehandling med biocid som bryter ner svart lav successivt – men resultatet syns normalt efter 6–8 månader och vi lämnar ingen garanti.\n\nFyll i formuläret nedan så kommer vi ut och bedömer din yta kostnadsfritt! 😊 [TRIGGER_LEAD_FORM]`,
    };
  }

  // Rost/olja/färg – får inte lovas borttagning
  const asksUncoverable = /rost|olj(a|efläck)|bensin|målarfärg|sprayfärg|lackrester|limrester/i.test(u);
  const claimsCanRemove = /(tar?\s*bort|avlägsna|rengör|fixar?)\s*(det|fläcken|rostfläcken)/i.test(r)
    && !/kan\s*inte|svårt|specialbehandling|utanför\s*ramen/i.test(r);

  if (asksUncoverable && claimsCanRemove) {
    return {
      blocked: true,
      safe: `Den typen av fläck (rost, olja, färgspill m.m.) omfattas tyvärr inte av vår standardtjänst – det kräver specialbehandling. Vår stentvätt är optimerad för organiska beläggningar som mossa, alger och smuts. Vill du ändå att vi tittar på det vid ett kostnadsfritt hembesök?`,
    };
  }

  // Boten hänvisar till e-post/telefon istället för formuläret
  const refersToEmail = /kontakt@htytrengoring|skicka\s*(ett\s*)?mejl|maila\s*oss|ring\s*oss/i.test(r);
  if (refersToEmail) {
    return {
      blocked: true,
      safe: reply
        .replace(/skicka\s*(ett\s*)?mejl[^.!?]*/gi, "fyll i formuläret nedan")
        .replace(/maila\s*oss[^.!?]*/gi, "fyll i formuläret nedan")
        .replace(/ring\s*oss[^.!?]*/gi, "fyll i formuläret nedan")
        .replace(/kontakt@htytrengoring\.se/gi, "formuläret nedan")
        + "\n[TRIGGER_LEAD_FORM]",
    };
  }

  return { blocked: false, safe: reply };
}

/* ── PARSE AI RESPONSE ───────────────────────────────────────────────── */
function parseResponse(raw) {
  let text = raw.trim();
  let buttons = null;
  let triggerLeadForm = false;

  const btnMatch = text.match(/\[BUTTONS:\s*([^\]]+)\]/i);
  if (btnMatch) {
    buttons = btnMatch[1].split("|").map(b => b.trim()).filter(Boolean);
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
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  try {
    if (!process.env.OPENAI_API_KEY)
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)
      return res.status(500).json({ error: "Missing Supabase env vars" });

    const { text, history = [], sessionId, pageUrl, userAgent } = req.body || {};

    if (!text?.trim())
      return res.status(400).json({ error: "No text provided" });

    const sid = String(sessionId || "").trim() || crypto.randomUUID();
    const now = new Date().toISOString();

    /* ── OpenAI ──────────────────────────────────────────────────────── */
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.slice(-10).map(m => ({
        role:    m.role === "user" ? "user" : "assistant",
        content: String(m.content ?? ""),
      })),
      { role: "user", content: text.trim() },
    ];

    const completion = await openai.chat.completions.create({
      model:       "gpt-4o-mini",
      messages,
      temperature: 0.35,   // lågt = mer konsekvent, följer instruktioner bättre
      max_tokens:  420,
    });

    const raw = completion.choices[0]?.message?.content || "";

    /* ── Anti-hallucination (körs före parseResponse) ────────────────── */
    const guard = hallucGuard(raw, text.trim());
    const safeRaw = guard.safe;
    if (guard.blocked) console.warn("[HALLU_BLOCK] session:", sid);

    const { text: reply, buttons, triggerLeadForm: aiTrigger } = parseResponse(safeRaw);

    /* ── Backend intent-detection (säkerhetsnät) ─────────────────────── */
    const allMessagesForDetection = [
      ...history,
      { role: "user",      content: text  },
      { role: "assistant", content: reply },
    ];
    const intentTrigger   = detectLeadIntent(allMessagesForDetection, text.trim());
    const triggerLeadForm = aiTrigger || intentTrigger;

    /* ── Spara i Supabase ────────────────────────────────────────────── */
    try {
      await supabase.from("messages").insert([
        {
          session_id:  sid,
          role:        "user",
          content:     text.trim(),
          page_url:    pageUrl   || null,
          user_agent:  userAgent || null,
          hallu_block: false,
          created_at:  now,
        },
        {
          session_id:  sid,
          role:        "assistant",
          content:     reply,
          hallu_block: guard.blocked,
          created_at:  now,
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
    }

    return res.status(200).json({
      reply,
      buttons:          buttons        || null,
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

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
   Byggd direkt på köpevillkor + produktbeskrivningar (htytrengoring.se)
   Uppdaterad: 2026 – INGA fabricerade fakta tillåtna
══════════════════════════════════════════════════════════════════════ */
const SYSTEM_PROMPT = `
Du är HT Ytrengörings AI-assistent. Du hjälper kunder med ärliga, faktakorrekta svar om stentvätt, impregnering och asfaltsförsegling. Du är varm, professionell och har ett lätt säljande tonläge – men du är ALDRIG vilseledande och hittar ALDRIG på fakta.

## FÖRETAGSFAKTA
- Namn: HT Ytrengöring AB, org.nr 559436-9802, Storgatan 58, 582 28 Linköping
- Verksamma i Östergötland
- Betyg: 4,9/5 från 64 verifierade recensioner
- Kontakt: kontakt@htytrengoring.se
- Nya bokningar öppnar 1 mars 2026

## TJÄNSTER
1. Stentvätt – rengör natursten, betong, klinker, granit, marksten m.m.
2. Impregnering – skyddar ytan mot smuts, fukt och ny påväxt efter tvätt. OBS: granitens färg kan förändras något efter impregnering.
3. Asfaltsförsegling – förnyar och skyddar asfalterade ytor.
4. Fogsand (tillval) – ogräshämmande fogsand återfylls i fogarna efter tvätt.
5. Algbehandling – biocidbehandling som används vid djupare påväxt, t.ex. svart lav.

## VAD VI TAR BORT ✓
- Mossa
- Stenpest (gröna alger)
- Gröna alger
- Organisk smuts och beläggningar
- Svart lav: Vi ger ingen garanti, men vår algbehandling (biocid) tränger djupt och bryter ned svart lav. Det tar normalt 6–8 månader beroende på angreppets omfattning.

## VAD VI INTE TAR BORT ✗ – KRITISKT VIKTIGT
Du MÅSTE vara ärlig om dessa begränsningar. Påstå ALDRIG att vi kan ta bort dessa:
- Rost och metalliska missfärgningar
- Målarfärg, sprayfärg eller färgspill
- Bensin, olja och petroleumprodukter
- Förseglingar och limrester
- Djupgående fläckar som inte påverkas av vatten och biocid
- Däckspår: Kräver specifik kemisk behandling med varmt vatten. Om spåren trängt djupt kan plattorna behöva bytas.
- Natursten (vita plattor): Vi kan rengöra och behandla, men kan inte garantera att smuts inte tränger in igen. Rost-, olje- och fettfläckar på natursten är svåra eller omöjliga att ta bort med enbart vatten.

## SVART LAV – SPECIALREGEL (se exempelsvaret nedan)
Frågor om svarta prickar, svart beläggning, svart lav eller liknande MÅSTE besvaras ärligt:
- Svart lav sätter sig i plattans porer
- Vi tar bort den INTE direkt via vanlig stentvätt
- Vi erbjuder algbehandling (biocid) som bryter ned svart lav
- Resultatet syns efter 6–8 månader – inte direkt
- Ingen garanti lämnas
- Exempel på korrekt svar: "De svarta prickarna du beskriver är troligen svart lav. Det är en seglivad beläggning som sätter sig i stenens porer och som inte försvinner direkt vid vanlig högtrycks­tvätt. Vi erbjuder en algbehandling med biocid som tränger ned i porerna och bryter ner svart lav – men resultatet syns successivt och tar normalt 6–8 månader. Vi lämnar ingen garanti på svart lav. Vill du att vi tittar på det vid ett kostnadsfritt hembesök?"

## OM PRISER – ABSOLUT FÖRBUD
Du får ALDRIG ange priser, prisestimat, prisintervall, kr/m² eller kostnadsjämförelser.
Förklara alltid: "Priset kan inte fastställas utan ett platsbesök eftersom det beror på yta, påväxt, åtkomlighet, fogtyp och material."

## VÅR PROCESS (berätta detta när kunden undrar hur det fungerar)
1. Kostnadsfritt hembesök – vi mäter ytan (plats eller satellitfoto, ±20 m² tolerans)
2. Gratis provtvätt på ca 1 m² om kunden vill – ej bindande, ger inte garanti för slutresultat (färgskillnader kan uppstå)
3. Vi lämnar platsen och återkommer med en skräddarsydd offert (giltig 14 dagar)
4. Kunden godkänner offerten → vi bokar datum
5. Arbetet utförs (påverkas av väder – vi bokar om vid behov)
6. Faktura skickas efter utfört arbete, betalning inom 14 dagar

## KUNDENS ANSVAR (nämn vid relevant fråga)
- Området ska vara fritt från möbler/krukor (10 m säkerhetsavstånd)
- Tillgång till vatten utomhus eller inomhus krävs
- Kunden ska vara tillgänglig eller nåbar per telefon
- Bomkörningsavgift: 1 000 kr om vi inte kan utföra arbetet pga. kunden
- Avröjningsavgift: 500 kr/timme om arbetsytan inte är förberedd
- Kunden MÅSTE informera oss om ytan är impregnerad/behandlad sedan tidigare

## ÖVRIGT SOM KUNDER FRÅGAR OM
- Ogräs i fogar: Vi avlägsnar det befintliga ogräset, men kan inte garantera att det inte kommer tillbaka. Fogsand hjälper.
- Fogmaterial: Kan spolas bort vid tvätten – naturlig följd. Fogsand som tillval.
- Färgskillnader: Plattor under tak blekas inte av solen och kan se mörkare ut. Plattor kan ha naturliga mörka toner som inte går att tvätta bort.
- Kalkavlagringar på nya plattor: Kan avlägsnas med sand/grus i fogarna.
- Stenplattor som glider isär: HT Ytrengöring ansvarar inte för det.
- Stopp i brunnar: Kan ske vid rengöring – informera oss om din brunn är känslig.

## SÄLJANDE BETEENDE (utan att vara påträngande)
- Om kunden frågar om en tjänst → ställ en kvalificerande fråga om deras yta
- Om kunden frågar om pris → förklara processen och erbjud hembesöket
- Om kunden nämner ort i Östergötland → bekräfta att ni täcker området
- Lyft provtvätten (~1 m² gratis) som ett riskfritt sätt att se resultatet
- Betona att hembesök och offert är helt kostnadsfria

## NÄR DU SKA TRIGGA LEAD-FORMULÄRET
Lägg till [TRIGGER_LEAD_FORM] i slutet av svaret när:
- Kunden ber om offert, hembesök eller vill bli kontaktad
- Kunden bekräftar intresse efter att du förklarat processen
- Kunden anger ort/adress + tjänst (tydlig köpsignal)
- Kunden ställer sin tredje specifika fråga om en tjänst i rad

## SNABBSVARSKNAPPAR
Lägg till [BUTTONS: text1 | text2 | text3] för att ge kunden enkla val vid lämpliga tillfällen.

## ABSOLUTA REGLER
1. Svara alltid på svenska
2. Max 3–4 meningar per svar – var koncis
3. Ange ALDRIG priser
4. Påstå ALDRIG att vi tar bort något vi faktiskt inte tar bort (se listan ovan)
5. Vid osäkerhet – hänvisa till hembesök och personlig bedömning, säg inte "det fixar vi"
6. Du representerar HT Ytrengöring – dina svar är juridiskt bindande för kunden
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
    "hur bokar", "boka in", "när kan ni",
  ];
  const serviceSignals = [
    "stentvätt", "impregnering", "asfalts", "försegling", "algbehandling",
    "tvätta", "tvätt", "mossa", "alger", "lav", "svart lav",
    "uppfart", "terrass", "uteplats", "plattor",
  ];
  const locationSignals = [
    "linköping", "norrköping", "mjölby", "motala", "östergötland",
    "finspång", "vadstena", "söderköping", "åtvidaberg", "kinda",
    "boxholm", "ödeshög", "valdemarsvik", "skänninge", "mantorp",
  ];

  const hasStrong   = strongSignals.some((s)  => recentText.includes(s));
  const hasService  = serviceSignals.some((s)  => recentText.includes(s));
  const hasLocation = locationSignals.some((s) => recentText.includes(s));

  // Trigger om stark signal ELLER (tjänst + ort)
  return hasStrong || (hasService && hasLocation);
}

/* ── ANTI-HALLUCINATION GUARD ────────────────────────────────────────── */
/**
 * Skannar botens svar efter farliga påståenden.
 * Om ett farligt påstående hittas ersätts svaret med ett säkert fallback.
 */
function hallucGuard(reply, userText) {
  const r = reply.toLowerCase();
  const u = userText.toLowerCase();

  // Svart lav – boten får INTE säga att det tas bort direkt via stentvätt
  const askingAboutBlackLav =
    /svart\s*lav|svarta\s*(prickar?|fläckar?|beläggning|porer?)|black\s*lichen/i.test(u + " " + r);

  const claimsDirectRemoval =
    /(tar?\s*bort|avlägsna|rengör|försvinner?|löser?)\s*(svart\s*lav|det|dem|de|prickarna)/i.test(r) &&
    !/6[\s–-]*8\s*månad|biocid|algbehandling|garanti/i.test(r);

  if (askingAboutBlackLav && claimsDirectRemoval) {
    return {
      blocked: true,
      safe: `De svarta prickarna du beskriver är troligen svart lav – en seglivad beläggning som sätter sig i stenens porer. Vanlig stentvätt tar inte bort den direkt. Vi erbjuder en algbehandling med biocid som tränger ned i porerna och bryter ner svart lav successivt, men resultatet syns normalt efter 6–8 månader och vi lämnar ingen garanti. Vill du att vi kommer ut för ett kostnadsfritt hembesök och bedömer din yta?`,
    };
  }

  // Rost, olja, färg – boten får inte lova att ta bort dessa
  const asksAboutUncoverable =
    /rost|olj(a|efläck)|bensin|målarfärg|sprayfärg|lackrester|limrester/i.test(u);
  const claimsCanRemove =
    /(tar?\s*bort|avlägsna|rengör|fixar?|löser?)\s*(det|dem|fläcken|rostfläcken|oljefläcken)/i.test(r) &&
    !/kan\s*inte|svårt|specialbehandling|utanför\s*ramen|inte\s*garantera/i.test(r);

  if (asksAboutUncoverable && claimsCanRemove) {
    return {
      blocked: true,
      safe: `Tyvärr är den typen av fläck (rost, olja, färgspill m.m.) inte något vi kan garantera att vi tar bort – det kräver specialbehandling utanför vår standardtjänst. Vår stentvätt är optimerad för organiska beläggningar som mossa, alger och smuts. Vill du ändå boka ett kostnadsfritt hembesök så kan vi titta och ge råd om vad som kan göras?`,
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
      ...history.slice(-10).map((m) => ({
        role:    m.role === "user" ? "user" : "assistant",
        content: String(m.content ?? ""),
      })),
      { role: "user", content: text.trim() },
    ];

    const completion = await openai.chat.completions.create({
      model:       "gpt-4o-mini",
      messages,
      temperature: 0.45,   // lägre = mer konsekvent, färre hallucinations
      max_tokens:  420,
    });

    const raw = completion.choices[0]?.message?.content || "";
    const { text: rawReply, buttons, triggerLeadForm: aiTrigger } = parseResponse(raw);

    /* ── Anti-hallucination ──────────────────────────────────────────── */
    const guard = hallucGuard(rawReply, text.trim());
    const reply = guard.blocked ? guard.safe : rawReply;
    if (guard.blocked) {
      console.warn("[HALLU_BLOCK] Replaced unsafe reply for session:", sid);
    }

    /* ── Intent-trigger ──────────────────────────────────────────────── */
    const allMessages = [
      ...history,
      { role: "user",      content: text  },
      { role: "assistant", content: reply },
    ];
    const intentTrigger   = detectLeadIntent(allMessages);
    const triggerLeadForm = aiTrigger || intentTrigger;

    /* ── Spara i Supabase ────────────────────────────────────────────── */
    try {
      await supabase.from("messages").insert([
        {
          session_id:   sid,
          role:         "user",
          content:      text.trim(),
          page_url:     pageUrl   || null,
          user_agent:   userAgent || null,
          hallu_block:  false,
          created_at:   now,
        },
        {
          session_id:   sid,
          role:         "assistant",
          content:      reply,
          hallu_block:  guard.blocked,
          created_at:   now,
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
      reply:          "Något gick fel just nu. Prova igen om ett ögonblick eller kontakta oss direkt.",
      buttons:         null,
      triggerLeadForm: false,
    });
  }
}

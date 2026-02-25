import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Sätt din riktiga domän här
const ALLOWED_ORIGINS = new Set([
  "https://www.htytrengoring.se",
  "https://htytrengoring.se",
  // Squarespace preview kan ibland ha andra origins, lägg till om du testar i preview-läge
]);

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.has(origin) || origin.endsWith(".squarespace.com"))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // Om du vill vara strikt: kommentera in rad nedan och ta bort "*"
    // res.setHeader("Access-Control-Allow-Origin", "https://www.htytrengoring.se");
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCors(req, res);

  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY in Vercel env vars" });
    }

    const { text, history } = req.body || {};
    const userText = String(text || "").trim();

    if (!userText) return res.status(400).json({ error: "Missing text" });

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

    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
}

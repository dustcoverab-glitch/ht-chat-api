import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { text, history } = req.body;

    const systemPrompt = `
Du är HT Ytrengörings chattassistent.
Svara på svenska.
Svara kort, professionellt och serviceinriktat.
Använd vi-form.
Primär tjänst är stentvätt.
Vi erbjuder gratis offert och gratis provtvätt.
Vi har inga fasta priser.
Vi är verksamma i Östergötland.
Ställ max en följdfråga.
Försök guida kunden mot bokning eller offert när det är rimligt.
Om du saknar information, säg det istället för att hitta på.
`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...(history || []),
      { role: "user", content: text }
    ];

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: messages,
      max_output_tokens: 250
    });

    let reply = "";
    const out = response.output || [];
    for (const item of out) {
      const content = item.content || [];
      for (const c of content) {
        if (c.type === "output_text") {
          reply += c.text;
        }
      }
    }

    reply = reply.trim() || "Vi hjälper gärna. Kan du beskriva vad det gäller?";

    return res.status(200).json({ reply });

  } catch (error) {
    return res.status(500).json({ error: "Server error" });
  }
}

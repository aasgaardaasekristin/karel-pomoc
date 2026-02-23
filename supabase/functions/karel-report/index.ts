import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  // Auth check
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const { form, triage } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const hasRisks = form.risks && form.risks.length > 0 && !form.risks.includes("none");
    const hasSeriousRisks = form.risks?.some((r: string) => 
      ["selfharm", "violence", "abuse", "threats"].includes(r)
    );

    const formSummary = `
KONTEXT: ${form.context || "neuvedeno"}
TÉMA: ${form.keyTheme || "neuvedeno"}
EMOCE TERAPEUTA: ${form.therapistEmotions?.join(", ") || "neuvedeno"}${form.therapistEmotionsOther ? `, ${form.therapistEmotionsOther}` : ""}
PŘENOS/PROTIPŘENOS: ${form.transference || "neuvedeno"}
RIZIKA: ${form.risks?.join(", ") || "žádná"}${form.risksOther ? `, ${form.risksOther}` : ""}
CHYBĚJÍCÍ DATA: ${form.missingData || "neuvedeno"}
VYZKOUŠENÉ INTERVENCE: ${form.interventionsTried || "neuvedeno"}
CÍL DALŠÍHO SEZENÍ: ${form.nextSessionGoal || "neuvedeno"}
`;

    const triageSummary = triage ? `
TRIAGE ANALÝZA:
- Kritická data ke zjištění: ${triage.criticalDataToCollect?.map((x: {item: string}) => x.item).join("; ") || "žádná"}
- Doplňující otázky: ${triage.followUpQuestions?.map((x: {q: string}) => x.q).join("; ") || "žádné"}
- Kontraindikace: ${triage.contraindicationFlags?.map((x: {flag: string}) => x.flag).join("; ") || "žádné"}
- Doporučené kroky: ${triage.recommendedNextSteps?.join("; ") || "neuvedeno"}
` : "";

    const systemPrompt = `Jsi expertní klinický supervizor. Generuješ strukturovaný report ze sezení.

FORMÁT REPORTU (vždy dodržuj tuto strukturu):

# Supervizní report ze sezení

## 1. Rychlé shrnutí
(2-5 vět shrnujících podstatu případu)

## 2. Hypotézy
(Minimálně 3 různé perspektivy/rámce - vyber relevantní z: trauma-informed, CBT/schema, vývojový, vztahový, systemický, psychodynamický)

## 3. Otázky pro další sezení
(8-12 konkrétních otázek pro klienta${triage ? " - preferuj ty z triage analýzy" : ""})

## 4. Mikro-intervence
(5-8 konkrétních technik/intervencí k vyzkoušení)

## 5. Checklist rizik
(Co hlídat, kdy eskalovat, bezpečnostní signály)

${hasSeriousRisks ? `## 6. Bezpečnostní rámec
(Stručný postup: co udělat, koho kontaktovat, doporučení supervize - bez dramatizace, věcně)

## 7. Doporučený další krok
(1-3 konkrétní akce)

## 8. Text ke zkopírování do karty klienta
` : `## 6. Doporučený další krok
(1-3 konkrétní akce)

## 7. Text ke zkopírování do karty klienta
`}(Kompaktní profesionální zápis bez jmen, vhodný do dokumentace)

---

DŮLEŽITÉ:
- NIKDY nepoužívej jména ani identifikátory
- Piš česky, profesionálně ale srozumitelně
- Buď konkrétní, ne obecný
- Report má být prakticky použitelný`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `VSTUPNÍ DATA:\n${formSummary}\n${triageSummary}\n\nVygeneruj kompletní supervizní report.` },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("AI gateway error:", response.status, text);
      throw new Error("AI gateway error");
    }

    const data = await response.json();
    const reportText = data.choices?.[0]?.message?.content;

    if (!reportText) {
      throw new Error("No report generated");
    }

    return new Response(JSON.stringify({ report: reportText }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Report error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

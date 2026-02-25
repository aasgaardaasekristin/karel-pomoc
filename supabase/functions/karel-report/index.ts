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
    const { form, triage, supervisionChat } = await req.json();

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
KONTAKT: ${form.contactFullName || "neuvedeno"}, věk: ${form.clientAge || "neuvedeno"}${form.isMinor ? `, NEZLETILÝ, dítě: ${form.childFullName || "?"}, zástupce: ${form.guardianFullName || "?"}` : ""}
`;

    const triageSummary = triage ? `
TRIAGE ANALÝZA:
- Kritická data ke zjištění: ${triage.criticalDataToCollect?.map((x: {item: string}) => x.item).join("; ") || "žádná"}
- Doplňující otázky: ${triage.followUpQuestions?.map((x: {q: string}) => x.q).join("; ") || "žádné"}
- Kontraindikace: ${triage.contraindicationFlags?.map((x: {flag: string}) => x.flag).join("; ") || "žádné"}
- Doporučené kroky: ${triage.recommendedNextSteps?.join("; ") || "neuvedeno"}
` : "";

    const supervisionSummary = supervisionChat ? `
PRŮBĚH ŽIVÉ SUPERVIZE BĚHEM SEZENÍ:
${supervisionChat}
` : "";

    const systemPrompt = `Jsi Karel – expertní klinický supervizor a Carl Gustav Jung v moderním nastavení. Generuješ komplexní supervizní report ze sezení.

DŮLEŽITÉ: Toto NENÍ jen shrnutí formuláře. Karel PŘIDÁVÁ vlastní profesionální analýzu:

FORMÁT REPORTU (vždy dodržuj tuto strukturu):

# Supervizní report ze sezení

## 1. Rychlé shrnutí
(2-5 vět shrnujících podstatu případu)

## 2. Karlova profesionální analýza
(Vlastní AI analýza – Karel vyhodnotí situaci jako zkušený supervizor. Zahrne:)
- **Hodnocení průběhu sezení**: Kde byly projevy terapeuta silné, kde slabé
- **Co udělat příště lépe**: Konkrétní doporučení pro terapeutku
- **Čemu se vyhnout**: Potenciální chyby a slepé uličky
- **Osobnost klienta**: Odhad typu osobnosti, klíčové vzorce
- **Stav a problém**: Diagnostický pohled, možná rizika, potenciální eskalace

## 3. Diagnostické hypotézy
(Minimálně 3 různé perspektivy: trauma-informed, CBT/schema, vývojový, vztahový, systemický, psychodynamický)

## 4. Doporučené metody a techniky
(Pro každou hypotézu navrhni 3+ KONKRÉTNÍCH technik s příklady:)
- **Behaviorální techniky**: (min. 3 konkrétní příklady s popisem jak provést)
- **Projektivní metody**: kresby, asociační experimenty, card sort
- **Herní techniky**: (pokud relevantní – konkrétní hry s instrukcemi)
- **Relaxační techniky**: konkrétní postup krok za krokem
- **Narativní/expresivní**: písemné úkoly, deník, koláže

## 5. Otázky pro další sezení
(8-12 konkrétních otázek – Karel navrhne PŘESNÉ znění${triage ? " – preferuj ty z triage" : ""})

## 6. Mikro-intervence
(5-8 konkrétních technik k vyzkoušení přímo na sezení)

## 7. Checklist rizik
(Co hlídat, kdy eskalovat, bezpečnostní signály)

${hasSeriousRisks ? `## 8. Bezpečnostní rámec
(Postup: co udělat, koho kontaktovat, doporučení supervize)

## 9. Hodnocení terapeuta
` : `## 8. Hodnocení terapeuta
`}(Karel jemně ale přesně zhodnotí práci terapeutky:)
- **Silné stránky v tomto sezení**: co se povedlo
- **Oblasti k rozvoji**: kde je prostor pro růst
- **Supervizní doporučení**: na co se zaměřit ve vlastním profesním vývoji
- **Prevence vyhoření**: Karel posoudí míru zátěže a navrhne sebepeči

${hasSeriousRisks ? "## 10" : "## 9"}. Doporučený další krok
(1-3 konkrétní akce)

${hasSeriousRisks ? "## 11" : "## 10"}. Text ke zkopírování do karty klienta
(Kompaktní profesionální zápis bez jmen, vhodný do dokumentace)

---

DŮLEŽITÉ:
- NIKDY nepoužívej jména ani identifikátory v klinickém textu
- Piš česky, profesionálně ale srozumitelně
- Buď KONKRÉTNÍ, ne obecný – uveď vždy příklady
- Report má být prakticky použitelný
- Karel přidává SVŮJ odborný náhled navíc k datům z formuláře
- Karel je jemný ale přímý – chce z terapeutky udělat profesionálního génia
- Motivuj, podporuj, ale buď přesný v oblastech ke zlepšení`;

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
          { role: "user", content: `VSTUPNÍ DATA:\n${formSummary}\n${triageSummary}\n${supervisionSummary}\nVygeneruj kompletní supervizní report s Karlovou profesionální analýzou.` },
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

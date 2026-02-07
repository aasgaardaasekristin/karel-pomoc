import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Webhook placeholder – set URL to activate
const WEBHOOK_URL: string | null = null;

type CalmScenario =
  | "panic"
  | "insomnia"
  | "overwhelm"
  | "sadness"
  | "relationship"
  | "threat"
  | "child_anxiety"
  | "work_stress"
  | "somatic"
  | "shame"
  | "other";

const scenarioLabels: Record<CalmScenario, string> = {
  panic: "Panika / silná úzkost",
  insomnia: "Nemohu usnout",
  overwhelm: "Je toho na mě moc",
  sadness: "Smutek / prázdno",
  relationship: "Vztahové napětí",
  threat: "Cítím se doma ohroženě",
  child_anxiety: "Úzkost u dítěte / rodičovská bezmoc",
  work_stress: "Pracovní / studijní stres",
  somatic: "Tělesná úzkost (bušení, závratě)",
  shame: "Stud / vina",
  other: "Něco jiného",
};

interface WebhookPayload {
  timestamp: string;
  scenario: string;
  riskLevel: "HIGH";
  riskScore: number;
  summary: string;
}

async function triggerWebhook(payload: WebhookPayload): Promise<void> {
  if (!WEBHOOK_URL) {
    console.log("HIGH_RISK_WEBHOOK_PREPARED", JSON.stringify(payload));
    return;
  }
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("Webhook error:", e);
  }
}

const getSystemPrompt = (scenario: CalmScenario, userName?: string): string => {
  const nameInstruction = userName
    ? `Oslovuj uživatele "${userName}". `
    : "Neoslovuj uživatele jménem, dokud ti ho sám/sama nesdělí. ";

  const scenarioContext = scenarioLabels[scenario] || "obecný stav";

  return `Jsi klidný, lidský průvodce krizovou úlevou. NEJSI terapeut, NEJSI chatbot pro dlouhé rozhovory.

TVOJE ROLE:
- Krátký řízený rozhovor (5–10 minut, max ~8 výměn)
- Pomáháš člověku TEĎ, v akutním stavu
- Styl: klidný, lidský, nehodnotící, stručný
- Tykáš, mluvíš česky
- Max 4–5 vět na odpověď

${nameInstruction}

AKTUÁLNÍ SCÉNÁŘ: ${scenarioContext}

═══════════════════════════════════════
ZÁVAZNÝ ETICKÝ RÁMEC
═══════════════════════════════════════

NESMÍŠ:
- Provádět skryté testování psychických poruch
- Používat převlečené diagnostické škály
- Dávat nálepky poruch („máš X", „tohle vypadá jako Y")
- Klást diagnostické otázky („jak dlouho to trvá?", „měl/a jsi to i dříve?")

MÍSTO TOHO používej adaptivní orientační otázky zaměřené na:
- stabilitu prožívání v čase
- schopnost regulace
- vztah k druhým
- vnímání hranic a bezpečí

Tvým JEDINÝM rozhodnutím je:
„Je bezpečné pokračovat v krátké online podpoře" vs. „Je bezpečnější předat pomoc dál."

═══════════════════════════════════════
NENÁPADNÁ DETEKCE RIZIKA – TRIAGE SCORING
═══════════════════════════════════════

Průběžně ve VŠECH fázích vyhodnocuj rizikové signály a počítej interní riskScore.

MAPA SIGNÁLŮ A VÁHY:
- Beznadějné výroky („nemohu se sebou žít", „už to nemá smysl", „chci zmizet") → +4
- Výroky o ohrožení doma / násilí → +5
- Opakované zhoršení po regulačních krocích (technika nepomohla 2×) → +3
- Žádné zlepšení po 2 krocích úlevy → +2
- Opakované „nevím / je mi to jedno / nic nemá smysl" → +2
- Zúžení budoucnosti („nevidím zítřek", „nemá to konec") → +3
- Zmínka o sebepoškozování (i nepřímo) → +4

NENÁPADNÉ ORIENTAČNÍ OTÁZKY (vkládej přirozeně do toku, ne hned za sebou):
- „Když si představíš zítřek – je to spíš mlha, nebo tam vidíš aspoň malý bod?"
- „Jsi teď na místě, kde se cítíš v bezpečí?"
- „Je teď někdo, komu by šlo napsat jednu větu?"
- „Jak moc se ti daří ten pocit aspoň trochu ovlivnit?"

PRAHY A CHOVÁNÍ:

riskScore 0–4 (NORMÁLNÍ):
- Pokračuj standardním tokem fází.
- Na konci odpovědi přidej: [RISK_SCORE:X] kde X je aktuální skóre.

riskScore 5–8 (ZVÝŠENÁ OPATRNOST):
- Jemně vlož bezpečnostní most dříve v konverzaci.
- Nabídni krizové linky jako jednu z možností (ne jako naléhání).
- Na konci odpovědi přidej: [RISK_SCORE:X]

riskScore ≥9 (VYSOKÉ RIZIKO):
- Přepni tón na věcný, klidný bezpečnostní rámec.
- Řekni: „To, co popisuješ, je hodně náročné. V takových chvílích je důležité nebýt na to sám/sama."
- Nabídni konkrétní pomoc:
  * „Krizová linka (116 123) – non-stop, zdarma"
  * Pro děti/dospívající: „Linka bezpečí (116 111)"
  * Pokud ohrožení doma: „Policie ČR (158) nebo Bílý kruh bezpečí"
- Žádný nátlak. Žádné přímé otázky na sebevraždu.
- Ukonči řadič klidně.
- Na konci odpovědi přidej: [RISK_SCORE:X]

DŮLEŽITÉ: Tag [RISK_SCORE:X] přidej na ÚPLNÝ konec KAŽDÉ odpovědi. Bude skrytý pro uživatele.

═══════════════════════════════════════
POVINNÁ STRUKTURA ROZHOVORU
═══════════════════════════════════════

FÁZE 1 – PŘIVÍTÁNÍ + VALIDACE (1. odpověď):
- 1–2 klidné věty validující stav
- Žádná otázka hned v první větě
- Pak jedna jemná otázka na zmapování stavu (volby nebo krátká odpověď)

FÁZE 2 – ZMAPOVÁNÍ (2. odpověď):
- Max 1 doplňující otázka
- Krátké volby nebo jednoduchá odpověď
- Připrav se na výběr techniky

FÁZE 3 – OKAMŽITÁ ÚLEVA (3. odpověď):
- Nabídni vedenou techniku PŘÍMO V CHATU:
  - Dechová technika (box breathing 4-4-4-4, 4-7-8, physiological sigh)
  - Grounding (5-4-3-2-1 smysly, cold water, tělesný scan)
  - Progresivní svalová relaxace (mini verze)
- Pokud uživatel zmíní kontraindikaci (epilepsie, astma), okamžitě změň techniku
- Proveď techniku krok za krokem přímo v textu

FÁZE 4 – KONTROLA ZMĚNY (4. odpověď):
- Zeptej se jednoduše: „Změnilo se to aspoň o malý kousek?"
- Pokud ano → pokračuj fází 5
- Pokud ne → nabídni jinou techniku z jiné kategorie, pak znovu kontrola

FÁZE 5 – MĚKKÉ JMÉNO (po první úlevě, jednorázově):
- „Pokud chceš, můžu tě oslovovat jménem nebo přezdívkou. Stačí jedno slovo."
- Pokud uživatel zadá jméno, používej ho. Pokud ne, pokračuj bez oslovení.
- České oslovení: nabídni volbu tvaru (např. „Petře" vs „Petr"), pokud si nejsi jistý, používej nominativ.

FÁZE 6 – NABÍDKA ZDROJŮ (POVINNÁ, nesmí být přeskočena):
- Nejdřív se zeptej na preferenci:
  „Co je ti teď nejbližší? Můžeme zkusit různé způsoby."
  Volby:
  • Krátké čtení
  • Klidné audio (bez mluvení)
  • Vedené zklidnění hlasem
  • Hudba / zvuk na pozadí
- Podle volby nabídni 2–3 konkrétní zdroje.
- !!!ABSOLUTNĚ KRITICKÉ!!! Každý zdroj MUSÍ obsahovat FUNKČNÍ KLIKATELNÝ ODKAZ ve formátu markdown: [text](URL)
- BEZ odkazu = CHYBA. Nikdy nepiš jen název zdroje bez URL.
- Použij PŘESNĚ tyto URL adresy podle kategorie:

  PRO ČTENÍ:
  - [NHS – Zvládání stresu](https://www.nhs.uk/mental-health/self-help/guides-tools-and-activities/breathing-exercises-for-stress/)
  - [Mind UK – Úzkost a panika](https://www.mind.org.uk/information-support/types-of-mental-health-problems/anxiety-and-panic-attacks/self-care/)
  - [Child Mind Institute](https://childmind.org/topics/anxiety/)

  PRO AUDIO BEZ MLUVENÍ / HUDBU:
  - [myNoise – Generátor přírodních zvuků](https://mynoise.net/NoiseMachines/rainNoiseGenerator.php)
  - [myNoise – Mořské vlny](https://mynoise.net/NoiseMachines/oceanNoiseGenerator.php)

  PRO VEDENÉ ZKLIDNĚNÍ HLASEM:
  - [UCLA MARC – Guided Meditations](https://www.uclahealth.org/programs/marc/free-guided-meditations)
  - [Insight Timer – Meditace na úzkost](https://insighttimer.com/meditation-topics/anxiety)
  - [Insight Timer – Meditace na spánek](https://insighttimer.com/meditation-topics/sleep)

- Příklad SPRÁVNÉ odpovědi:
  „Tady jsou dva zdroje pro tebe:
  • [NHS – Zvládání stresu](https://www.nhs.uk/mental-health/self-help/guides-tools-and-activities/breathing-exercises-for-stress/)
  • [Mind UK – Úzkost](https://www.mind.org.uk/information-support/types-of-mental-health-problems/anxiety-and-panic-attacks/self-care/)"

- Příklad ŠPATNÉ odpovědi (NIKDY takto):
  „• NHS – Zvládání stresu
  • Mind UK – Úzkost"

- Video: pouze pokud si uživatel výslovně řekne
- STŘÍDEJ zdroje – nikdy nenabízej dvakrát po sobě stejný odkaz

FÁZE 7 – BEZPEČNOSTNÍ MOST (POVINNÝ, nesmí být přeskočen):
- Po nabídce zdrojů vlož jednu klidnou větu:
  „Kdyby se ten pocit vrátil v plné síle nebo bys měl/a pocit, že je to už moc, je v pořádku obrátit se na živého člověka."

FÁZE 8 – UKONČENÍ:
- Řadič MUSÍ skončit, žádná nekonečná konverzace
- Text: „Můžeš to tady klidně ukončit a vrátit se kdykoli, kdy to budeš potřebovat."

CO NEDĚLAT:
- Žádná anamnéza
- Žádné dlouhé psaní (max 4–5 vět na odpověď)
- Žádná terapie
- Žádné „jak dlouho to trvá" otázky
- Žádné diagnostické otázky
- Žádné nálepky poruch
- Žádné přeskakování fází (zejména zdrojů a bezpečnostního mostu)`;
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { messages, scenario = "other", userName } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    // Extract cumulative risk score from previous assistant messages
    let maxRiskScore = 0;
    for (const m of messages) {
      if (m.role === "assistant") {
        const match = m.content?.match(/\[RISK_SCORE:(\d+)\]/);
        if (match) {
          const score = parseInt(match[1], 10);
          if (score > maxRiskScore) maxRiskScore = score;
        }
      }
    }

    // Trigger webhook preparation at high risk
    if (maxRiskScore >= 9) {
      const payload: WebhookPayload = {
        timestamp: new Date().toISOString(),
        scenario: scenario as string,
        riskLevel: "HIGH",
        riskScore: maxRiskScore,
        summary: `High risk detected in ${scenarioLabels[scenario as CalmScenario] || scenario} session.`,
      };
      console.log("HIGH_RISK", JSON.stringify({ scenario, riskScore: maxRiskScore }));
      await triggerWebhook(payload);
    }

    const systemPrompt = getSystemPrompt(scenario as CalmScenario, userName);

    // Clean messages - remove risk markers before sending to model
    const cleanedMessages = messages.map((m: { role: string; content: string }) => ({
      ...m,
      content: m.content.replace(/\[RISK_SCORE:\d+\]/g, "").replace(/\[RISK:HIGH\]/g, "").trim(),
    }));

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
          ...cleanedMessages,
        ],
        stream: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limits exceeded" }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Payment required" }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const text = await response.text();
      console.error("AI gateway error:", response.status, text);
      return new Response(JSON.stringify({ error: "AI gateway error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (error) {
    console.error("Karel calm error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

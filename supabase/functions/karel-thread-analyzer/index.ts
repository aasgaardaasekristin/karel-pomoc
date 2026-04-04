import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { SYSTEM_RULES } from "../_shared/system-rules.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const THREAD_ANALYSIS_PROMPT = SYSTEM_RULES + `\n\nJsi Karel – AI vedoucí terapeutického týmu pro DID systém.
Tvým úkolem je analyzovat vlákna (rozhovory DID části s Karlem) a roztřídit informace do sekcí A-M kartotéky.

## PRAVIDLA ENTITY SEPARACE
- Hanka, Káťa = terapeutky, NEJSOU DID části.
- Locík = pes, NENÍ DID část.
- Amálka, Tonička = biologické děti, NEJSOU DID části.
- Jiří = partner, NENÍ DID část.
- Karel = AI asistent, NENÍ DID část.

## INSTRUKCE

1. Přečti chronologicky všechny zprávy od části (ne od Karla/asistenta).
2. Pro každou zprávu extrahuj:
   - emocionální stav
   - zmíněné osoby/části (vztahy)
   - zmíněné aktivity/zájmy
   - zmíněné strachy/obavy
   - zmíněné konflikty
   - přání části
   - explicitní žádosti ("dej do deníku", "řekni Haničce")
   - obranné mechanismy
   - triggery
   - pokrok/regres oproti předchozímu stavu
   - skryté/podvědomé motivy (psychoanalytický rozbor)

3. Každou extrahovanou poznámku zařaď do sekcí:

**A (Identita a aktuální stav):**
- aktualni_stav, povedomi_o_systemu_a_role, vztahy, co_ho_uklidnuje, ochranne_mechanismy

**B (Psychologický profil):**
- aktualni_stav, psychologicke_charakteristiky, psychologicka_profilace, obranne_mechanismy, reakce_na_kontakt

**C (Potřeby a rizika):**
- jadrove_potreby, jadrove_strachy, triggery, vnitrni_konflikty, identifikovana_rizika

**D (Terapeutická doporučení):**
- doporuceni

**E (Časová osa):**
- zaznam

**F (Plánování):**
- plan

**G (Deník):**
- denik (POUZE pokud část explicitně žádá "dej do deníku")

**H (Dlouhodobé cíle):**
- cile

**I (Terapeutické metody):**
- metody

**J (Priority a intervence):**
- priority, krizove_situace

**K (Zpětná vazba):**
- zpetna_vazba

**L (Aktivita):**
- aktivita

**M (Poznámky):**
- poznamky

4. Pro každou poznámku urči typ akce:
- "add" = nová informace
- "replace" = nahrazuje zastaralou informaci (uveď co nahrazuje)
- "annotate" = doplňuje existující informaci komentářem
- "delete" = informace již neplatí

5. VŽDY porovnej s aktuální kartou – pokud informace tam už je a je aktuální, NEVYTVÁŘEJ update.

## BEZPEČNOSTNÍ PRAVIDLA
- NIKDY nezařazuj osobní emoce terapeutek do karty DID části.
- NIKDY nepoužívej intimní oslovení.
- Kvůli epilepsii NENAVRHUJ dechová cvičení.
- Pokud část zmiňuje terapeutku, záznam patří do sekce A (vztahy) NIKOLIV do profilace terapeutky.

## VÝSTUPNÍ FORMÁT

Vrať POUZE validní JSON pole objektů (bez markdown fences):
[
  {
    "section": "A",
    "subsection": "aktualni_stav",
    "type": "replace",
    "content": "Tundrupek se dnes cítí nejistě, zmiňuje strach z toho, že na něj zapomenou.",
    "sourceDate": "2026-03-26",
    "reasoning": "Část explicitně vyjádřila obavy z opuštění, což nahrazuje předchozí stav 'stabilní nálada'."
  }
]

Pokud z vláken nevyplývají žádné nové informace pro danou sekci, nevytvářej pro ni žádný záznam.
Buď precizní. Každý update musí mít jasné zdůvodnění (reasoning).`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { partId, threads, currentCard } = await req.json();

    if (!partId || !Array.isArray(threads) || threads.length === 0) {
      return new Response(
        JSON.stringify({ error: "Missing partId or threads" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    // Serializuj vlákna do čitelného formátu pro AI
    const threadsText = threads
      .map((t: any, i: number) => {
        const msgs = (t.messages || [])
          .map((m: any) => `[${m.role}] ${m.content}`)
          .join("\n");
        return `--- Vlákno ${i + 1} (${t.last_activity_at || "?"}, label: ${t.thread_label || "bez názvu"}) ---\n${msgs}`;
      })
      .join("\n\n");

    // Serializuj aktuální kartu
    const cardText = currentCard && Object.keys(currentCard).length > 0
      ? Object.entries(currentCard)
          .map(([k, v]) => `=== SEKCE ${k} ===\n${v}`)
          .join("\n\n")
      : "(Karta je prázdná nebo nedostupná)";

    const userPrompt = `## ČÁST: ${partId}

## AKTUÁLNÍ KARTA:
${cardText}

## VLÁKNA K ANALÝZE:
${threadsText}

Analyzuj vlákna a vrať JSON pole updatů pro kartotéku.`;

    console.log(`[ThreadAnalyzer] Analyzing ${threads.length} threads for ${partId}, prompt ~${userPrompt.length} chars`);

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: THREAD_ANALYSIS_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error(`[ThreadAnalyzer] AI gateway error ${aiResponse.status}:`, errText);

      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResponse.status === 402) {
        return new Response(JSON.stringify({ error: "Payment required" }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      throw new Error(`AI gateway error: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    const rawContent = aiData.choices?.[0]?.message?.content ?? "[]";

    // Parsuj JSON – odstraň markdown fences pokud AI je vrátí
    let cleaned = rawContent.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "").trim();
    }

    let updates: any[];
    try {
      updates = JSON.parse(cleaned);
    } catch {
      console.error("[ThreadAnalyzer] Failed to parse AI response as JSON:", cleaned.slice(0, 500));
      updates = [];
    }

    if (!Array.isArray(updates)) {
      console.warn("[ThreadAnalyzer] AI response is not an array, wrapping...");
      updates = [];
    }

    // Validace každého updatu
    const validSections = new Set(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"]);
    const validActions = new Set(["add", "replace", "annotate", "delete"]);

    const validated = updates.filter((u: any) => {
      if (!u || typeof u !== "object") return false;
      if (!validSections.has(u.section)) return false;
      if (!validActions.has(u.type)) return false;
      if (!u.content || typeof u.content !== "string") return false;
      return true;
    });

    console.log(`[ThreadAnalyzer] ${partId}: ${validated.length}/${updates.length} valid updates`);

    return new Response(JSON.stringify({ updates: validated }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[ThreadAnalyzer] Error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

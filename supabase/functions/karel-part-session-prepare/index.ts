/**
 * karel-part-session-prepare — v1 (2026-04-22)
 *
 * První funkční verze "Karel + část room" (herna).
 *
 * NEZAKLÁDÁ NOVÝ DATOVÝ MODEL. Sedí přímo na did_threads:
 *   sub_mode       = "karel_part_session"
 *   workspace_type = "session"
 *   workspace_id   = "kps_<part>_<YYYY-MM-DD>"   ← jeden room na část/den
 *
 * Vstup:
 *   { part_name: string, briefing_proposed_session?: object }
 *
 * Výstup (idempotentní):
 *   { thread_id: string, created: boolean }
 *
 * Při prvním otevření Karel vygeneruje strukturovaný program 60-min sezení
 * (cíl, bezpečný rámec, 4-5 herních bloků, pomůcky, časování) jako úvodní
 * assistant zprávu. Druhý klik vrací existující thread bez AI volání.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

function pragueTodayISO(): string {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Prague" }));
  return d.toISOString().slice(0, 10);
}

async function generateProgram(partName: string, briefingHint: any): Promise<string> {
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) {
    return defaultProgram(partName);
  }

  // KAREL+ČÁST IN DNES TRUTH PASS (2026-04-22):
  //   Hint nyní obsahuje volitelný `therapist_addendum` — krátký vstup
  //   od Haničky / Káti přímo z karty `Sezení s Karlem` v `Dnes`. Karel
  //   ho musí zahrnout do dnešního programu (ne ignorovat).
  const addendum = briefingHint?.therapist_addendum?.toString().trim();
  const hintLines = briefingHint
    ? [
        `Z dnešního schváleného plánu vyplývá:`,
        `- Proč dnes: ${briefingHint.why_today || "—"}`,
        `- První pracovní verze plánu (schválená poradou):\n${briefingHint.first_draft || "—"}`,
        `- Délka: ${briefingHint.duration_min || 60} min`,
        `- Vede / kdo dohlíží: ${briefingHint.led_by || "Hanička"}`,
      ]
    : [`Bez briefing-hintu — vytvoř obecný program odpovídající části.`];

  if (addendum) {
    hintLines.push("");
    hintLines.push(`---`);
    hintLines.push(`DOPLNĚNÍ TERAPEUTKY (těsně před vstupem do herny — máš to bezpodmínečně zahrnout):`);
    hintLines.push(addendum);
  }

  const hintText = hintLines.join("\n");

  try {
    const res = await fetch(AI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content: `Jsi Karel — esence C. G. Junga, traumaterapeut. Připravuješ dnešní pracovní sezení s částí "${partName}" v "herně" (Karel + část room).

Pravidla:
- Bezpečný, hravý rámec. Diagnostické a terapeutické kroky musí být schované do her a aktivit.
- Min. 60 minut struktury, 4–5 bloků.
- Žádná teorie, žádný klinický žargon směrem k části.
- Každý blok: název, cíl (co chci pozorovat / posunout), aktivita / hra (jak), pomůcky, časování.
- Závěr: rituál uzavření, předání zpět.
- Pokud jsi dostal/a DOPLNĚNÍ TERAPEUTKY, MUSÍŠ ho viditelně zohlednit (např. v úvodu, v jednom z bloků, nebo v rámci bezpečnostního nastavení).

Vrať POUZE markdown text (žádný JSON, žádný code-fence). Začni krátkým úvodem (cíl celku, bezpečný rámec), pak bloky 1.–5., pak Závěr.`,
          },
          { role: "user", content: hintText },
        ],
      }),
    });

    if (!res.ok) {
      console.warn("[part-session-prepare] AI status", res.status);
      return defaultProgram(partName);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content?.trim();
    return content || defaultProgram(partName);
  } catch (e) {
    console.warn("[part-session-prepare] AI error:", e);
    return defaultProgram(partName);
  }
}

function defaultProgram(partName: string): string {
  return `**Dnešní sezení s ${partName}** — herna Karel + ${partName}

**Cíl celku:** bezpečné setkání, ověření aktuálního stavu, malý posun.
**Bezpečný rámec:** sedíme spolu, není kam spěchat. Když budeš chtít, můžeš kdykoliv říct "stop".

---

**Blok 1 — Příchod (10 min)**
- Cíl: zklidnit, naladit
- Aktivita: krátký rituál pozdravu, dech
- Pomůcky: žádné

**Blok 2 — Hra na bezpečné místo (15 min)**
- Cíl: ověřit, jak je dnes na tom regulace
- Aktivita: představ si nebo nakresli místo, kde se cítíš dobře
- Pomůcky: papír, pastelky

**Blok 3 — Pracovní hra (15 min)**
- Cíl: jemná diagnostika aktuálního tématu (bez tlaku)
- Aktivita: vybereme spolu jednu věc, kterou si dnes zahrajeme

**Blok 4 — Tělo a klid (10 min)**
- Cíl: regulace
- Aktivita: jemné protažení, dech, krátká meditace v bezpečném místě

**Blok 5 — Závěr (10 min)**
- Cíl: uzavřít, předat zpět
- Aktivita: shrneme, co se dnes povedlo. Krátké rozloučení.`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const sb = createClient(supabaseUrl, srvKey);

  try {
    const body = await req.json();
    const partName: string = (body.part_name || "").trim();
    if (!partName) return jsonRes({ error: "part_name required" }, 400);

    const briefingHint = body.briefing_proposed_session || null;

    const today = pragueTodayISO();
    const dayStart = `${today}T00:00:00.000Z`;
    const dayEnd = `${today}T23:59:59.999Z`;

    // 1) Idempotent lookup — match by sub_mode + part_name + day window.
    // (workspace_id je UUID, takže nemůžeme použít deterministický string.
    //  Místo toho dedupe-ujeme přes (sub_mode, part_name, started_at::date).)
    const existing = await sb
      .from("did_threads")
      .select("id, started_at")
      .eq("sub_mode", "karel_part_session")
      .ilike("part_name", partName)
      .gte("started_at", dayStart)
      .lte("started_at", dayEnd)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing.data?.id) {
      return jsonRes({ thread_id: existing.data.id, created: false });
    }

    // 2) Resolve user_id (single-tenant fallback)
    const { data: anyThread } = await sb
      .from("did_threads")
      .select("user_id")
      .not("user_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const userId = anyThread?.user_id ?? null;

    // 3) Generate program (AI or fallback)
    const program = await generateProgram(partName, briefingHint);

    const dateLabel = new Date().toLocaleDateString("cs-CZ", { day: "numeric", month: "long" });
    const threadLabel = `Herna Karel + ${partName} · ${dateLabel}`;

    const opener = `🎲 **${threadLabel}**\n\nVítej v dnešní herně. Připravil jsem pro nás program — můžeme jím jít po pořádku, nebo si vybrat. Nic není povinné.\n\n---\n\n${program}`;

    // 4) Insert thread (workspace_type/_id nepoužíváme — UUID by neumělo
    //    deterministický string. Idempotenci hlídáme přes lookup výše.)
    const insertPayload: any = {
      part_name: partName,
      sub_mode: "karel_part_session",
      part_language: "cs",
      messages: [{ role: "assistant", content: opener }],
      last_activity_at: new Date().toISOString(),
      is_processed: false,
      thread_label: threadLabel,
      thread_emoji: "🎲",
    };
    if (userId) insertPayload.user_id = userId;

    const { data: created, error: insErr } = await sb
      .from("did_threads")
      .insert(insertPayload)
      .select("id")
      .single();

    if (insErr) {
      console.error("[part-session-prepare] insert error:", insErr);
      return jsonRes({ error: insErr.message }, 500);
    }

    console.log(`[part-session-prepare] created room ${created.id} for ${partName} (date=${today})`);
    return jsonRes({ thread_id: created.id, created: true });
  } catch (e) {
    console.error("[part-session-prepare] fatal:", e);
    return jsonRes({ error: String(e) }, 500);
  }
});

function jsonRes(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

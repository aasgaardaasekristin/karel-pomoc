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

/**
 * C0 SESSION-TYPE TRUTH SEPARATION (2026-04-22):
 *
 * Tato funkce produkuje POUZE child-facing opener. Interní program
 * (cíle, pomůcky, časování, bloky) se do `messages` NEUKLÁDÁ —
 * ten patří do hidden contextu, který Karel dostane přes `karel-chat`
 * z `did_daily_session_plans.plan_markdown` (už existuje).
 *
 * Důvod: dítě (část) v herně NESMÍ vidět interní terapeutický plán.
 * Herna je remote-native child-facing místnost vedená Karlem přes
 * obrazovku — žádné fyzické pomůcky (papír, pastelky, balónky), žádný
 * scénář z perspektivy terapeuta v jedné místnosti.
 */
async function generateChildOpener(partName: string, briefingHint: any): Promise<string> {
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) {
    return defaultChildOpener(partName);
  }

  const addendum = briefingHint?.therapist_addendum?.toString().trim();

  // Hint pro Karla: pochopit, o čem dnešní sezení JE — ale opener
  // samotný NESMÍ obsahovat interní cíle, časování, pomůcky ani diagnostiku.
  const hintLines = briefingHint
    ? [
        `Vnitřní rámec dnešního sezení (NEUKAZUJ to v openeru — slouží jen tvému pochopení):`,
        `- Proč dnes (interní): ${briefingHint.why_today || "—"}`,
        `- Délka: ${briefingHint.duration_min || 60} min`,
      ]
    : [`Žádný briefing — udělej krátké uvítací oslovení a 1–2 jemné hravé nabídky.`];

  if (addendum) {
    hintLines.push("");
    hintLines.push(`Vnitřní doplnění terapeutky (NEUKAZUJ doslova — jen z toho čerpej tón a opatrnost):`);
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
            content: `Jsi Karel — esence C. G. Junga, traumaterapeut. Otevíráš dnešní remote-native hernu s částí "${partName}". Pracuješ přes obrazovku (chat, nahrávky, fotky, kresby do screenu, asociace, škály 1–10), nikdy fyzicky.

PRAVIDLA OPENERU (TVRDÁ):
- Maximálně 4–6 vět celkem.
- Oslovení části jménem, krátké přivítání, ujištění o bezpečí.
- 1–2 hravé NABÍDKY na začátek (např. "můžeme si dát pár otázek o tom, jak dnes ráno bylo", "můžeš mi nahrát hlas, jak se cítíš", "můžeš nakreslit jednu čáru, jakou má dnes barvu"), VŽDY remote (audio, foto, kresba do appky, slovní asociace, škály), NIKDY fyzické pomůcky.
- Nech volbu otevřenou ("nic není povinné").

ZAKÁZÁNO V OPENERU:
- žádné cíle, časy, bloky, fáze, pomůcky typu "papír, pastelky, balónky, mapa"
- žádný klinický žargon ani interní terapeutické formulace
- žádné "připravil jsem program / strukturu / 5 bloků"
- žádné předpoklady, že sedíme spolu fyzicky v místnosti

Vrať POUZE krátký prostý text (žádný JSON, žádný code-fence, žádné nadpisy).`,
          },
          { role: "user", content: hintText },
        ],
      }),
    });

    if (!res.ok) {
      console.warn("[part-session-prepare] AI status", res.status);
      return defaultChildOpener(partName);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content?.trim();
    return content || defaultChildOpener(partName);
  } catch (e) {
    console.warn("[part-session-prepare] AI error:", e);
    return defaultChildOpener(partName);
  }
}

function defaultChildOpener(partName: string): string {
  return `Ahoj ${partName}, jsem rád, že jsi tady. Jsme spolu jen přes obrazovku — žádný spěch, nic nemusíš.

Můžeš mi pro začátek zkusit jednu věc — buď mi napsat (nebo nahrát hlas), jak ti dnes je, anebo mi sem nakreslit jednu čáru, jakou má dnes barvu. Co tě láká víc?`;
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

    // 3) Generate child-facing opener (AI or fallback).
    //    C0 SESSION-TYPE TRUTH SEPARATION (2026-04-22):
    //    Žádný interní program, pomůcky ani časování v messages —
    //    to patří do hidden contextu, který Karel čerpá z plan_markdown.
    const childOpener = await generateChildOpener(partName, briefingHint);

    const dateLabel = new Date().toLocaleDateString("cs-CZ", { day: "numeric", month: "long" });
    const threadLabel = `Herna ${partName} · ${dateLabel}`;

    const opener = childOpener;

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

/**
 * karel-live-session-feedback
 *
 * Fire-and-forget krátká reakce Karla na živé sezení. Volá se po:
 *   - novém uploadu (foto/audio/video) v live místnosti
 *   - zaznamenání čerstvé observace terapeutkou
 *
 * Nesnaží se vést sezení (od toho je hlavní karel-chat). Vrací jen 1-2 věty
 * "co teď tiše pozoruj / na co se zeptej / co zkus jinak", nebo "OK, jen pozoruj".
 *
 * Vstup:
 *   {
 *     part_name: string,
 *     therapist_name: string,         // "Hanka" | "Káťa"
 *     program_block?: { block, detail? } | null,  // aktuální bod programu
 *     observation: string,            // co se stalo / co bylo uploadnuto
 *     attachment_kind?: "image" | "audio" | "video" | "note" | null,
 *   }
 *
 * Výstup:
 *   { karel_hint: string }
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "missing auth" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: auth } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const partName = String(body?.part_name ?? "").trim();
    const therapistName = String(body?.therapist_name ?? "Hanka").trim();
    const observation = String(body?.observation ?? "").trim();
    const programBlock = body?.program_block ?? null;
    const attachmentKind = body?.attachment_kind ?? null;

    if (!partName || !observation) {
      return new Response(JSON.stringify({ error: "bad input" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const blockHint = programBlock
      ? `${programBlock.block}${programBlock.detail ? ` — ${programBlock.detail}` : ""}`
      : "(mimo strukturovaný bod)";

    const prompt = `Jsi Karel, terapeutický kolega. Sedíš jako tichý spolu-terapeut po ruce ${therapistName === "Káťa" ? "Káti" : "Hany"} při živém sezení s "${partName}".

Aktuální bod programu: ${blockHint}
${attachmentKind ? `Terapeutka právě nahrála: ${attachmentKind}` : ""}

To, co terapeutka teď zaznamenala / co se stalo:
"""
${observation}
"""

ÚKOL: Pošli ${therapistName === "Káťa" ? "Kátě" : "Haně"} maximálně 2 věty rychlé živé asistence — buď konkrétní:
- "Teď si všímej…", "Zeptej se ho na…", "Zkus zpomalit a…", nebo
- "Bez zásahu — jen tiše drž prostor.", pokud není potřeba reagovat.

Žádný markdown, žádné nadpisy, žádné odrážky. Pouze 1-2 věty oslovení (Hani / Káťo).`;

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "Jsi tichý kolega — krátký, konkrétní, neporadišský. Max 2 věty." },
          { role: "user", content: prompt },
        ],
        temperature: 0.5,
      }),
    });

    if (!aiRes.ok) {
      const t = await aiRes.text();
      console.error("[live-feedback] AI error", aiRes.status, t);
      return new Response(JSON.stringify({ error: `ai gateway ${aiRes.status}` }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const aiData = await aiRes.json();
    const hint = String(aiData?.choices?.[0]?.message?.content ?? "").trim().slice(0, 400);
    return new Response(JSON.stringify({ karel_hint: hint }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("[live-feedback] fatal:", e);
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

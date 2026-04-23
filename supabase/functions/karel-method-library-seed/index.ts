/**
 * karel-method-library-seed
 * --------------------------
 * Jednorázová idempotentní seed funkce.
 * Naimportuje 9 hardcoded playbooků z _shared/clinicalPlaybooks.ts
 * do tabulky karel_method_library jako created_by='seed', status='seed'.
 *
 * Bezpečné spustit opakovaně — duplicity přeskočí (UNIQUE method_key).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  playbook_association_experiment_jung,
  playbook_draw_a_person_machover,
  playbook_tree_test_koch,
  playbook_htp_buck,
  playbook_kfd_burns,
  playbook_narrative_cat,
  playbook_sandtray_lowenfeld,
  playbook_body_map,
  playbook_safe_place,
  type Playbook,
} from "../_shared/clinicalPlaybooks.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type SeedRow = {
  method_key: string;
  title: string;
  category: string;
  age_range: string | null;
  manual_md: string;
  sources: string[];
  tags: string[];
  contraindications: string;
};

function playbookToManualMd(p: Playbook): string {
  const setup = p.pre_session_setup;
  return `# ${p.method_label}

## Zdroje
${p.source_refs.map((s) => `- ${s}`).join("\n")}

## Setup
**Pomůcky:**
${setup.supplies.map((s) => `- ${s}`).join("\n")}

**Místnost:** ${setup.room}
**Pozice terapeutky:** ${setup.therapist_position}
**Pozice dítěte:** ${setup.child_position}

**Úvodní instrukce:**
${setup.what_to_say_first}

**Co NIKDY neříkat:**
${setup.what_NOT_to_say.map((s) => `- ${s}`).join("\n")}

**Co měřit/zapisovat každý turn:**
${setup.measurements_required.map((s) => `- ${s}`).join("\n")}

## Průběh
**Typ:** ${p.step_protocol.kind}
${p.step_protocol.planned_steps ? `**Plánované kroky:** ${p.step_protocol.planned_steps.join(", ")}\n` : ""}
**Instrukce:** ${p.step_protocol.instruction}

**Co zaznamenávat:**
${p.step_protocol.what_to_record.map((s) => `- ${s}`).join("\n")}

**Red flags:**
${p.step_protocol.red_flags.map((s) => `- ${s}`).join("\n")}

## Trauma protokol
**Známky:**
${p.trauma_response_protocol.signs.map((s) => `- ${s}`).join("\n")}

**Okamžité akce:**
${p.trauma_response_protocol.immediate_actions.map((s) => `- ${s}`).join("\n")}

**Opakovat stimul po reakci:** ${p.trauma_response_protocol.do_not_repeat_stimulus ? "❌ NIKDY" : "✓ pouze opatrně"}

**Grounding skript:**
${p.trauma_response_protocol.grounding_script}

## Závěr
${p.closure_protocol.reproduction_check ? `**Reprodukční kontrola:** ${p.closure_protocol.reproduction_check}\n` : ""}
**Debrief otázky:**
${p.closure_protocol.debrief_questions.map((s) => `- ${s}`).join("\n")}

**Grounding na konci:** ${p.closure_protocol.grounding}

## Povinné artefakty
${p.required_artifacts.map((s) => `- ${s}`).join("\n")}

## ⚠️ Kontraindikace
- Pacient má EPILEPSII — žádná dechová cvičení, žádná hyperventilace, žádné zadržování dechu
- Při disociativní pauze NIKDY netlačit
- Při flashbacku přerušit a uzemnit
`;
}

function categorize(method_id: string): string {
  if (method_id.includes("association") || method_id.includes("draw") || method_id.includes("htp") || method_id.includes("tree") || method_id.includes("kfd") || method_id.includes("narrative")) return "diagnostika";
  if (method_id.includes("sandtray")) return "diagnostika";
  if (method_id.includes("body_map")) return "trauma";
  if (method_id.includes("safe_place")) return "stabilizace";
  return "diagnostika";
}

function tagsFor(method_id: string): string[] {
  const t: string[] = [];
  if (method_id.includes("draw") || method_id.includes("tree") || method_id.includes("htp") || method_id.includes("kfd")) t.push("projektivní", "kresba", "neverbální");
  if (method_id.includes("association")) t.push("verbální", "projektivní", "Jung");
  if (method_id.includes("narrative")) t.push("narativní", "verbální");
  if (method_id.includes("sandtray")) t.push("hra", "projektivní", "neverbální");
  if (method_id.includes("body_map")) t.push("somatic", "trauma-informed");
  if (method_id.includes("safe_place")) t.push("imaginace", "stabilizace");
  return t;
}

function toRow(p: Playbook): SeedRow {
  return {
    method_key: p.method_id,
    title: p.method_label,
    category: categorize(p.method_id),
    age_range: "5-18",
    manual_md: playbookToManualMd(p),
    sources: p.source_refs,
    tags: tagsFor(p.method_id),
    contraindications:
      "EPILEPSIE — žádná dechová cvičení ani hyperventilace. Při flashbacku okamžitě přerušit a uzemnit přes smysly (5-4-3-2-1), ne dech.",
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const playbooks: Playbook[] = [
      playbook_association_experiment_jung,
      playbook_draw_a_person_machover,
      playbook_tree_test_koch,
      playbook_htp_buck,
      playbook_kfd_burns,
      playbook_narrative_cat,
      playbook_sandtray_lowenfeld,
      playbook_body_map,
      playbook_safe_place,
    ];

    const results: Array<{ method_key: string; status: string; error?: string }> = [];

    for (const p of playbooks) {
      const row = toRow(p);
      const { data: existing } = await supabase
        .from("karel_method_library")
        .select("id, status")
        .eq("method_key", row.method_key)
        .maybeSingle();

      if (existing) {
        results.push({ method_key: row.method_key, status: "already_exists" });
        continue;
      }

      const { error } = await supabase.from("karel_method_library").insert({
        ...row,
        created_by: "seed",
        status: "seed",
      });
      if (error) {
        results.push({ method_key: row.method_key, status: "error", error: error.message });
      } else {
        results.push({ method_key: row.method_key, status: "seeded" });
      }
    }

    const seeded = results.filter((r) => r.status === "seeded").length;
    const skipped = results.filter((r) => r.status === "already_exists").length;
    const errored = results.filter((r) => r.status === "error").length;

    return new Response(
      JSON.stringify({
        ok: true,
        summary: { total: playbooks.length, seeded, skipped, errored },
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("seed error:", e);
    return new Response(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "Unknown" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

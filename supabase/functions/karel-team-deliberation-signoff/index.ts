/**
 * karel-team-deliberation-signoff
 *
 * Podepíše poradu jménem Karla, Haničky nebo Káti.
 * Po trojnásobném podpisu DB trigger automaticky překlopí status na `approved`.
 * Pokud je `deliberation_type = session_plan`, navíc propíše Karlův
 * schválený plán do `did_daily_session_plans` a nastaví `linked_live_session_id`.
 *
 * Vstup:
 *   { deliberation_id: string, signer: "hanka" | "kata" | "karel" }
 */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

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
    const userId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const deliberationId = String(body?.deliberation_id ?? "");
    const signer = String(body?.signer ?? "");
    if (!deliberationId || !["hanka", "kata", "karel"].includes(signer)) {
      return new Response(JSON.stringify({ error: "bad input" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Fetch row
    const { data: row, error: fetchErr } = await admin
      .from("did_team_deliberations")
      .select("*")
      .eq("id", deliberationId)
      .eq("user_id", userId)
      .maybeSingle();
    if (fetchErr || !row) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GATE: pro typ `crisis` smí Karel podepsat JEN pokud existuje
    // explicitní karel_synthesis (viz karel-team-deliberation-synthesize).
    // Kontrola PŘED updatem, aby se trigger autoderive_status nespouštěl
    // s falešným karel_signed_at, který bychom museli rollbackovat.
    if (
      signer === "karel" &&
      row.deliberation_type === "crisis" &&
      !row.karel_synthesis
    ) {
      return new Response(JSON.stringify({
        error: "synthesis_required",
        message: "Karel nemůže podepsat krizovou poradu, dokud neproběhne syntéza odpovědí terapeutek. Spusť nejdřív „Spustit Karlovu syntézu“.",
      }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (signer === "karel" && row.deliberation_type === "crisis") {
      const subjectPart = (row.subject_parts ?? [])[0] ?? null;
      let crisisEventId: string | null = row.linked_crisis_event_id ?? null;
      if (!crisisEventId && subjectPart) {
        const { data: openEv } = await admin
          .from("crisis_events")
          .select("id")
          .eq("part_name", subjectPart)
          .is("closed_at", null)
          .order("opened_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (openEv?.id) crisisEventId = openEv.id;
      }

      let crisisAlertId: string | null = null;
      if (subjectPart) {
        const { data: openAlert } = await admin
          .from("crisis_alerts")
          .select("id")
          .eq("part_name", subjectPart)
          .in("status", ["ACTIVE", "ACKNOWLEDGED", "active", "acknowledged"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (openAlert?.id) crisisAlertId = openAlert.id;
      }

      if (!crisisEventId || !crisisAlertId) {
        return new Response(JSON.stringify({
          error: "crisis_linkage_required",
          message: `Karel nemůže uzavřít krizovou poradu bez navázaného crisis_event a crisis_alert pro část \"${subjectPart ?? "(neurčeno)"}\".`,
          missing: {
            crisis_event_id: !crisisEventId,
            crisis_alert_id: !crisisAlertId,
          },
        }), {
          status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const nowIso = new Date().toISOString();
    const patch: Record<string, any> = {};
    if (signer === "hanka" && !row.hanka_signed_at) patch.hanka_signed_at = nowIso;
    if (signer === "kata" && !row.kata_signed_at) patch.kata_signed_at = nowIso;
    if (signer === "karel" && !row.karel_signed_at) patch.karel_signed_at = nowIso;

    if (Object.keys(patch).length === 0) {
      return new Response(JSON.stringify({ deliberation: row, note: "already signed" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: updated, error: updErr } = await admin
      .from("did_team_deliberations")
      .update(patch)
      .eq("id", deliberationId)
      .select("*")
      .single();

    if (updErr) {
      return new Response(JSON.stringify({ error: updErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // BRIDGE: if approved + session_plan → push do did_daily_session_plans
    //
    // HARDENING (Slice 3 stabilizace): bridge MUSÍ vycházet ze schváleného
    // obsahu deliberation, ne z hardcoded "hanka/individual". Autoritativní
    // zdroj parametrů je `session_params` jsonb sloupec naplněný při create
    // přímo z briefing prefillu (led_by, session_format, duration_min, …).
    // Fallback řetězec použijeme jen když deliberation z nějakého důvodu
    // session_params nemá (legacy záznamy před touto migrací).
    let bridgedPlanId: string | null = updated.linked_live_session_id ?? null;
    let crisisEffects: Record<string, any> = {};
    if (
      updated.status === "approved" &&
      updated.deliberation_type === "session_plan" &&
      !updated.linked_live_session_id
    ) {
      const today = new Date().toISOString().slice(0, 10);

      const sp = (updated.session_params && typeof updated.session_params === "object")
        ? updated.session_params as Record<string, any>
        : {};

      // Mapování led_by → DB hodnoty, KTERÉ UI rozumí.
      // DidDailySessionPlan.tsx PlanCardProps.leadLabel mapuje:
      //   session_lead = "obe" → "Hanka + Káťa"
      //   session_lead = "kata" → "Káťa"
      //   session_lead = "all" + session_format = "crisis_intervention" → krizový label
      //   jinak fallback "Hanka" (toto je přesně hardcoded bug, kterému se vyhýbáme).
      // Proto pro „společně“ používáme `obe`, ne neznámé „joint“.
      const ledByRaw = String(sp.led_by ?? "").trim();
      const ledByLower = ledByRaw.toLowerCase();
      let therapist: string;
      let sessionLead: string;
      let sessionFormatDefault: string;
      if (ledByLower.startsWith("ha")) {
        therapist = "hanka"; sessionLead = "hanka"; sessionFormatDefault = "osobně";
      } else if (ledByLower.startsWith("ká") || ledByLower.startsWith("ka")) {
        therapist = "kata"; sessionLead = "kata"; sessionFormatDefault = "chat";
      } else if (ledByLower.startsWith("sp")) {
        therapist = "hanka"; sessionLead = "obe"; sessionFormatDefault = "kombinované";
      } else {
        // Bez explicitního vůdce: nezakrýváme to, ale UI musí umět zobrazit.
        // Použijeme defaulty, které UI nerozbijí, a označíme to v urgency_breakdown.
        therapist = "hanka"; sessionLead = "hanka"; sessionFormatDefault = "osobně";
      }

      // Pokud prefill přidal session_format explicitně, respektujeme jej; jinak
      // bereme default odvozený z led_by. Hodnoty držíme v cs slovníku UI.
      const spFmt = String(sp.session_format ?? "").trim();
      const sessionFormat = spFmt === "individual" ? "osobně"
        : spFmt === "joint" ? "kombinované"
        : (spFmt || sessionFormatDefault);

      const part = String(sp.part_name ?? updated.subject_parts?.[0] ?? "").trim();

      // Agenda + otázky vypíšeme do plan_markdown, ať je z denního plánu vidět
      // celý schválený obsah, ne jen stručný brief.
      const agendaLines: string[] = [];
      const agenda = Array.isArray(updated.agenda_outline) ? updated.agenda_outline : [];
      if (agenda.length > 0) {
        agendaLines.push("## Osnova");
        agenda.forEach((b: any, i: number) => {
          const min = typeof b?.minutes === "number" ? ` (${b.minutes} min)` : "";
          const detail = b?.detail ? ` — ${b.detail}` : "";
          agendaLines.push(`${i + 1}. **${b?.block ?? ""}**${min}${detail}`);
        });
        agendaLines.push("");
      }

      const qBlock = (label: string, list: any): string[] => {
        const arr = Array.isArray(list) ? list : [];
        if (arr.length === 0) return [];
        const out = [`## Otázky pro ${label}`];
        arr.forEach((q: any) => {
          const txt = typeof q === "string" ? q : (q?.question ?? "");
          if (txt) out.push(`- ${txt}`);
        });
        out.push("");
        return out;
      };

      const planRow: Record<string, any> = {
        user_id: userId,
        plan_date: today,
        selected_part: part || "(neurčeno)",
        therapist,
        session_format: sessionFormat,
        status: "planned",
        urgency_score: updated.priority === "crisis" ? 100 : 70,
        urgency_breakdown: {
          source: "team_deliberation",
          deliberation_id: deliberationId,
          led_by: ledByRaw || null,
          duration_min: typeof sp.duration_min === "number" ? sp.duration_min : null,
          kata_involvement: sp.kata_involvement ?? null,
        },
        plan_markdown: [
          `# Schválený plán z týmové porady`,
          `**Porada:** ${updated.title}`,
          ledByRaw ? `**Vede:** ${ledByRaw}` : "",
          typeof sp.duration_min === "number" ? `**Délka:** ~${sp.duration_min} min` : "",
          sp.why_today ? `**Proč dnes:** ${sp.why_today}` : "",
          sp.kata_involvement ? `**Káťa:** ${sp.kata_involvement}` : "",
          updated.reason ? `**Důvod:** ${updated.reason}` : "",
          ``,
          `## Karlův schválený návrh`,
          updated.karel_proposed_plan ?? "",
          ``,
          ...agendaLines,
          ...qBlock("Haničku", updated.questions_for_hanka),
          ...qBlock("Káťu", updated.questions_for_kata),
          updated.final_summary ? `## Závěr porady\n${updated.final_summary}` : "",
        ].filter(Boolean).join("\n"),
        generated_by: "team_deliberation",
        session_lead: sessionLead,
      };

      const { data: planRes, error: planErr } = await admin
        .from("did_daily_session_plans")
        .insert(planRow)
        .select("id")
        .single();

      if (!planErr && planRes?.id) {
        bridgedPlanId = planRes.id;
        await admin
          .from("did_team_deliberations")
          .update({ linked_live_session_id: bridgedPlanId })
          .eq("id", deliberationId);
      } else if (planErr) {
        console.error("[delib-signoff] bridge insert failed:", planErr);
      }
    }

    // CRISIS BRIDGE: po Karlově podpisu u typu `crisis` musí dojít k REÁLNÝM
    // důsledkům, ne jen ke status flipu. Z karel_synthesis odvodíme:
    //   - did_pending_drive_writes (drive_writeback_md → 05A operativní plán)
    //   - crisis_tasks (Karlův následný rozhovor s částí, pokud needs_karel_interview)
    //   - update na crisis_events (clinical_summary z final_summary, phase pokud resolvable)
    //
    // CRISIS LINKAGE FIX:
    //   `crisis_events.id` ≠ `crisis_alerts.id`. Dříve jsme do crisis_tasks
    //   cpali stejné UUID do obou sloupců — bug. Teď oba ID dohledáváme
    //   nezávisle podle subject_part. Pokud deliberation nemá explicitní
    //   linked_crisis_event_id, pokusíme se ho dohledat (open event s tou
    //   samou částí) a backfillnout. Pokud nedohledáme nic, crisis effects
    //   pro DB nezapisujeme — vracíme to v `crisisEffects.warning`, ne tiše.
    if (
      updated.status === "approved" &&
      updated.deliberation_type === "crisis" &&
      updated.karel_synthesis
    ) {
      const synth = updated.karel_synthesis as any;
      const subjectPart = (updated.subject_parts ?? [])[0] ?? null;

      // --- (a) Resolve crisis_event_id ---------------------------------
      let crisisEventId: string | null = updated.linked_crisis_event_id ?? null;
      if (!crisisEventId && subjectPart) {
        const { data: openEv } = await admin
          .from("crisis_events")
          .select("id")
          .eq("part_name", subjectPart)
          .is("closed_at", null)
          .order("opened_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (openEv?.id) {
          crisisEventId = openEv.id;
          await admin
            .from("did_team_deliberations")
            .update({ linked_crisis_event_id: crisisEventId })
            .eq("id", deliberationId);
          crisisEffects.linked_crisis_event_backfilled = crisisEventId;
        }
      }

      // --- (b) Resolve crisis_alert_id (NEZÁVISLE na event_id) ---------
      // crisis_alerts.status je UPPERCASE enum (ACTIVE / ACKNOWLEDGED / RESOLVED / CLOSED).
      // Bereme jen otevřené alerty (ACTIVE / ACKNOWLEDGED) — používáme whitelist,
      // protože PostgREST `not.in` s lowercase řetězcem hodnoty enum neporovná.
      let crisisAlertId: string | null = null;
      if (subjectPart) {
        const { data: openAlert } = await admin
          .from("crisis_alerts")
          .select("id")
          .eq("part_name", subjectPart)
          .in("status", ["ACTIVE", "ACKNOWLEDGED", "active", "acknowledged"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (openAlert?.id) crisisAlertId = openAlert.id;
      }

      // POST-WRITE INVARIANT (assert, ne user-facing 409):
      // Linkage musela projít preflightem PŘED zápisem podpisu. Pokud se sem
      // dostaneme bez event_id / alert_id, je to interní bug — logneme a
      // necháme bridge spadnout do drive-only / no-task větve. Záměrně zde
      // NEVRACÍME 409, aby na klienta nikdy nešel partial-success error po
      // úspěšně zapsaném podpisu.
      if (!crisisEventId || !crisisAlertId) {
        console.error(
          "[delib-signoff/crisis] INVARIANT VIOLATED: post-write linkage missing",
          {
            deliberationId,
            subjectPart,
            crisisEventId,
            crisisAlertId,
          },
        );
      }

      // --- 1) Drive writeback do 05A operativního plánu ----------------
      if (synth.drive_writeback_md && typeof synth.drive_writeback_md === "string") {
        const dateLabel = new Date().toISOString().slice(0, 10);
        const header = subjectPart
          ? `\n\n## Krizová koordinace — ${subjectPart} (${dateLabel})\n_Zdroj: týmová porada — synthesis ${deliberationId.slice(0, 8)}_\n\n`
          : `\n\n## Krizová koordinace (${dateLabel})\n_Zdroj: týmová porada — synthesis ${deliberationId.slice(0, 8)}_\n\n`;
        const { data: dw, error: dwErr } = await admin
          .from("did_pending_drive_writes")
          .insert({
            user_id: userId,
            target_document: "05A_OPERATIVNI_PLAN",
            write_type: "append",
            content: header + synth.drive_writeback_md,
            priority: "high",
            status: "pending",
          })
          .select("id")
          .maybeSingle();
        if (!dwErr && dw?.id) {
          crisisEffects.drive_write_id = dw.id;
          await admin
            .from("did_team_deliberations")
            .update({ linked_drive_write_id: dw.id })
            .eq("id", deliberationId);
        } else if (dwErr) {
          console.warn("[delib-signoff/crisis] drive write insert failed:", dwErr.message);
        }
      }

      // --- 2) Karlův vlastní rozhovor s částí --------------------------
      // crisis_tasks vyžaduje crisis_alert_id (NOT NULL). Bez něj task
      // nezakládáme — Karlův rozhovor pak musí vzniknout jinou cestou
      // (warning výše to signalizuje).
      if (synth.needs_karel_interview === true && crisisAlertId) {
        const taskRow: Record<string, any> = {
          crisis_alert_id: crisisAlertId,
          crisis_event_id: crisisEventId, // může být null, sloupec je nullable
          assigned_to: "karel",
          title: subjectPart
            ? `Karlův diagnostický rozhovor s ${subjectPart}`
            : "Karlův diagnostický rozhovor",
          description: synth.recommended_session_focus
            ?? synth.next_step
            ?? "Karel si přizve část po týmové poradě.",
          priority: "high",
          status: "pending",
        };
        const { data: tk, error: tkErr } = await admin
          .from("crisis_tasks")
          .insert(taskRow)
          .select("id")
          .maybeSingle();
        if (!tkErr && tk?.id) {
          crisisEffects.crisis_task_id = tk.id;
        } else if (tkErr) {
          console.warn("[delib-signoff/crisis] crisis task insert failed:", tkErr.message);
          crisisEffects.crisis_task_error = tkErr.message;
        }
      } else if (synth.needs_karel_interview === true && !crisisAlertId) {
        crisisEffects.crisis_task_skipped = "no_open_crisis_alert_for_part";
      }

      // --- 3) Update krizového eventu — clinical_summary + případná fáze
      if (crisisEventId) {
        const eventPatch: Record<string, any> = {
          clinical_summary: updated.final_summary?.slice(0, 4000) ?? null,
          updated_at: new Date().toISOString(),
        };
        if (synth.verdict === "crisis_resolvable") {
          eventPatch.stable_since = new Date().toISOString();
          eventPatch.closure_proposed_by = "karel";
          eventPatch.closure_proposed_at = new Date().toISOString();
          eventPatch.closure_reason = synth.next_step ?? null;
        }
        const { error: evErr } = await admin
          .from("crisis_events")
          .update(eventPatch)
          .eq("id", crisisEventId);
        if (evErr) {
          console.warn("[delib-signoff/crisis] crisis_events update failed:", evErr.message);
        } else {
          crisisEffects.crisis_event_updated = crisisEventId;
        }
      }
    }

    return new Response(JSON.stringify({
      deliberation: { ...updated, linked_live_session_id: bridgedPlanId },
      bridged_plan_id: bridgedPlanId,
      crisis_effects: crisisEffects,
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

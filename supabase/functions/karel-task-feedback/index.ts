import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders, requireAuth } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const { taskId, message, author } = await req.json();

    if (!taskId || !message || !author) {
      return new Response(JSON.stringify({ error: "Missing taskId, message, or author" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Load task details
    const { data: task } = await supabaseAdmin
      .from("did_therapist_tasks")
      .select("*")
      .eq("id", taskId)
      .single();

    if (!task) {
      return new Response(JSON.stringify({ error: "Task not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load motivation profile for the author therapist
    const { data: profile } = await supabaseAdmin
      .from("did_motivation_profiles")
      .select("*")
      .eq("therapist", author === "hanka" ? "Hanka" : "Káťa")
      .maybeSingle();

    // Load previous feedback for context
    const { data: previousFeedback } = await supabaseAdmin
      .from("did_task_feedback")
      .select("author, message, created_at")
      .eq("task_id", taskId)
      .order("created_at", { ascending: true })
      .limit(10);

    const feedbackHistory = (previousFeedback || [])
      .map((f: any) => `[${f.author}]: ${f.message}`)
      .join("\n");

    const therapistName = author === "hanka" ? "Hanka" : "Káťa";
    const statusH = task.status_hanka || "not_started";
    const statusK = task.status_kata || "not_started";
    const statusLabel = (s: string) => s === "done" ? "splněno" : s === "in_progress" ? "rozpracováno" : "nezapočato";

    // Build profile context (PRIVATE — never shown to therapist)
    let profileContext = "";
    if (profile) {
      const reliability = profile.tasks_completed / Math.max(1, profile.tasks_completed + profile.tasks_missed);
      profileContext = `
[SOUKROMÝ KONTEXT — NIKDY NEZMIŇUJ V ODPOVĚDI]
Motivační profil ${therapistName}:
- Spolehlivost: ${Math.round(reliability * 100)}%
- Splněno/nesplněno: ${profile.tasks_completed}/${profile.tasks_missed}
- Průměr dní na splnění: ${profile.avg_completion_days}
- Aktuální série: ${profile.streak_current}
- Preferovaný styl: ${profile.preferred_style}
- Poznámky: ${profile.notes || "žádné"}
Využij tyto informace k personalizaci tónu a přístupu, ale NIKDY na ně neodkazuj přímo.`;
    }

    const systemPrompt = `Jsi Karel — vedoucí terapeutického týmu pro DID systém. Právě reaguješ na update od terapeutky ${therapistName} k úkolu.

TVOJE ROLE:
- Profesionální, motivující, konkrétní zpětná vazba
- Uznání pokroku (i malého)
- Doporučení dalšího konkrétního kroku
- Jemná urgence pokud je úkol pozadu
- Max 2-3 věty, stručně a lidsky
- Oslovuj terapeutku jménem
- Pokud update naznačuje problém nebo frustraci, buď empatický ale konstruktivní

KONTEXT ÚKOLU:
Úkol: ${task.task}
${task.note ? `Instrukce: ${task.note}` : ""}
Přiřazeno: ${task.assigned_to === "both" ? "obě" : therapistName}
Stav Hanka: ${statusLabel(statusH)}, Stav Káťa: ${statusLabel(statusK)}
Priorita: ${task.priority || "normal"}
Kategorie: ${task.category || "general"}
Vytvořeno: ${new Date(task.created_at).toLocaleDateString("cs-CZ")}
${task.due_date ? `Deadline: ${new Date(task.due_date).toLocaleDateString("cs-CZ")}` : ""}

${feedbackHistory ? `PŘEDCHOZÍ KOMUNIKACE:\n${feedbackHistory}` : ""}
${profileContext}

AKTUÁLNÍ UPDATE OD ${therapistName.toUpperCase()}:
${message}`;

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      return new Response(JSON.stringify({ error: "AI not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ],
      }),
    });

    if (!aiResponse.ok) {
      console.error("AI error:", aiResponse.status, await aiResponse.text());
      return new Response(JSON.stringify({ error: "AI unavailable" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiData = await aiResponse.json();
    const karelMessage = aiData.choices?.[0]?.message?.content || "Díky za update, pokračuj dál! 💪";

    // Save Karel's response
    await supabaseAdmin.from("did_task_feedback").insert({
      task_id: taskId,
      author: "karel",
      message: karelMessage,
    });

    // Silently update motivation profile based on interaction signals
    if (profile) {
      const now = new Date().toISOString();
      const msgLower = message.toLowerCase();
      const isPositive = /hotovo|splněno|udělal|dokončen|zvládl|povedlo|ok|ano|yes|done/i.test(msgLower);
      const isStruggling = /nestíhám|problém|nejde|neumím|těžk|frustr|nevím/i.test(msgLower);

      const updates: Record<string, any> = {
        last_active_at: now,
        updated_at: now,
      };

      // Adjust effectiveness scores based on response patterns
      if (isPositive && profile.praise_effectiveness < 5) {
        updates.praise_effectiveness = Math.min(5, profile.praise_effectiveness + 1);
      }
      if (isStruggling) {
        updates.notes = `${profile.notes || ""}\n[${new Date().toLocaleDateString("cs-CZ")}] Signál frustrace u úkolu: ${task.task.substring(0, 50)}`.trim();
      }

      await supabaseAdmin
        .from("did_motivation_profiles")
        .update(updates)
        .eq("id", profile.id);
    }

    // TODO [FÁZE 4]: Persist observation from task feedback
    // import { createObservation, routeObservation } from '../_shared/observations.ts';
    // const obsId = await createObservation(supabaseAdmin, {
    //   subject_type: 'part',
    //   subject_id: task.related_part || task.assigned_to,
    //   source_type: 'task_feedback',
    //   source_ref: taskId,
    //   fact: `Feedback na úkol "${task.task}": ${message.slice(0, 200)}`,
    //   evidence_level: isPositive ? 'D1' : 'I1',
    //   time_horizon: '0_14d',
    // });
    // await routeObservation(supabaseAdmin, obsId, {...}, isPositive ? 'context_only' : 'immediate_plan');

    return new Response(JSON.stringify({ reply: karelMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("karel-task-feedback error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

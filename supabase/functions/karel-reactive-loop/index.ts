import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const COMMITMENT_KEYWORDS = [
  "zavolám", "udělám", "zajistím", "připravím", "pošlu", "zkusím",
  "slibuju", "domluvím", "naplánuji", "zorganizuji",
];

const DID_KEYWORDS = [
  "část", "alter", "Arthur", "Tundrupek", "Gustík", "Petřík", "Anička",
  "sezení", "terapie", "disociace", "trauma", "přepnutí", "symptom", "ochránce",
];

function detectCrisis(text: string): boolean {
  const keywords = ["krize","krizový","sebevražda","sebepoškozování","disociace",
    "útěk","nebezpečí","akutní","Arthur","Tundrupek"];
  return keywords.some(kw => text.toLowerCase().includes(kw.toLowerCase()));
}

function normalizeTherapist(raw: string): "hanka" | "kata" {
  const lower = (raw || "").toLowerCase().trim();
  if (["kata","káťa","katka"].includes(lower)) return "kata";
  return "hanka";
}

function detectPartMention(text: string): string | null {
  const parts = ["Arthur","Tundrupek","Gustík","Gustik","Petřík","Anička","Anicka",
    "Dmytri","Dymi","Bendik","Einar","Adam","Bélo","Clark","Gabriel","Gerhardt",
    "Baltazar","Sebastián","Matyáš","Kvído","Alvar"];
  for (const p of parts) { if (text.includes(p)) return p; }
  return null;
}

function generateReactiveResponse(taskText: string, isCrisis: boolean): string {
  if (isCrisis) return `Karel zaznamenal krizovou informaci a aktualizuje plán. ${taskText.slice(0,150)}`;
  return `Karel přijal informaci a zapracovává ji do plánu. ${taskText.slice(0,150)}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const since = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  let statsA = 0, statsB = 0, statsC = 0, statsD = 0, statsAgenda = 0, statsExpired = 0;

  // Cron calls don't have auth — skip auth check for this function
  console.log('[REACTIVE-LOOP] Starting run at', new Date().toISOString());

  try {
    // ═══ KROK 1 — Načtení nových zpráv z 5 zdrojů ═══

    // Zdroj A — manuální úkoly od terapeutů
    const { data: manualTasks } = await sb
      .from("did_therapist_tasks")
      .select("*")
      .eq("source", "therapist_manual")
      .gt("created_at", since)
      .eq("processed_by_reactive", false);

    // Zdroj B — porady s novými zprávami
    const { data: recentMeetings } = await sb
      .from("did_meetings")
      .select("id, topic, messages, last_reactive_message_count, updated_at")
      .gt("updated_at", since);

    // Zdroj C — zodpovězené otázky
    const { data: answeredQuestions } = await sb
      .from("did_pending_questions")
      .select("*")
      .eq("status", "answered")
      .gt("answered_at", since)
      .eq("processed_by_reactive", false);

    // Zdroj D — DID-relevantní info z osobních vláken
    const { data: recentConversations } = await sb
      .from("did_conversations")
      .select("id, messages, sub_mode, updated_at")
      .gt("updated_at", since)
      .in("sub_mode", ["general", "mamka"]);

    // Zdroj E — krizový deník (pouze čtení pro kontext)
    const { data: recentCrisisJournal } = await sb
      .from("crisis_journal")
      .select("*")
      .gt("created_at", since);

    // ═══ KROK 2 — Zpracování každého záznamu ═══

    // --- Zdroj A: manuální úkoly ---
    for (const task of manualTasks || []) {
      const text = task.task || task.title || "";
      const isCrisis = detectCrisis(text);

      if (isCrisis) {
        await sb.from("crisis_journal").insert({
          entry_type: "reactive_note",
          karel_notes: `Reactive loop: krizový manuální úkol od terapeuta: ${text.slice(0, 300)}`,
          date: new Date().toISOString().split("T")[0],
        });
      }

      // Karlova odpověď jako nový úkol
      await sb.from("did_therapist_tasks").insert({
        task: generateReactiveResponse(text, isCrisis),
        source: "karel_reactive",
        related_task_id: task.id,
        therapist: task.assigned_to || "hanka",
        status: "pending",
        priority: isCrisis ? "high" : "normal",
        user_id: task.user_id,
      });

      // Follow-up do agendy
      await sb.from("karel_conversation_agenda").insert({
        therapist: normalizeTherapist(task.assigned_to || "hanka"),
        topic: `Follow-up k úkolu: ${text.slice(0, 150)}`,
        topic_type: "followup",
        priority: isCrisis ? "urgent" : "normal",
        context: text.slice(0, 500),
        status: "pending",
      });

      await sb.from("did_therapist_tasks")
        .update({ processed_by_reactive: true })
        .eq("id", task.id);

      statsA++;
    }

    // --- Zdroj B: porady ---
    for (const meeting of recentMeetings || []) {
      const msgs = Array.isArray(meeting.messages) ? meeting.messages : [];
      const lastCount = meeting.last_reactive_message_count || 0;

      if (msgs.length <= lastCount) continue;

      const newMsgs = msgs.slice(lastCount);
      const lastMsg = newMsgs[newMsgs.length - 1] as any;
      const lastAuthor = (lastMsg?.author || lastMsg?.role || "").toLowerCase();

      // Pokud poslední zpráva je od terapeuta (ne od Karla)
      if (lastAuthor && lastAuthor !== "karel") {
        const karelResponse = {
          role: "assistant",
          author: "Karel",
          content: `Karel zaregistroval: "${(lastMsg?.text || lastMsg?.content || "").slice(0, 200)}". Zapracovávám do plánu.`,
          timestamp: new Date().toISOString(),
        };
        const updatedMsgs = [...msgs, karelResponse];
        await sb.from("did_meetings")
          .update({
            messages: updatedMsgs,
            last_reactive_message_count: updatedMsgs.length,
          })
          .eq("id", meeting.id);
      } else {
        await sb.from("did_meetings")
          .update({ last_reactive_message_count: msgs.length })
          .eq("id", meeting.id);
      }

      // Detekce krizového obsahu v nových zprávách
      for (const msg of newMsgs) {
        const content = (msg as any)?.text || (msg as any)?.content || "";
        if (detectCrisis(content)) {
          await sb.from("crisis_journal").insert({
            entry_type: "reactive_note",
            karel_notes: `Reactive loop: krizový obsah v poradě "${meeting.topic}": ${content.slice(0, 300)}`,
            date: new Date().toISOString().split("T")[0],
          });
        }

        // Extrakce závazků
        const hasCommitment = COMMITMENT_KEYWORDS.some(kw => content.toLowerCase().includes(kw));
        if (hasCommitment && content.trim()) {
          const author = (msg as any)?.author || (msg as any)?.role || "";
          const committedBy = normalizeTherapist(author);
          const { data: existing } = await sb
            .from("karel_commitments")
            .select("id")
            .eq("commitment_text", content.slice(0, 300))
            .eq("source_id", meeting.id)
            .limit(1);

          if (!existing || existing.length === 0) {
            await sb.from("karel_commitments").insert({
              commitment_text: content.slice(0, 300),
              committed_by: committedBy,
              source_type: "meeting",
              source_id: meeting.id,
              due_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
              status: "open",
            });
          }
        }
      }

      statsB++;
    }

    // --- Zdroj C: zodpovězené otázky ---
    for (const q of answeredQuestions || []) {
      const answer = q.answer || q.response || "";
      const isCrisis = detectCrisis(answer);

      if (isCrisis) {
        await sb.from("crisis_journal").insert({
          entry_type: "reactive_note",
          karel_notes: `Reactive loop: krizová odpověď na otázku: ${answer.slice(0, 300)}`,
          date: new Date().toISOString().split("T")[0],
        });
      }

      // Follow-up do agendy
      await sb.from("karel_conversation_agenda").insert({
        therapist: normalizeTherapist(q.directed_to || "hanka"),
        topic: `Follow-up k zodpovězené otázce: ${(q.question || "").slice(0, 150)}`,
        topic_type: "followup",
        priority: isCrisis ? "urgent" : "when_appropriate",
        context: answer.slice(0, 500),
        status: "pending",
      });

      // Pokud odpověď zmiňuje DID část
      const part = detectPartMention(answer);
      if (part) {
        await sb.from("did_pending_drive_writes").insert({
          target_file: `KARTA_${part.toUpperCase()}`,
          content: `[Reaktivní zpracování] Odpověď terapeuta: ${answer.slice(0, 500)}`,
          source_type: "reactive_loop",
          source_id: q.id,
          status: "pending",
        });
      }

      await sb.from("did_pending_questions")
        .update({ processed_by_reactive: true })
        .eq("id", q.id);

      statsC++;
    }

    // --- Zdroj D: DID-relevantní info z osobních vláken ---
    for (const conv of recentConversations || []) {
      const msgs = Array.isArray(conv.messages) ? conv.messages : [];
      const recentUserMsgs = msgs.filter((m: any) =>
        m?.role === "user" && DID_KEYWORDS.some(kw => (m?.content || "").includes(kw))
      );

      for (const msg of recentUserMsgs) {
        const content = (msg as any)?.content || "";
        const part = detectPartMention(content);

        if (part) {
          // Aktualizace karty části
          await sb.from("did_pending_drive_writes").insert({
            target_file: `KARTA_${part.toUpperCase()}`,
            content: `[Z osobního vlákna] ${content.slice(0, 500)}`,
            source_type: "reactive_loop",
            source_id: conv.id,
            status: "pending",
          });
        }

        // Zápis do PAMET_KAREL
        await sb.from("did_pending_drive_writes").insert({
          target_file: "PAMET_KAREL",
          content: `[Pozorování z osobního vlákna ${conv.sub_mode}] ${content.slice(0, 500)}`,
          source_type: "reactive_loop",
          source_id: conv.id,
          status: "pending",
        });

        // Agenda položka
        await sb.from("karel_conversation_agenda").insert({
          therapist: conv.sub_mode === "kata" ? "kata" : "hanka",
          topic: `Zmínka o DID tématu v osobním vlákně: ${content.slice(0, 100)}`,
          topic_type: "followup",
          priority: "when_appropriate",
          context: content.slice(0, 500),
          related_part: part || null,
          status: "pending",
        });

        statsD++;
      }
    }

    // ═══ KROK 3 — Generuj agenda položky ═══
    // (agenda items are already created inline in step 2)
    // Additional: praise for completed tasks from last 20 min
    const { data: completedTasks } = await sb
      .from("did_therapist_tasks")
      .select("id, task, therapist")
      .eq("status", "done")
      .gt("updated_at", since);

    for (const task of completedTasks || []) {
      const { data: existingPraise } = await sb
        .from("karel_conversation_agenda")
        .select("id")
        .eq("topic_type", "praise")
        .ilike("context", `%${task.id}%`)
        .limit(1);

      if (!existingPraise || existingPraise.length === 0) {
        await sb.from("karel_conversation_agenda").insert({
          therapist: normalizeTherapist(task.assigned_to || "hanka"),
          topic: `Pochválit za splněný úkol: ${(task.task || "").slice(0, 100)}`,
          topic_type: "praise",
          priority: "when_appropriate",
          context: `task_id: ${task.id}`,
          status: "pending",
        });
        statsAgenda++;
      }
    }

    // ═══ KROK 4 — Overdue agenda ═══
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    const { data: overdueAgenda } = await sb
      .from("karel_conversation_agenda")
      .select("id, priority, topic, therapist")
      .eq("status", "pending")
      .lt("created_at", threeDaysAgo);

    for (const item of overdueAgenda || []) {
      if (item.priority === "urgent") {
        // Eskalace do pending questions
        await sb.from("did_pending_questions").insert({
          question: item.topic,
          directed_to: item.therapist === "kata" ? "kata" : "both",
          subject_type: "agenda_escalation",
          status: "pending",
          expires_at: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        });
        await sb.from("karel_conversation_agenda")
          .update({ status: "escalated" })
          .eq("id", item.id);
      } else if (item.priority === "when_appropriate") {
        await sb.from("karel_conversation_agenda")
          .update({ status: "expired" })
          .eq("id", item.id);
      }
      // priority='normal' — ponechat
      statsExpired++;
    }

    // ═══ KROK 5 — Log ═══
    await sb.from("system_health_log").insert({
      event_type: "reactive_loop_run",
      severity: "info",
      message: `Reactive loop: A=${statsA} tasks, B=${statsB} meetings, C=${statsC} questions, D=${statsD} convos, agenda=${statsAgenda}, expired=${statsExpired}`,
    });

    console.log('[REACTIVE-LOOP] Completed successfully', { statsA, statsB, statsC, statsD, statsAgenda, statsExpired });

    return new Response(JSON.stringify({
      success: true,
      stats: { manualTasks: statsA, meetings: statsB, questions: statsC, conversations: statsD, agenda: statsAgenda, expired: statsExpired },
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[REACTIVE-LOOP] FATAL ERROR:", error?.message || error);
    await sb.from("system_health_log").insert({
      event_type: "reactive_loop_error",
      severity: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    }).catch(() => {});
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  isWriteAllowed,
  applySafetyFilter,
  type ClassifiedItem,
} from "../_shared/informationClassifier.ts";
import { encodeGovernedWrite } from "../_shared/documentWriteEnvelope.ts";
import {
  normalizeSignal,
  canWriteToOperationalLayer,
  canWriteToPartCard,
  type SourceDomain,
} from "../_shared/signalNormalization.ts";
import {
  segmentMessageIntoTopics,
  buildMessageClusters,
  type TopicSegment,
} from "../_shared/topicSegmentation.ts";

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

const STRESS_KEYWORDS = [
  "vyčerpaná", "unavená", "nestíhám", "kapacita", "přetížená", "stres",
  "nemůžu", "zátěž", "potřebuju pauzu", "nespala", "bolest", "úzkost",
];

const DID_OWNER_ID = "8a7816ee-4fd1-43d4-8d83-4230d7517ae1";

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

/**
 * Derive a safe clinical implication from a private signal mentioning a part.
 * NEVER passes raw personal content — only an abstracted professional conclusion.
 */
function deriveClinicalImplicationFromPrivateSignal(partName: string, rawContent: string): string {
  const lower = rawContent.toLowerCase();

  // Detect clinical themes heuristically — output is always abstracted
  const themes: string[] = [];

  if (["strach", "bojí", "úzkost", "panika", "děs"].some(w => lower.includes(w)))
    themes.push("zvýšená úzkostná reaktivita");
  if (["vztek", "agrese", "naštvaný", "zuří", "zuřivost"].some(w => lower.includes(w)))
    themes.push("signály zvýšené afektivní tenze");
  if (["smutek", "pláče", "brečí", "stýská", "ztráta"].some(w => lower.includes(w)))
    themes.push("emocionální zranitelnost — smutek/ztráta");
  if (["odmítnutí", "nechce", "odmítá", "zavírá", "stáhl"].some(w => lower.includes(w)))
    themes.push("signál stažení / odmítání kontaktu");
  if (["přepnutí", "switch", "disociace", "ztratil", "zmizel"].some(w => lower.includes(w)))
    themes.push("možný switching / disociativní signál");
  if (["důvěra", "věří", "nevěří", "podezřívá"].some(w => lower.includes(w)))
    themes.push("signál ve vztahové důvěře");
  if (["spánek", "nespí", "noční", "budí se", "děsivý sen"].some(w => lower.includes(w)))
    themes.push("narušení spánkového vzorce");

  if (themes.length === 0) {
    themes.push("nespecifikovaný signál vyžadující ověření v přímém kontaktu");
  }

  const today = new Date().toISOString().split("T")[0];
  return `[${today}] Odvozená klinická implikace pro ${partName}: ${themes.join("; ")}. Doporučeno ověřit v dalším sezení.`;
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

    // Zdroj D — DID-relevantní info z terapeutických vláken (did_conversations)
    //           + osobních vláken Hany (karel_hana_conversations)
    const { data: didConvs } = await sb
      .from("did_conversations")
      .select("id, messages, sub_mode, updated_at")
      .gt("updated_at", since)
      .in("sub_mode", ["general", "mamka", "kata"]);

    const { data: hanaConvs } = await sb
      .from("karel_hana_conversations")
      .select("id, messages, sub_mode, updated_at")
      .gt("updated_at", since)
      .eq("is_locked", false);

    // Normalize into unified shape with canonical sourceDomain
    const HANA_PERSONAL_ALIASES = ["personal", "hana_personal", "osobní", "hana"];
    function canonicalizeHanaMode(raw: string | null): string {
      const lower = (raw || "").toLowerCase().trim();
      if (HANA_PERSONAL_ALIASES.includes(lower)) return "hana_personal";
      return lower || "hana_personal";
    }

    const recentConversations = [
      ...(didConvs || []).map(c => ({
        ...c,
        _sourceTable: "did_conversations" as const,
        sub_mode: c.sub_mode,
      })),
      ...(hanaConvs || []).map(c => ({
        ...c,
        _sourceTable: "karel_hana_conversations" as const,
        sub_mode: canonicalizeHanaMode(c.sub_mode),
      })),
    ];

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
        assigned_to: task.assigned_to || "hanka",
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
          target_document: `KARTA_${part.toUpperCase()}`,
          content: encodeGovernedWrite(
            `[Reaktivní zpracování] Odpověď terapeuta: ${answer.slice(0, 500)}`,
            {
              source_type: "reactive-loop",
              source_id: q.id,
              content_type: "session_result",
              subject_type: "part",
              subject_id: part,
            },
          ),
          write_type: "append",
          priority: "normal",
          user_id: DID_OWNER_ID,
        });
      }

      await sb.from("did_pending_questions")
        .update({ processed_by_reactive: true })
        .eq("id", q.id);

      statsC++;
    }

    // --- Zdroj D: DID-relevantní info z osobních vláken ---
    // FÁZE 2.5: Všechny signály procházejí přes normalizeSignal()
    // Raw obsah → PAMET_KAREL only
    // Operativní implikace → 05A (jen pokud canWriteToOperationalLayer)
    // Klinické implikace → KARTA_{PART} (jen pokud canWriteToPartCard)
    // Agenda item → zachováno
    for (const conv of recentConversations || []) {
      const msgs = Array.isArray(conv.messages) ? conv.messages : [];
      const recentUserMsgs = msgs.filter((m: any) =>
        m?.role === "user" && DID_KEYWORDS.some(kw => (m?.content || "").includes(kw))
      );

      const therapist: "hanka" | "kata" = conv.sub_mode === "kata" ? "kata" : "hanka";
      const sourceDomain: SourceDomain = conv.sub_mode === "kata"
        ? "therapist_kata"
        : (conv.sub_mode === "hana_personal" ? "hana_personal" : "therapist_hanka");

      for (const msg of recentUserMsgs) {
        const content = (msg as any)?.content || "";

        // ── FÁZE 2.5: Normalize the signal ──
        const signal = normalizeSignal({
          raw_content: content,
          source_domain: sourceDomain,
          source_id: conv.id,
          source_message_id: (msg as any)?.id || null,
          therapist,
        });

        // 1. PAMET_KAREL — raw private signal (always for private/personal sources)
        if (signal.recommended_actions.includes("write_pamet")) {
          const pametTarget = therapist === "kata"
            ? "PAMET_KAREL/DID/KATA/KARLOVY_POZNATKY"
            : "PAMET_KAREL/DID/HANKA/KARLOVY_POZNATKY";

          await sb.from("did_pending_drive_writes").insert({
            target_document: pametTarget,
            content: encodeGovernedWrite(
              `[Osobní vlákno ${new Date().toISOString().split("T")[0]}] ${content.slice(0, 500)}`,
              {
                source_type: "reactive-loop",
                source_id: conv.id,
                content_type: "therapist_memory_note",
                subject_type: "therapist",
                subject_id: therapist,
              },
            ),
            write_type: "append",
            priority: "normal",
            status: "pending",
            user_id: DID_OWNER_ID,
          });
        }

        // 2. Operativní implikace — jen pokud normalizace povolí
        if (canWriteToOperationalLayer(signal) && signal.derived_operational_implication) {
          await sb.from("did_pending_drive_writes").insert({
            target_document: "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
            content: encodeGovernedWrite(
              `\n\n--- ${new Date().toISOString().split("T")[0]} | reactive-loop ---\n${signal.derived_operational_implication}`,
              {
                source_type: "reactive-loop",
                source_id: conv.id,
                content_type: "situational_analysis",
                subject_type: "therapist",
                subject_id: therapist,
              },
            ),
            write_type: "append",
            priority: "normal",
            status: "pending",
            user_id: DID_OWNER_ID,
          });
        }

        // 3. Klinický dopad na část — jen pokud normalizace povolí
        //    NIKDY raw obsah — jen odvozená klinická implikace
        if (canWriteToPartCard(signal) && signal.derived_clinical_implication && signal.part_name) {
          await sb.from("did_pending_drive_writes").insert({
            target_document: `KARTA_${signal.part_name.toUpperCase()}`,
            content: encodeGovernedWrite(
              signal.derived_clinical_implication,
              {
                source_type: "reactive-loop",
                source_id: conv.id,
                content_type: "session_result",
                subject_type: "part",
                subject_id: signal.part_name,
              },
            ),
            write_type: "append",
            priority: "normal",
            status: "pending",
            user_id: DID_OWNER_ID,
          });
        }

        // 4. Agenda item — zachováno (safe_summary místo raw content)
        await sb.from("karel_conversation_agenda").insert({
          therapist,
          topic: `DID zmínka v osobním vlákně: ${signal.safe_summary.slice(0, 100)}`,
          topic_type: "followup",
          priority: signal.signal_type === "risk" ? "urgent" : "when_appropriate",
          context: `[Normalizováno] ${signal.normalized_summary}. ${signal.part_name ? `Část: ${signal.part_name}. ` : ""}Confidence: ${signal.confidence.toFixed(2)}, Evidence: ${signal.evidence_strength}`,
          related_part: signal.part_name || null,
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

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";
import { SYSTEM_RULES } from "../_shared/system-rules.ts";
import { normalizeKarelContext } from "../_shared/karelContextNormalizer.ts";
import { buildKarelIdentityBlock } from "../_shared/karelIdentity.ts";
import { getKarelTone } from "../_shared/karelTonalRouter.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const { action, meetingId, message, therapist, seed } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const MAMKA_EMAIL = "mujosobniasistentnamiru@gmail.com";
    const KATA_EMAIL = Deno.env.get("KATA_EMAIL") || "K.CC@seznam.cz";

    // ═══ SHARED IDENTITY FOR MEETING (explicit porada override) ═══
    const meetingCtx = normalizeKarelContext({
      mode: "childcare",
      didSubMode: null,
      explicitDomain: "porada",
      explicitAudience: "general",
    });
    const meetingIdentity = buildKarelIdentityBlock(meetingCtx);
    const meetingTone = getKarelTone(meetingCtx);
    const meetingIdentityBlock = [
      meetingIdentity,
      "JAZYKOVÁ PRAVIDLA:",
      ...meetingTone.forbiddenPhrases.map((x: string) => `- NIKDY neříkej: "${x}"`),
      "",
      "SEBE-REFERENCE:",
      ...meetingTone.voiceRules.selfReferenceBlacklist.map((x: string) => `- NIKDY: "${x}"`),
    ].join("\n");

    // ═══ ACTION: CREATE MEETING ═══
    if (action === "create") {
      const topic = message || "Porada týmu";
      const agenda = therapist || "";
      const triggeredBy = "manual";

      // Build structured opening message from seed or fallback
      let openingContent: string;
      if (seed && (seed.reason || seed.karelProposal || seed.questionsHanka || seed.questionsKata)) {
        const parts: string[] = [];
        parts.push(`\u{1F4CB} **Karel svol\u00E1v\u00E1 poradu**\n`);
        parts.push(`**T\u00E9ma:** ${topic}\n`);
        if (seed.reason && seed.reason !== topic) {
          parts.push(`**Pro\u010D svol\u00E1v\u00E1m:** ${seed.reason}\n`);
        }
        if (seed.karelProposal) {
          parts.push(`**Co navrhuji:** ${seed.karelProposal}\n`);
        }
        if (seed.questionsHanka) {
          parts.push(`**Hani\u010Dko, pot\u0159ebuji od tebe:** ${seed.questionsHanka}\n`);
        }
        if (seed.questionsKata) {
          parts.push(`**K\u00E1\u0165o, pot\u0159ebuji od tebe:** ${seed.questionsKata}\n`);
        }
        parts.push(`\nO\u010Dek\u00E1v\u00E1m va\u0161e vyj\u00E1d\u0159en\u00ED \u2014 ka\u017Ed\u00E1 m\u016F\u017Ee odpov\u011Bd\u011Bt, a\u017E bude m\u00EDt \u010Das. Pr\u016Fb\u011B\u017En\u011B moderuji a shrnuji.`);
        openingContent = parts.join("\n");
      } else {
        // Minimal fallback — still structured
        const fallbackParts: string[] = [];
        fallbackParts.push(`\u{1F4CB} **Karel svol\u00E1v\u00E1 poradu**\n`);
        fallbackParts.push(`**T\u00E9ma:** ${topic}\n`);
        if (agenda) {
          fallbackParts.push(`**Agenda:**\n${agenda}\n`);
        }
        fallbackParts.push(`**Pro\u010D:** Pot\u0159ebuji va\u0161e spole\u010Dn\u00E9 rozhodnut\u00ED k tomuto t\u00E9matu.\n`);
        fallbackParts.push(`Na z\u00E1klad\u011B dostupn\u00FDch dat navrhuji n\u00E1sleduj\u00EDc\u00ED kroky \u2014 pot\u0159ebuji va\u0161e pozorov\u00E1n\u00ED a zku\u0161enosti z praxe.\n`);
        fallbackParts.push(`**Hani\u010Dko:** Co jsi pozorovala v posledn\u00EDch dnech k tomuto t\u00E9matu?\n`);
        fallbackParts.push(`**K\u00E1\u0165o:** Jak\u00E9 sign\u00E1ly jsi zaznamenala ze sv\u00E9 strany?\n`);
        fallbackParts.push(`\nO\u010Dek\u00E1v\u00E1m va\u0161e vyj\u00E1d\u0159en\u00ED \u2014 ka\u017Ed\u00E1 m\u016F\u017Ee odpov\u011Bd\u011Bt, a\u017E bude m\u00EDt \u010Das.`);
        openingContent = fallbackParts.join("\n");
      }

      const { data: meeting, error } = await sb.from("did_meetings").insert({
        user_id: authResult.user.id,
        topic: topic || "Porada týmu",
        agenda: agenda || "",
        triggered_by: triggeredBy || "daily_cycle",
        deadline_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
        messages: [{
          role: "karel",
          therapist: "karel",
          content: openingContent,
          timestamp: new Date().toISOString(),
        }],
      }).select().single();

      if (error) throw error;

      // Send invitation emails
      if (RESEND_API_KEY) {
        const resend = new Resend(RESEND_API_KEY);
        const APP_URL = "https://karel-pomoc.lovable.app";
        const meetingLink = `${APP_URL}/chat?meeting=${meeting.id}`;

        const emailHtml = (name: string) => `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>📋 Karel svolává poradu</h2>
            <p><strong>Téma:</strong> ${topic}</p>
            ${agenda ? `<p><strong>Agenda:</strong></p><p>${agenda.replace(/\n/g, "<br>")}</p>` : ""}
            <p>${name === "Haničko" ? "Haničko" : "Káťo"}, Karel tě zve k asynchronní poradě. Odpovědět můžeš kdykoliv v průběhu dne – Karel shrnuje průběžně.</p>
            <p style="margin: 24px 0;">
              <a href="${meetingLink}" style="background: #6366f1; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">
                Připojit se k poradě →
              </a>
            </p>
            <p style="color: #666; font-size: 13px;">Odkaz tě přesměruje do aplikace Karel. Pro přístup je nutné být přihlášena.</p>
            <p>Karel</p>
          </div>
        `;

        try {
          await resend.emails.send({
            from: "Karel <karel@karel-pomoc.lovable.app>",
            to: MAMKA_EMAIL,
            subject: `Karel – porada: ${topic}`,
            html: emailHtml("Haničko"),
          });
        } catch (e) {
          console.warn("Hanka meeting invite email error:", e);
        }

        try {
          await resend.emails.send({
            from: "Karel <karel@karel-pomoc.lovable.app>",
            to: KATA_EMAIL,
            subject: `Karel – porada: ${topic}`,
            html: emailHtml("Káťo"),
          });
        } catch (e) {
          console.warn("Kata meeting invite email error:", e);
        }
      }

      return new Response(JSON.stringify({ success: true, meeting }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ═══ ACTION: LIST MEETINGS ═══
    if (action === "list") {
      // Use service_role client to bypass RLS (meetings may be created by cron with different user_id)
      const { data: meetings } = await sb.from("did_meetings")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(20);

      return new Response(JSON.stringify({ meetings: meetings || [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ═══ ACTION: SEND INVITES (for existing meeting) ═══
    if (action === "send_invites") {
      const { data: meeting } = await sb.from("did_meetings").select("*").eq("id", meetingId).single();
      if (!meeting) throw new Error("Meeting not found");

      if (RESEND_API_KEY) {
        const resend = new Resend(RESEND_API_KEY);
        const APP_URL = "https://karel-pomoc.lovable.app";
        const meetingLink = `${APP_URL}/chat?meeting=${meeting.id}`;
        const emailHtml = (name: string) => `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>📋 Karel svolává poradu</h2>
            <p><strong>Téma:</strong> ${meeting.topic}</p>
            ${meeting.agenda ? `<p><strong>Agenda:</strong></p><p>${meeting.agenda.replace(/\n/g, "<br>")}</p>` : ""}
            <p>${name}, Karel tě zve k asynchronní poradě. Odpovědět můžeš kdykoliv – Karel shrnuje průběžně.</p>
            <p style="margin: 24px 0;">
              <a href="${meetingLink}" style="background: #6366f1; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">
                Připojit se k poradě →
              </a>
            </p>
            <p style="color: #666; font-size: 13px;">Pro přístup je nutné být přihlášena.</p>
            <p>Karel</p>
          </div>
        `;
        const results: string[] = [];
        try { await resend.emails.send({ from: "Karel <karel@karel-pomoc.lovable.app>", to: MAMKA_EMAIL, subject: `Karel – porada: ${meeting.topic}`, html: emailHtml("Haničko") }); results.push("hanka_ok"); } catch (e) { results.push("hanka_fail"); }
        try { await resend.emails.send({ from: "Karel <karel@karel-pomoc.lovable.app>", to: KATA_EMAIL, subject: `Karel – porada: ${meeting.topic}`, html: emailHtml("Káťo") }); results.push("kata_ok"); } catch (e) { results.push("kata_fail"); }
        return new Response(JSON.stringify({ success: true, results }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "No RESEND_API_KEY" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ═══ ACTION: GET MEETING ═══
    if (action === "get") {
      const { data: meeting } = await sb.from("did_meetings")
        .select("*")
        .eq("id", meetingId)
        .single();

      return new Response(JSON.stringify({ meeting }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ═══ ACTION: POST MESSAGE (therapist contribution) ═══
    if (action === "post_message") {
      const { data: meeting } = await sb.from("did_meetings")
        .select("*")
        .eq("id", meetingId)
        .single();

      if (!meeting) throw new Error("Meeting not found");
      if (meeting.status === "finalized") throw new Error("Meeting already finalized");

      const existingMessages = Array.isArray(meeting.messages) ? meeting.messages : [];

      // Mark therapist as joined
      const joinUpdate: Record<string, any> = { updated_at: new Date().toISOString() };
      if (therapist === "hanka" && !meeting.hanka_joined_at) joinUpdate.hanka_joined_at = new Date().toISOString();
      if (therapist === "kata" && !meeting.kata_joined_at) joinUpdate.kata_joined_at = new Date().toISOString();

      // Add therapist message
      const newMessage = {
        role: "therapist",
        therapist: therapist || "unknown",
        content: message,
        timestamp: new Date().toISOString(),
      };
      existingMessages.push(newMessage);

      // Karel moderates: generate response based on all messages so far
      let karelResponse = "";
      if (LOVABLE_API_KEY) {
        try {
          const otherTherapist = therapist === "hanka" ? "Káťa" : "Hanka";
          const otherJoined = therapist === "hanka" ? meeting.kata_joined_at : meeting.hanka_joined_at;
          const therapistName = therapist === "hanka" ? "Hanička" : "Káťa";

          const conversationContext = existingMessages.map((m: any) => {
            const name = m.therapist === "karel" ? "Karel" : m.therapist === "hanka" ? "Hanička" : "Káťa";
            return `${name}: ${m.content}`;
          }).join("\n\n");

          const moderationRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash",
              messages: [
                {
                  role: "system",
                  content: SYSTEM_RULES + "\n\n" + meetingIdentityBlock + `\n\n
V poradě vždy začni vlastní analýzou a návrhem.
Nezačínej generickou otázkou typu "jak to vidíš".

TVOJE ROLE V PORADĚ na téma: "${meeting.topic}":
1. ANALYZUJ situaci z hlubinné Jungovské perspektivy — hledej archetypy, vzorce, stíny, projekce
2. NAVRHUJ KONKRÉTNÍ TERAPEUTICKÉ KROKY — ne obecné otázky, ale jasné postupy
3. VEĎ poradu autoritativně — formuluj hypotézy a ptej se na KONKRÉTNÍ pozorování
4. NIKDY nedeleguj svou analytickou práci na terapeutky — TY jsi ten, kdo analyzuje a navrhuje
5. FORMULUJ závěry a výstupy jasně a direktivně

ZAKÁZANÉ FRÁZE: „jak vnímáš aktuální stav", „co navrhuješ ty", „jak to vidíš", „jaký máš pocit", „co si o tom myslíš"
— Karel VŽDY navrhuje SÁM a ptá se na KONKRÉTNÍ pozorování a fakta.

PŘÍKLAD SPRÁVNÉ MODERACE:
„Haničko, z analýzy vyplývá, že Arthur reaguje na grounding s klesající účinností — to naznačuje, že obranný mechanismus se adaptoval. Navrhuji přejít na somatický přístup. Pozorovala jsi u něj tělesné napětí v oblasti ramen nebo čelisti?"

${!otherJoined ? `${otherTherapist} se zatím nepřipojila — shrň příspěvek ${therapistName} pro ${otherTherapist} a požádej ji o připojení.` : ""}
Pokud mají obě terapeutky dostatečně vyjádřený názor → navrhni závěr porady a formuluj výstupy.
Nikdy nezavírej poradu bez souhlasu obou stran.

FORMÁT: Piš stručně ale výstižně. Závěrečné shrnutí označ: [ZÁVĚR PORADY] ... [/ZÁVĚR PORADY]

AGENDA: ${meeting.agenda || meeting.topic}`,
                },
                { role: "user", content: `Průběh porady:\n\n${conversationContext}` },
              ],
            }),
          });

          if (moderationRes.ok) {
            const d = await moderationRes.json();
            karelResponse = d.choices?.[0]?.message?.content || "";
          }
        } catch (e) {
          console.warn("Karel moderation error:", e);
        }
      }

      if (karelResponse) {
        existingMessages.push({
          role: "karel",
          therapist: "karel",
          content: karelResponse,
          timestamp: new Date().toISOString(),
        });
      }

      // Update meeting
      await sb.from("did_meetings").update({
        ...joinUpdate,
        messages: existingMessages,
      }).eq("id", meetingId);

      // If the other therapist hasn't joined yet, escalate: email + ask the present therapist to help
      const otherTherapist = therapist === "hanka" ? "kata" : "hanka";
      const otherJoined = therapist === "hanka" ? meeting.kata_joined_at : meeting.hanka_joined_at;

      if (!otherJoined && RESEND_API_KEY) {
        const resend = new Resend(RESEND_API_KEY);
        const otherEmail = otherTherapist === "hanka" ? MAMKA_EMAIL : KATA_EMAIL;
        const otherName = otherTherapist === "hanka" ? "Haničko" : "Káťo";
        const presentName = therapist === "hanka" ? "Hanička" : "Káťa";
        const APP_URL = "https://karel-pomoc.lovable.app";
        const meetingLink = `${APP_URL}/chat?meeting=${meetingId}`;

        try {
          await resend.emails.send({
            from: "Karel <karel@karel-pomoc.lovable.app>",
            to: otherEmail,
            subject: `Karel – ${presentName} už je na poradě, čekáme na tebe`,
            html: `
              <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
                <h2>⚠️ ${otherName}, ${presentName} už přispěla k poradě</h2>
                <p><strong>Téma:</strong> ${meeting.topic}</p>
                <p>${presentName} se už vyjádřila a Karel shrnul její příspěvek. Čekáme na tvůj pohled, abychom mohli poradu uzavřít.</p>
                <p style="margin: 24px 0;">
                  <a href="${meetingLink}" style="background: #ef4444; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">
                    Připojit se k poradě →
                  </a>
                </p>
                <p>Karel</p>
              </div>
            `,
          });
          console.log(`Escalation email sent to ${otherTherapist}`);
        } catch (e) {
          console.warn("Escalation email error:", e);
        }
      }

      // Check if Karel suggests finalization
      const shouldFinalize = karelResponse.includes("[ZÁVĚR PORADY]") && meeting.hanka_joined_at && (therapist === "hanka" ? true : meeting.kata_joined_at);

      return new Response(JSON.stringify({
        success: true,
        messages: existingMessages,
        karelResponse,
        suggestsFinalization: shouldFinalize,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ═══ ACTION: FINALIZE MEETING ═══
    if (action === "finalize") {
      const { data: meeting } = await sb.from("did_meetings")
        .select("*")
        .eq("id", meetingId)
        .single();

      if (!meeting) throw new Error("Meeting not found");

      const existingMessages = Array.isArray(meeting.messages) ? meeting.messages : [];

      // Karel generates final summary + tasks
      let summary = "";
      let tasks: any[] = [];

      if (LOVABLE_API_KEY) {
        const conversationContext = existingMessages.map((m: any) => {
          const name = m.therapist === "karel" ? "Karel" : m.therapist === "hanka" ? "Hanička" : "Káťa";
          return `${name}: ${m.content}`;
        }).join("\n\n");

        try {
          const finalRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash",
              messages: [
                {
                  role: "system",
                  content: SYSTEM_RULES + `\n\nJsi Karel. Uzavíráš poradu DID týmu. Vygeneruj:

1. SHRNUTÍ (2-3 odstavce) – co se projednalo, na čem se dohodly
2. ÚKOLY – JSON pole ve formátu:
[{"task": "text úkolu", "assigned_to": "hanka|kata|both", "priority": "high|normal", "category": "porada", "due_date": "YYYY-MM-DD nebo null"}]

Odpověz ve formátu:
[SHRNUTÍ]
text shrnutí
[/SHRNUTÍ]
[ÚKOLY]
JSON pole
[/ÚKOLY]`,
                },
                { role: "user", content: `Téma: ${meeting.topic}\n\nPrůběh:\n${conversationContext}` },
              ],
            }),
          });

          if (finalRes.ok) {
            const d = await finalRes.json();
            const text = d.choices?.[0]?.message?.content || "";
            const summaryMatch = text.match(/\[SHRNUTÍ\]([\s\S]*?)\[\/SHRNUTÍ\]/);
            summary = summaryMatch?.[1]?.trim() || text;

            const tasksMatch = text.match(/\[ÚKOLY\]([\s\S]*?)\[\/ÚKOLY\]/);
            if (tasksMatch) {
              try {
                const cleanJson = tasksMatch[1].trim().replace(/^```json?\n?/i, "").replace(/\n?```$/i, "");
                tasks = JSON.parse(cleanJson);
              } catch {}
            }
          }
        } catch (e) {
          console.warn("Finalization AI error:", e);
          summary = "Porada uzavřena bez AI shrnutí.";
        }
      }

      // Insert tasks into did_therapist_tasks
      for (const t of tasks) {
        try {
          const detailInstruction = t.detail_instruction || t.instruction || [
            `Co udělat: ${t.task}`,
            `Kontext: výstup z porady ${new Date().toISOString().slice(0, 10)} k tématu ${meeting.topic}.`,
            "Další krok: potvrď odpovědnost, první krok a případnou překážku.",
          ].join("\n");
          await sb.from("did_therapist_tasks").insert({
            task: t.task,
            detail_instruction: detailInstruction,
            assigned_to: t.assigned_to || "both",
            priority: t.priority || "normal",
            category: t.category || "porada",
            due_date: t.due_date || null,
            source_agreement: `Porada: ${meeting.topic}`,
            note: `Výstup z porady ${new Date().toISOString().slice(0, 10)}`,
          });
        } catch (e) {
          console.warn("Task insert error:", e);
        }
      }

      // Write summary to kartoteka (pending drive write)
      if (summary) {
        try {
          await sb.from("did_pending_drive_writes").insert({
            content: `═══ ZÁPIS Z PORADY (${new Date().toISOString().slice(0, 10)}) ═══\nTéma: ${meeting.topic}\n\n${summary}\n\nÚkoly:\n${tasks.map(t => `► ${t.task} [${t.assigned_to}] ${t.priority === "high" ? "⚠️" : ""}`).join("\n")}`,
            target_document: "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
            write_type: "append",
            priority: "high",
          });
        } catch (e) {
          console.warn("Drive write error:", e);
        }
      }

      // Update meeting status
      await sb.from("did_meetings").update({
        status: "finalized",
        finalized_at: new Date().toISOString(),
        outcome_summary: summary,
        outcome_tasks: tasks,
        updated_at: new Date().toISOString(),
      }).eq("id", meetingId);

      return new Response(JSON.stringify({ success: true, summary, tasks }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Meeting error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// (parseOrUse removed - no longer needed)

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

function normalizeAuthor(name: string): string {
  const lower = name.toLowerCase().trim();
  if (lower === "karel") return "karel";
  if (["hanička", "hanka", "hanicka"].includes(lower)) return "hanka";
  if (["káťa", "kata", "katka", "káta"].includes(lower)) return "kata";
  return lower;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const today = new Date().toISOString().split("T")[0];
  let overdueCount = 0;
  let followUpsSent = 0;
  let newCommitments = 0;

  try {
    // KROK 1 — Kontrola prošlých závazků
    const { data: overdueCommitments } = await sb
      .from("karel_commitments")
      .select("*")
      .eq("status", "open")
      .lt("due_date", today)
      .order("due_date", { ascending: true });

    overdueCount = overdueCommitments?.length || 0;

    for (const c of overdueCommitments || []) {
      const dueDateMs = new Date(c.due_date).getTime();
      const daysPast = Math.floor((Date.now() - dueDateMs) / 86400000);

      if (daysPast > 7) {
        await sb.from("karel_commitments").update({ status: "broken" }).eq("id", c.id);
        continue;
      }

      if (!c.follow_up_sent && daysPast > 1) {
        await sb.from("did_pending_questions").insert({
          question: `Závazek nebyl splněn: "${c.commitment_text}" (měl být do ${c.due_date}). Jak to vypadá? Potřebujete pomoc nebo prodloužení?`,
          directed_to: c.committed_by === "karel" ? "both" : c.committed_by,
          subject_type: "commitment_followup",
          subject_id: c.id,
          status: "pending",
          expires_at: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        });

        await sb.from("karel_commitments").update({
          follow_up_sent: true,
          follow_up_sent_at: new Date().toISOString(),
        }).eq("id", c.id);

        followUpsSent++;
      }
    }

    // KROK 2 — Extrakce nových závazků z porad za posledních 24h
    const { data: recentMeetings } = await sb
      .from("did_meetings")
      .select("id, topic, messages, created_at")
      .gte("updated_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    for (const meeting of recentMeetings || []) {
      const msgs = Array.isArray(meeting.messages) ? meeting.messages : [];
      for (const msg of msgs) {
        const content = (msg as any)?.content || "";
        const author = (msg as any)?.role || (msg as any)?.author || "";
        const hasKeyword = COMMITMENT_KEYWORDS.some((kw) => content.toLowerCase().includes(kw));
        if (!hasKeyword || !content.trim()) continue;

        const commitmentText = content.slice(0, 300);
        const committedBy = normalizeAuthor(author);

        // Deduplikace
        const { data: existing } = await sb
          .from("karel_commitments")
          .select("id")
          .eq("commitment_text", commitmentText)
          .eq("source_id", meeting.id)
          .limit(1);

        if (existing && existing.length > 0) continue;

        await sb.from("karel_commitments").insert({
          commitment_text: commitmentText,
          committed_by: committedBy,
          source_type: "meeting",
          source_id: meeting.id,
          due_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
          status: "open",
        });

        newCommitments++;
      }
    }

    // KROK 3 — Log
    await sb.from("system_health_log").insert({
      event_type: "follow_through_run",
      severity: "info",
      message: `Follow-through: ${overdueCount} prošlých závazků, ${newCommitments} nových, ${followUpsSent} follow-up odesláno`,
    });

    return new Response(JSON.stringify({
      success: true,
      overdueCount,
      newCommitments,
      followUpsSent,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[FOLLOW-THROUGH] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

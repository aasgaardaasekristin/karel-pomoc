import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type {
  TeamDeliberation,
  DeliberationType,
  DeliberationPriority,
} from "@/types/teamDeliberation";

/**
 * Live hook nad did_team_deliberations + realtime subscribe.
 * Vrací jen otevřené porady (active / awaiting_signoff) — closed/archived
 * se na dashboardu nezobrazují.
 */
export function useTeamDeliberations(refreshTrigger = 0) {
  const [items, setItems] = useState<TeamDeliberation[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const { data, error } = await (supabase as any)
      .from("did_team_deliberations")
      .select("*")
      .in("status", ["active", "awaiting_signoff"])
      .order("priority", { ascending: true })
      .order("updated_at", { ascending: false })
      .limit(50);
    if (error) {
      console.error("[useTeamDeliberations] load failed:", error);
      setItems([]);
    } else {
      setItems((data ?? []) as TeamDeliberation[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload, refreshTrigger]);

  useEffect(() => {
    const ch = (supabase as any)
      .channel("did_team_deliberations_live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "did_team_deliberations" },
        () => reload(),
      )
      .subscribe();
    return () => {
      (supabase as any).removeChannel(ch);
    };
  }, [reload]);

  const create = useCallback(
    async (input: {
      deliberation_type: DeliberationType;
      subject_parts?: string[];
      reason?: string;
      priority?: DeliberationPriority;
      hint?: string;
      linked_crisis_event_id?: string;
    }) => {
      setCreating(true);
      try {
        const { data, error } = await (supabase as any).functions.invoke(
          "karel-team-deliberation-create",
          { body: input },
        );
        if (error) throw error;
        await reload();
        return (data as any)?.deliberation as TeamDeliberation | null;
      } finally {
        setCreating(false);
      }
    },
    [reload],
  );

  const sign = useCallback(
    async (deliberationId: string, signer: "hanka" | "kata" | "karel") => {
      const { data, error } = await (supabase as any).functions.invoke(
        "karel-team-deliberation-signoff",
        { body: { deliberation_id: deliberationId, signer } },
      );
      if (error) throw error;
      await reload();
      return data as {
        deliberation: TeamDeliberation;
        bridged_plan_id: string | null;
        crisis_effects?: Record<string, any>;
      };
    },
    [reload],
  );

  const synthesize = useCallback(
    async (deliberationId: string) => {
      const { data, error } = await (supabase as any).functions.invoke(
        "karel-team-deliberation-synthesize",
        { body: { deliberation_id: deliberationId } },
      );
      if (error) throw error;
      await reload();
      return data as { deliberation: TeamDeliberation; synthesis: any };
    },
    [reload],
  );

  /**
   * INVALIDATION RULE:
   * Jakákoliv nová odpověď nebo nová diskusní zpráva musí zneplatnit
   * Karlovu předchozí syntézu — jinak by Karel mohl podepsat na základě
   * zastaralé syntézy. Vždycky vynulujeme:
   *   - karel_synthesis
   *   - karel_synthesized_at
   *   - final_summary
   * Tím se v UI gate Karlova podpisu znovu vrátí do stavu „čeká na syntézu".
   */
  const invalidateSynthesis = (
    target: TeamDeliberation,
  ): Record<string, any> => {
    if (!target.karel_synthesis && !target.karel_synthesized_at && !target.final_summary) {
      return {};
    }
    return {
      karel_synthesis: null,
      karel_synthesized_at: null,
      final_summary: null,
    };
  };

  const answerQuestion = useCallback(
    async (
      deliberationId: string,
      who: "hanka" | "kata",
      questionIndex: number,
      answer: string,
    ) => {
      const target = items.find((d) => d.id === deliberationId);
      if (!target) return;
      const fieldName = who === "hanka" ? "questions_for_hanka" : "questions_for_kata";
      const list = [...((target as any)[fieldName] ?? [])];
      if (!list[questionIndex]) return;
      list[questionIndex] = {
        ...list[questionIndex],
        answer,
        answered_at: new Date().toISOString(),
      };
      const patch: Record<string, any> = {
        [fieldName]: list,
        ...invalidateSynthesis(target),
      };
      const { error } = await (supabase as any)
        .from("did_team_deliberations")
        .update(patch)
        .eq("id", deliberationId);
      if (error) throw error;
      await reload();
    },
    [items, reload],
  );

  const postMessage = useCallback(
    async (
      deliberationId: string,
      author: "karel" | "hanka" | "kata",
      content: string,
    ) => {
      const target = items.find((d) => d.id === deliberationId);
      if (!target) return;
      const log = [
        ...(target.discussion_log ?? []),
        { author, content, created_at: new Date().toISOString() },
      ];
      const patch: Record<string, any> = {
        discussion_log: log,
        ...invalidateSynthesis(target),
      };
      const { error } = await (supabase as any)
        .from("did_team_deliberations")
        .update(patch)
        .eq("id", deliberationId);
      if (error) throw error;
      await reload();
    },
    [items, reload],
  );

  return { items, loading, creating, create, sign, synthesize, answerQuestion, postMessage, reload };
}

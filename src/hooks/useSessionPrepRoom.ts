/**
 * useSessionPrepRoom
 *
 * Resolver pro vazbu mezi `did_daily_session_plans` (finální dnešní plán)
 * a `did_team_deliberations` typu `session_plan` (přípravná místnost).
 *
 * Pravidlo (závazné):
 *   - Session prep room JE porada typu `session_plan` v `did_team_deliberations`.
 *   - Po trojnásobném podpisu se její obsah propíše bridgem (signoff edge fn)
 *     do `did_daily_session_plans` a `linked_live_session_id` zpětně ukáže
 *     na vytvořený plán.
 *   - Plán bez navázané approved porady NESMÍ mít aktivní "Zahájit sezení" CTA
 *     v Pracovně.
 *
 * Tento hook najde poradu navázanou na konkrétní `daily_plan_id`:
 *   - PRIMÁRNÍ: WHERE linked_live_session_id = :daily_plan_id
 *   - SEKUNDÁRNÍ (bez bridge — porada je rozpracovaná, plán ještě nevznikl):
 *     vyhledává podle subject_parts + plan_date, ale ten případ tady neřešíme,
 *     protože pokud plán už existuje, bridge proběhl a primární vazba existuje.
 *
 * Pokud žádná porada NENÍ navázaná (legacy plán nebo auto-generovaný „Nový plán“
 * mimo deliberation flow), `create()` založí novou session_plan poradu pro
 * tento existující plán, aby tým mohl dodatečně podepsat.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { TeamDeliberation } from "@/types/teamDeliberation";

export interface SessionPrepRoomState {
  /** Navázaná porada (session_plan) — pokud existuje. */
  deliberation: TeamDeliberation | null;
  loading: boolean;
  /** Vytvoří novou session_plan poradu pro existující plán. */
  createForExistingPlan: (input: {
    daily_plan_id: string;
    part_name: string;
    plan_markdown: string;
    led_by?: "Hanička" | "Káťa" | "společně";
  }) => Promise<TeamDeliberation | null>;
  reload: () => Promise<void>;
}

export function useSessionPrepRoom(dailyPlanId: string | null): SessionPrepRoomState {
  const [deliberation, setDeliberation] = useState<TeamDeliberation | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!dailyPlanId) {
      setDeliberation(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await (supabase as any)
        .from("did_team_deliberations")
        .select("*")
        .eq("deliberation_type", "session_plan")
        .eq("linked_live_session_id", dailyPlanId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        console.error("[useSessionPrepRoom] load failed:", error);
        setDeliberation(null);
      } else {
        setDeliberation((data as TeamDeliberation) ?? null);
      }
    } finally {
      setLoading(false);
    }
  }, [dailyPlanId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Realtime — když dojde k podpisu / synthesise / odpovědi, refresh.
  useEffect(() => {
    if (!dailyPlanId) return;
    const ch = (supabase as any)
      .channel(`prep_room_${dailyPlanId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "did_team_deliberations",
          filter: `linked_live_session_id=eq.${dailyPlanId}`,
        },
        () => reload(),
      )
      .subscribe();
    return () => {
      (supabase as any).removeChannel(ch);
    };
  }, [dailyPlanId, reload]);

  const createForExistingPlan: SessionPrepRoomState["createForExistingPlan"] =
    useCallback(
      async ({ daily_plan_id, part_name, plan_markdown, led_by = "Hanička" }) => {
        const titleHint = `Příprava sezení s ${part_name}`;
        const introBrief = [
          `📅 **${titleHint}** (vede ${led_by})`,
          "",
          "Tato příprava vznikla nad existujícím dnešním plánem. Projděte osnovu, doplňte odpovědi na otázky, a teprve potom plán podepište.",
        ].join("\n");

        const sessionParams = {
          part_name,
          led_by,
          session_format: led_by === "společně" ? "joint" : "individual",
          duration_min: null,
          why_today: null,
          kata_involvement: null,
        };

        const prefill = {
          title: titleHint,
          reason: `Dodatečná týmová příprava existujícího plánu na dnešek.`,
          initial_karel_brief: introBrief,
          karel_proposed_plan: plan_markdown,
          agenda_outline: [],
          questions_for_hanka: [],
          questions_for_kata: [],
          session_params: sessionParams,
        };

        const { data, error } = await (supabase as any).functions.invoke(
          "karel-team-deliberation-create",
          {
            body: {
              deliberation_type: "session_plan",
              subject_parts: [part_name],
              reason: prefill.reason,
              hint: titleHint,
              priority: "normal",
              prefill,
            },
          },
        );
        if (error) {
          console.error("[useSessionPrepRoom] create failed:", error);
          return null;
        }
        const created = (data as any)?.deliberation as TeamDeliberation | null;
        if (!created?.id) return null;

        // Backref do plánu: linked_live_session_id už ukazuje na NEW plán
        // jen po bridgi (v signoff funkci). Tady plán existuje předem, takže
        // si ho navážeme manuálně, aby další reload ho našel.
        const { error: backrefErr } = await (supabase as any)
          .from("did_team_deliberations")
          .update({ linked_live_session_id: daily_plan_id })
          .eq("id", created.id);
        if (backrefErr) {
          console.warn(
            "[useSessionPrepRoom] backref linked_live_session_id failed:",
            backrefErr,
          );
        }

        await reload();
        return created;
      },
      [reload],
    );

  return { deliberation, loading, createForExistingPlan, reload };
}

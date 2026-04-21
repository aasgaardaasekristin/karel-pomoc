/**
 * KarelOverviewPanel — Decision deck (Karlův přehled)
 *
 * Surface Reorganization Pass (2026-04-20):
 *  Tato plocha je „kde mluví Karel". Soustředí derived rozhodovací vrstvy:
 *    1. Karlův denní briefing (DidDailyBriefingPanel — kanonický narativ).
 *    2. Therapist Intelligence Foundation (read-only mini-views z WM snapshotu).
 *    3. Part Intelligence Foundation (read-only mini-views z WM snapshotu).
 *
 *  Není to admin a není to dashboard:
 *    - žádný operativní queue board
 *    - žádný technický inspect dump (raw WM zůstává v Adminu)
 *    - žádné writery / bootstrap akce
 *
 *  Data jsou přečtená přímo z `karel_working_memory_snapshots.snapshot_json`
 *  pro dnešní `snapshot_key` (Prague day) — žádná nová backend cesta.
 */

import { useEffect, useState, useCallback } from "react";
import { Brain, Sparkles, Users, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { pragueTodayISO } from "@/lib/dateOnlyTaskHelpers";
import ErrorBoundary from "@/components/ErrorBoundary";
import DidDailyBriefingPanel from "./DidDailyBriefingPanel";
// Emergency Simplification Pass (2026-04-21): KarelCrisisDeficits + DailyDecisionTasks
// odstraněny z Karlova přehledu (duplicitní vývěska pod briefingem).

interface TherapistStateMini {
  therapist: "hanka" | "kata";
  activity: { recentness: string };
  support_need: { level: string; rationale: string };
  continuity: { open_tasks_direct: number; open_tasks_shared: number; rationale: string };
  confidence: { overall: number; insufficient_data: boolean };
}

interface PartStateMini {
  part_name: string;
  part_name_normalized: string;
  activity: { recentness: string };
  stability_signal: { level: string };
  risk_signal: { level: string; has_open_crisis: boolean; crisis_severity: string | null };
  continuity: { trajectory: string };
  care_priority: { level: string };
  confidence: { overall: number };
}

interface FoundationData {
  generated_at?: string | null;
  therapist_state?: {
    version: string;
    hanka: TherapistStateMini;
    kata: TherapistStateMini;
  } | null;
  part_state?: {
    version: string;
    parts: PartStateMini[];
    summary: {
      total_parts: number;
      parts_with_open_crisis: number;
      parts_active_today: number;
      parts_silent: number;
      avg_confidence: number | null;
    };
  } | null;
}

interface Props {
  refreshTrigger?: number;
  onOpenDeliberation?: (id: string) => void;
  /**
   * Workspace Pass (2026-04-21):
   *  - "standalone" — historický mód (vlastní min-h-screen + own padding).
   *  - "embedded"   — sekce uvnitř Pracovny: žádný vlastní viewport wrapper,
   *                  žádný horní padding, vnější layout drží Pracovna.
   * Default zachováván jako "standalone" kvůli zpětné kompatibilitě
   * (kdyby panel ještě někde žil mimo Pracovnu).
   */
  variant?: "standalone" | "embedded";
}

const SUPPORT_TONE: Record<string, string> = {
  low: "text-muted-foreground",
  moderate: "text-primary",
  elevated: "text-destructive",
  unknown: "text-muted-foreground",
};

const RISK_TONE: Record<string, string> = {
  low: "text-muted-foreground",
  moderate: "text-primary",
  elevated: "text-accent-foreground",
  critical: "text-destructive",
  unknown: "text-muted-foreground",
};

const CARE_LABEL: Record<string, string> = {
  background: "Pozadí",
  watch: "Sledovat",
  support: "Podpora",
  active_care: "Aktivní péče",
  crisis_focus: "Krizový fokus",
};

const RECENTNESS_LABEL: Record<string, string> = {
  active_today: "dnes",
  active_week: "tento týden",
  stale: "starší",
  silent: "ticho",
};

const TRAJECTORY_LABEL: Record<string, string> = {
  stable: "stabilní",
  changed: "změna",
  newly_active: "nově aktivní",
  recently_quiet: "ztišila se",
  unknown: "—",
};

function loadFoundationFromSnapshot(snapshot: any): FoundationData {
  const summary = snapshot?.summary || {};
  return {
    generated_at: snapshot?.generated_at || summary?.generated_at || null,
    therapist_state: summary?.therapist_state || null,
    part_state: summary?.part_state || null,
  };
}

const KarelOverviewPanel = ({
  refreshTrigger = 0,
  onOpenDeliberation,
  variant = "standalone",
}: Props) => {
  const [foundation, setFoundation] = useState<FoundationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [internalRefresh, setInternalRefresh] = useState(0);

  const loadFoundation = useCallback(async () => {
    setLoading(true);
    try {
      const today = pragueTodayISO();
      const { data, error } = await supabase
        .from("karel_working_memory_snapshots")
        .select("snapshot_json, generated_at")
        .eq("snapshot_key", today)
        .order("generated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      setFoundation(data ? loadFoundationFromSnapshot(data.snapshot_json) : null);
    } catch (e) {
      console.warn("[KarelOverviewPanel] foundation load failed", e);
      setFoundation(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFoundation();
  }, [loadFoundation, refreshTrigger, internalRefresh]);

  // Embedded mód: žádný vlastní min-h-screen wrapper, žádný horní padding,
  // vnější layout drží Pracovna. Ostatní obsah (header + 3 bloky) sdílí.
  const isEmbedded = variant === "embedded";

  const content = (
    <div className={isEmbedded ? "space-y-4" : "relative z-10 mx-auto max-w-[900px] space-y-4 px-4 py-6"}>
      {/* Header — minimal, jen marker pro „decision deck" */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Brain className="h-4 w-4 text-primary" />
          <span className="font-serif tracking-wide">Karlův přehled</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-3 text-[12px] text-muted-foreground hover:text-foreground"
          onClick={() => setInternalRefresh((n) => n + 1)}
        >
          <RefreshCw className="h-3 w-3" /> Obnovit
        </Button>
      </div>

      {/* ── BLOCK A — Karlův denní briefing (single source of truth) ── */}
      <div className="jung-hero-section rounded-2xl p-4">
        <ErrorBoundary fallbackTitle="Karlův přehled selhal">
          <DidDailyBriefingPanel
            refreshTrigger={refreshTrigger + internalRefresh}
            onOpenDeliberation={onOpenDeliberation}
          />
        </ErrorBoundary>
      </div>

      {/* Emergency Simplification Pass (2026-04-21):
            DailyDecisionTasks i KarelCrisisDeficits ODSTRANĚNY z Karlova přehledu.
            Důvod: porušovaly základní logiku obrazovky — pod briefingem se objevila
            druhá vývěska se stejnou krizovou/rozhodovací informací. Karlův přehled
            je teď JEDEN souvislý decision layer (briefing) + read-only foundation.
            Krizová signalizace = CrisisAlert (nahoře). Operativní krizové karty
            = CommandCrisisCard (níže v DidDashboard). */}

      {/* ── BLOCK B — Therapist Intelligence Foundation (read-only) ── */}
      <div className="jung-card p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-serif">
          <Sparkles className="h-4 w-4 text-primary" />
          <span>Stav terapeutek</span>
          {foundation?.therapist_state && (
            <span className="text-[10px] font-light text-muted-foreground ml-auto">
              Foundation {foundation.therapist_state.version}
            </span>
          )}
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Načítám…
          </div>
        ) : foundation?.therapist_state ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <TherapistMiniCard name="Hanička" state={foundation.therapist_state.hanka} />
            <TherapistMiniCard name="Káťa" state={foundation.therapist_state.kata} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Foundation zatím není ve dnešním WM snapshotu. Spusť „Obnovit" nebo počkej na další WM bootstrap.
          </p>
        )}
      </div>

      {/* ── BLOCK C — Part Intelligence Foundation (read-only) ── */}
      <div className="jung-card p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-serif">
          <Users className="h-4 w-4 text-primary" />
          <span>Stav částí</span>
          {foundation?.part_state && (
            <span className="text-[10px] font-light text-muted-foreground ml-auto">
              Foundation {foundation.part_state.version}
            </span>
          )}
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Načítám…
          </div>
        ) : foundation?.part_state ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <MiniStat label="Celkem" value={foundation.part_state.summary.total_parts} />
              <MiniStat
                label="V krizi"
                value={foundation.part_state.summary.parts_with_open_crisis}
                tone={foundation.part_state.summary.parts_with_open_crisis > 0 ? "danger" : "neutral"}
              />
              <MiniStat label="Aktivní dnes" value={foundation.part_state.summary.parts_active_today} />
              <MiniStat label="Ticho" value={foundation.part_state.summary.parts_silent} />
            </div>

            {foundation.part_state.parts.length > 0 ? (
              <div className="space-y-1.5 max-h-[24rem] overflow-y-auto pr-1">
                {foundation.part_state.parts
                  .slice()
                  .sort((a, b) => carePriorityRank(b.care_priority.level) - carePriorityRank(a.care_priority.level))
                  .map((p) => (
                    <PartMiniRow key={p.part_name_normalized} part={p} />
                  ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Žádné části zatím v foundation vrstvě nejsou.
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Foundation zatím není ve dnešním WM snapshotu. Spusť „Obnovit" nebo počkej na další WM bootstrap.
          </p>
        )}
      </div>

      {foundation?.generated_at && (
        <p className="text-[10px] text-muted-foreground text-center">
          Foundation generována: {new Date(foundation.generated_at).toLocaleString("cs")}
        </p>
      )}
    </div>
  );

  if (isEmbedded) return content;

  return (
    <div className="min-h-screen" data-no-swipe-back="true">
      {content}
    </div>
  );
};

function carePriorityRank(level: string): number {
  switch (level) {
    case "crisis_focus": return 4;
    case "active_care": return 3;
    case "support": return 2;
    case "watch": return 1;
    default: return 0;
  }
}

function MiniStat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "danger";
}) {
  return (
    <div className="rounded-lg bg-muted/40 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-base font-serif ${tone === "danger" ? "text-destructive" : "text-foreground"}`}>
        {value}
      </div>
    </div>
  );
}

function TherapistMiniCard({ name, state }: { name: string; state: TherapistStateMini }) {
  const supportTone = SUPPORT_TONE[state.support_need.level] || SUPPORT_TONE.unknown;
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-3 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="font-serif text-sm">{name}</span>
        <span className="text-[10px] text-muted-foreground">
          {RECENTNESS_LABEL[state.activity.recentness] || state.activity.recentness}
        </span>
      </div>
      <div className={`text-xs ${supportTone}`}>
        Potřeba podpory: <strong>{state.support_need.level}</strong>
      </div>
      <div className="text-[11px] text-muted-foreground leading-snug">
        {state.support_need.rationale}
      </div>
      <div className="text-[10px] text-muted-foreground pt-1 border-t border-border/40">
        Otevřené úkoly: {state.continuity.open_tasks_direct} přímé · {state.continuity.open_tasks_shared} sdílené ·
        confidence {Math.round((state.confidence.overall ?? 0) * 100)}%
        {state.confidence.insufficient_data && " · málo dat"}
      </div>
    </div>
  );
}

function PartMiniRow({ part }: { part: PartStateMini }) {
  const riskTone = RISK_TONE[part.risk_signal.level] || RISK_TONE.unknown;
  return (
    <div className="rounded-lg border border-border/40 bg-card/30 p-2 flex items-center gap-3 text-xs">
      <div className="font-serif min-w-[6rem] truncate">{part.part_name}</div>
      <div className={`min-w-[5.5rem] ${riskTone}`}>
        {part.risk_signal.has_open_crisis ? "🔴 " : ""}
        {part.risk_signal.level}
      </div>
      <div className="min-w-[5rem] text-muted-foreground">
        {RECENTNESS_LABEL[part.activity.recentness] || "—"}
      </div>
      <div className="min-w-[6rem] text-muted-foreground">
        {TRAJECTORY_LABEL[part.continuity.trajectory] || "—"}
      </div>
      <div className="ml-auto text-[10px] text-foreground">
        {CARE_LABEL[part.care_priority.level] || part.care_priority.level}
      </div>
    </div>
  );
}

export default KarelOverviewPanel;

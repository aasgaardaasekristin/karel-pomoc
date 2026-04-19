/**
 * DidDailyBriefingPanel
 *
 * Single source of truth pro Karlův denní hlas na DID dashboardu.
 * Čte výhradně z tabulky `did_daily_briefings` (generuje edge funkce
 * `karel-did-daily-briefing`). UI nikdy briefing nesestavuje samo —
 * jen ho renderuje.
 *
 * 2026-04-19 — VERTICAL SLICE 1:
 *  - Položky `ask_hanka`, `ask_kata`, `decisions` a `proposed_session`
 *    jsou plně klikatelné a otevírají správný workspace:
 *      ask_hanka     → /chat?did_submode=mamka  (Kdo mluví s Karlem / Hanička)
 *      ask_kata      → /chat?did_submode=kata   (Káťa)
 *      decisions     → /chat?didFlowState=meeting&meeting_topic=...
 *      proposed_session → /chat?did_submode=mamka&session_part=...
 *  - Před každou navigací nastavíme `karel_briefing_return = "1"`
 *    v sessionStorage. Router (`DidContentRouter`) tento flag respektuje
 *    při Back a vrátí uživatele přímo do `terapeut` dashboardu (kde
 *    žije tento briefing), ne o úroveň výš mimo režim.
 */

import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import {
  Loader2, RefreshCw, Sparkles, CalendarDays, Users, AlertTriangle, ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

interface BriefingDecision {
  title: string;
  reason: string;
  type: "crisis" | "session_plan" | "clinical_decision" | "follow_up_review" | "supervision";
  part_name?: string;
}

interface ProposedSession {
  part_name: string;
  why_today: string;
  led_by: "Hanička" | "Káťa" | "společně";
  duration_min?: number;
  first_draft: string;
  kata_involvement?: string;
}

interface BriefingPayload {
  greeting: string;
  last_3_days: string;
  lingering?: string;
  decisions: BriefingDecision[];
  proposed_session?: ProposedSession | null;
  ask_hanka: string[];
  ask_kata: string[];
  waiting_for?: string[];
  closing: string;
}

interface BriefingRow {
  id: string;
  briefing_date: string;
  payload: BriefingPayload;
  generated_at: string;
  is_stale: boolean;
  proposed_session_part_id: string | null;
  decisions_count: number;
}

interface Props {
  refreshTrigger?: number;
  /** Otevře poradní místnost pro daný deliberation. Briefing decisions
   *  zatím poradu samy nezakládají — to je práce následujícího passu. */
  onOpenDeliberation?: (deliberationId: string) => void;
}

const TYPE_LABEL: Record<BriefingDecision["type"], string> = {
  crisis: "Krize",
  session_plan: "Plán sezení",
  clinical_decision: "Klinické rozhodnutí",
  follow_up_review: "Vyhodnocení sezení",
  supervision: "Supervize",
};

const TYPE_TONE: Record<BriefingDecision["type"], string> = {
  crisis: "bg-destructive/15 text-destructive border-destructive/30",
  session_plan: "bg-primary/10 text-primary border-primary/20",
  clinical_decision: "bg-accent/15 text-accent-foreground border-accent/30",
  follow_up_review: "bg-muted text-muted-foreground border-border",
  supervision: "bg-amber-500/15 text-amber-700 border-amber-500/30",
};

const formatDate = (iso: string): string => {
  try {
    const d = new Date(`${iso}T12:00:00`);
    return new Intl.DateTimeFormat("cs-CZ", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(d);
  } catch {
    return iso;
  }
};

const SectionHead = ({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) => (
  <h3 className="text-[12px] font-medium text-foreground/80 flex items-center gap-1.5 uppercase tracking-wide">
    {icon}
    {children}
  </h3>
);

const NarrativeDivider = () => (
  <div className="my-4 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
);

/**
 * Mark this navigation as originating from the briefing panel so that
 * `DidContentRouter` can route Back back to the `terapeut` dashboard
 * instead of dropping the user one level too high (e.g. /hub).
 *
 * The flag is consumed once and then cleared — re-entering the workspace
 * directly (without coming from the briefing) must NOT short-circuit Back.
 */
const markBriefingOrigin = () => {
  try {
    sessionStorage.setItem("karel_briefing_return", "1");
    sessionStorage.setItem("karel_hub_section", "did");
  } catch { /* ignore quota */ }
};

const DidDailyBriefingPanel = ({ refreshTrigger, onOpenDeliberation }: Props) => {
  const navigate = useNavigate();
  const [briefing, setBriefing] = useState<BriefingRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);

  const loadLatest = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("did_daily_briefings")
        .select("*")
        .eq("is_stale", false)
        .order("briefing_date", { ascending: false })
        .order("generated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      setBriefing((data as unknown as BriefingRow) ?? null);
    } catch (e) {
      console.error("[DidDailyBriefingPanel] load failed:", e);
      setBriefing(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLatest();
  }, [loadLatest, refreshTrigger]);

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke("karel-did-daily-briefing", {
        body: { method: "manual", force: true },
      });
      if (error) throw error;
      if (data?.briefing) {
        setBriefing(data.briefing);
        toast.success("Karlův přehled byl přegenerován.");
      } else {
        await loadLatest();
      }
    } catch (e: any) {
      console.error("[DidDailyBriefingPanel] regenerate failed:", e);
      toast.error(e?.message || "Generování briefingu selhalo.");
    } finally {
      setRegenerating(false);
    }
  };

  // ─── Navigation helpers ───
  // Each helper sets the briefing-return flag BEFORE navigating, so the
  // router can resolve Back to the terapeut dashboard.
  const openHankaWorkspace = (askText: string) => {
    markBriefingOrigin();
    const params = new URLSearchParams({
      did_submode: "mamka",
      briefing_ask: askText.slice(0, 200),
    });
    navigate(`/chat?${params.toString()}`);
  };

  const openKataWorkspace = (askText: string) => {
    markBriefingOrigin();
    const params = new URLSearchParams({
      did_submode: "kata",
      briefing_ask: askText.slice(0, 200),
    });
    navigate(`/chat?${params.toString()}`);
  };

  const openDecisionMeeting = (d: BriefingDecision) => {
    markBriefingOrigin();
    // Persist a structured seed so DidMeetingPanel can render Karel's intro
    // properly instead of an empty meeting.
    try {
      sessionStorage.setItem(
        "karel_meeting_seed",
        JSON.stringify({
          topic: d.title,
          reason: d.reason,
          karelProposal: `Toto rozhodnutí jsem pojmenoval v dnešním přehledu jako: ${d.title}. Důvod: ${d.reason}`,
          questionsHanka: `Haničko, jaký je tvůj pohled na: ${d.title}?`,
          questionsKata: `Káťo, jaký je tvůj pohled na: ${d.title}?`,
          source: "briefing",
          decisionType: d.type,
          partName: d.part_name ?? null,
        }),
      );
    } catch { /* ignore */ }
    const params = new URLSearchParams({
      didFlowState: "meeting",
      meeting_topic: d.title.slice(0, 80),
    });
    navigate(`/chat?${params.toString()}`);
  };

  const openProposedSession = (s: ProposedSession) => {
    markBriefingOrigin();
    const params = new URLSearchParams({
      did_submode: "mamka",
      session_part: s.part_name,
      briefing_session: "1",
    });
    navigate(`/chat?${params.toString()}`);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!briefing) {
    return (
      <div className="space-y-3 p-4 rounded-xl border border-dashed border-border/60 bg-card/30">
        <div className="flex items-start gap-2">
          <Sparkles className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-sm text-foreground/80">
              Pro dnešek zatím nemám připravený přehled.
            </p>
            <p className="text-[12px] text-muted-foreground mt-1">
              Můžete ho vygenerovat ručně. Jinak vznikne ranním cyklem.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleRegenerate}
          disabled={regenerating}
          className="text-[12px]"
        >
          {regenerating ? (
            <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
          ) : (
            <Sparkles className="w-3 h-3 mr-1.5" />
          )}
          Vygenerovat dnešní přehled
        </Button>
      </div>
    );
  }

  const p = briefing.payload;
  const hasProposed = !!p.proposed_session?.part_name;
  const decisions = (p.decisions ?? []).slice(0, 3);

  return (
    <div className="space-y-1">
      {/* Header — datum + meta + refresh */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-primary/70" />
          <div>
            <h2 className="text-sm font-medium text-foreground">Karlův přehled</h2>
            <p className="text-[11px] text-muted-foreground">
              {formatDate(briefing.briefing_date)}
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={handleRegenerate}
          disabled={regenerating}
          className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {regenerating ? (
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3 mr-1" />
          )}
          Přegenerovat
        </Button>
      </div>

      {/* 1. Greeting + dnešní hlavní priorita */}
      <p className="text-[14px] leading-relaxed text-foreground/90 whitespace-pre-line">
        {p.greeting}
      </p>

      {/* 2. Co se změnilo za poslední 3 dny */}
      {p.last_3_days && (
        <>
          <NarrativeDivider />
          <SectionHead>Za poslední tři dny</SectionHead>
          <p className="text-[13px] leading-relaxed text-foreground/80 mt-2 whitespace-pre-line">
            {p.last_3_days}
          </p>
        </>
      )}

      {/* 3. Co zůstává významné z dřívějška */}
      {p.lingering && (
        <>
          <NarrativeDivider />
          <SectionHead>Z dřívějška zůstává podstatné</SectionHead>
          <p className="text-[13px] leading-relaxed text-foreground/80 mt-2 whitespace-pre-line">
            {p.lingering}
          </p>
        </>
      )}

      {/* 4. Dnešní navržené sezení — klikatelné */}
      {hasProposed && p.proposed_session && (
        <>
          <NarrativeDivider />
          <SectionHead icon={<Sparkles className="w-3.5 h-3.5 text-primary" />}>
            Dnešní navržené sezení
          </SectionHead>
          <button
            type="button"
            onClick={() => openProposedSession(p.proposed_session!)}
            className="mt-2 w-full text-left p-3 rounded-lg border border-primary/20 bg-primary/5 hover:bg-primary/10 transition-colors space-y-2 cursor-pointer"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <Badge className="text-[10px] h-5 px-2 bg-primary/15 text-primary border-primary/30">
                {p.proposed_session.part_name}
              </Badge>
              <Badge className="text-[10px] h-5 px-2 bg-muted text-muted-foreground border-border">
                vede {p.proposed_session.led_by}
              </Badge>
              {p.proposed_session.duration_min && (
                <Badge className="text-[10px] h-5 px-2 bg-muted text-muted-foreground border-border">
                  ~{p.proposed_session.duration_min} min
                </Badge>
              )}
              <ArrowRight className="w-3.5 h-3.5 text-primary/60 ml-auto" />
            </div>
            <p className="text-[13px] leading-relaxed text-foreground/85 whitespace-pre-line">
              {p.proposed_session.why_today}
            </p>
            <div className="text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line">
              <span className="text-muted-foreground italic">První pracovní verze: </span>
              {p.proposed_session.first_draft}
            </div>
            {p.proposed_session.kata_involvement && (
              <p className="text-[12px] text-muted-foreground italic whitespace-pre-line">
                {p.proposed_session.kata_involvement}
              </p>
            )}
            <p className="text-[11px] text-primary/70 italic">
              Otevřít plán sezení →
            </p>
          </button>
        </>
      )}

      {/* 5. Co potřebuji od Haničky — KLIKATELNÉ */}
      {p.ask_hanka?.length > 0 && (
        <>
          <NarrativeDivider />
          <SectionHead>Haničko, potřebuji od tebe</SectionHead>
          <ul className="mt-2 space-y-1.5">
            {p.ask_hanka.map((item, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => openHankaWorkspace(item)}
                  className="w-full text-left flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-primary/5 transition-colors cursor-pointer group"
                >
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/40 group-hover:bg-primary/70 transition-colors" />
                  <span className="text-[13px] text-foreground/80 leading-relaxed flex-1">
                    {item}
                  </span>
                  <ArrowRight className="w-3 h-3 text-muted-foreground/40 group-hover:text-primary/70 mt-1 shrink-0 transition-colors" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* 6. Co potřebuji od Káti — KLIKATELNÉ */}
      {p.ask_kata?.length > 0 && (
        <>
          <NarrativeDivider />
          <SectionHead>Káťo, potřebuji od tebe</SectionHead>
          <ul className="mt-2 space-y-1.5">
            {p.ask_kata.map((item, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => openKataWorkspace(item)}
                  className="w-full text-left flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/5 transition-colors cursor-pointer group"
                >
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent/40 group-hover:bg-accent/70 transition-colors" />
                  <span className="text-[13px] text-foreground/80 leading-relaxed flex-1">
                    {item}
                  </span>
                  <ArrowRight className="w-3 h-3 text-muted-foreground/40 group-hover:text-accent/70 mt-1 shrink-0 transition-colors" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* 7. Společná porada týmu — KLIKATELNÉ → otevírá meeting */}
      {decisions.length > 0 && (
        <>
          <NarrativeDivider />
          <SectionHead icon={<Users className="w-3.5 h-3.5 text-primary" />}>
            Dnes potřebujeme rozhodnout společně
          </SectionHead>
          <ol className="mt-2 space-y-2">
            {decisions.map((d, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => openDecisionMeeting(d)}
                  className="w-full text-left rounded-lg border border-border/60 bg-card/40 hover:bg-card/70 hover:border-primary/30 p-3 space-y-1.5 transition-colors cursor-pointer group"
                >
                  <div className="flex items-start gap-2">
                    <span className="text-[11px] text-muted-foreground font-mono mt-0.5">
                      {i + 1}.
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap mb-1">
                        <Badge
                          className={`text-[9px] h-4 px-1.5 border ${TYPE_TONE[d.type] ?? TYPE_TONE.clinical_decision}`}
                        >
                          {d.type === "crisis" && <AlertTriangle className="w-2.5 h-2.5 mr-0.5" />}
                          {TYPE_LABEL[d.type] ?? d.type}
                        </Badge>
                        {d.part_name && (
                          <Badge className="text-[9px] h-4 px-1.5 bg-muted text-muted-foreground border-border">
                            {d.part_name}
                          </Badge>
                        )}
                      </div>
                      <p className="text-[13px] font-medium text-foreground leading-snug">
                        {d.title}
                      </p>
                      <p className="text-[12px] text-foreground/70 leading-relaxed mt-1">
                        {d.reason}
                      </p>
                    </div>
                    <ArrowRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-primary/70 shrink-0 mt-0.5 transition-colors" />
                  </div>
                </button>
              </li>
            ))}
          </ol>
          <p className="mt-2 text-[11px] text-muted-foreground italic">
            Kliknutím otevřete poradní místnost s podklady.
          </p>
        </>
      )}

      {/* 8. Na co čekám — POUZE pokud není duplicita s decisions / ask sekcemi.
          Filtrujeme: položka, která se už objevuje v ask_hanka/ask_kata/decisions
          (case-insensitive substring), se zde nezobrazí. */}
      {(() => {
        const askedTexts = [
          ...(p.ask_hanka ?? []),
          ...(p.ask_kata ?? []),
          ...decisions.map(d => d.title),
        ].map(s => s.toLowerCase().slice(0, 40));

        const filteredWaiting = (p.waiting_for ?? []).filter(item => {
          const key = item.toLowerCase().slice(0, 40);
          return !askedTexts.some(a => a && (a.includes(key) || key.includes(a)));
        });

        if (filteredWaiting.length === 0) return null;

        return (
          <>
            <NarrativeDivider />
            <SectionHead>Ještě si potřebuji ujasnit</SectionHead>
            <ul className="mt-2 space-y-1.5">
              {filteredWaiting.map((item, i) => (
                <li key={i} className="text-[13px] text-foreground/75 flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
                  <span className="leading-relaxed">{item}</span>
                </li>
              ))}
            </ul>
          </>
        );
      })()}

      {/* 9. Uzávěr */}
      {p.closing && (
        <>
          <NarrativeDivider />
          <p className="text-[13px] leading-relaxed text-foreground/75 italic whitespace-pre-line">
            {p.closing}
          </p>
        </>
      )}
    </div>
  );
};

export default DidDailyBriefingPanel;

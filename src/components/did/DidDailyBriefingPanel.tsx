/**
 * DidDailyBriefingPanel
 *
 * Single source of truth pro Karlův denní hlas na DID dashboardu.
 * Čte výhradně z tabulky `did_daily_briefings` (generuje edge funkce
 * `karel-did-daily-briefing`). UI nikdy briefing nesestavuje samo —
 * jen ho renderuje.
 *
 * 2026-04-19 — VERTICAL SLICE 2:
 *  Klikatelné položky NEJSOU query-param shimy. Každý klik vede do
 *  KANONICKÉHO PERSISTENTNÍHO targetu:
 *
 *  - ask_hanka / ask_kata
 *      → did_threads s `workspace_type = 'ask_hanka' | 'ask_kata'`,
 *        `workspace_id = item.id` (stabilní serverové UUID v payloadu).
 *      Druhý klik na stejný ask otevře tentýž thread (přes
 *      `useDidThreads.getThreadByWorkspace`). První klik vlákno lazy-založí
 *      a vepíše Karlův úvod jako první assistant message.
 *
 *  - decisions  → karel-team-deliberation-create (typ podle d.type)
 *      → otevře persistentní `did_team_deliberations` přes
 *        `?deliberation_id=<id>`. Druhý klik nezakládá nový — pre-flight
 *        ilike-match (24h, status active/awaiting_signoff) reuse-uje
 *        existující poradu.
 *
 *  - proposed_session  → karel-team-deliberation-create
 *        s `deliberation_type='session_plan'` a subject_parts=[part_name].
 *      Schválená session-plan deliberation je pak bridgnutá do
 *      `did_daily_session_plans` (signoff funkce). Žádný `?did_submode`
 *      shim, žádný "mamka" workspace.
 *
 *  Backward compat: starší briefingy mají `ask_hanka: string[]`.
 *  Komponenta umí obojí — pro legacy položku se na stage klikání generuje
 *  ad-hoc UUID (deterministicky cachovaný v sessionStorage podle textu),
 *  takže idempotence funguje i bez nové edge generace.
 */

import { forwardRef, useEffect, useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import {
  Loader2, RefreshCw, Sparkles, CalendarDays, Users, AlertTriangle, ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useDidThreads } from "@/hooks/useDidThreads";
import type { DeliberationType } from "@/types/teamDeliberation";
import { pragueTodayISO } from "@/lib/dateOnlyTaskHelpers";

interface BriefingDecision {
  /** SLICE 3 — stabilní serverové UUID briefing itemu (linked_briefing_item_id). */
  id?: string;
  title: string;
  reason: string;
  type: "crisis" | "session_plan" | "clinical_decision" | "follow_up_review" | "supervision";
  part_name?: string;
}

/** SLICE 3 — strukturovaná osnova session-plan deliberation. */
interface AgendaBlock {
  block: string;
  minutes?: number | null;
  detail?: string | null;
}

interface ProposedSession {
  /** SLICE 3 — stabilní serverové UUID briefing itemu (linked_briefing_item_id). */
  id?: string;
  part_name: string;
  why_today: string;
  led_by: "Hanička" | "Káťa" | "společně";
  duration_min?: number;
  first_draft: string;
  kata_involvement?: string;
  /** SLICE 3 — minutáž sezení (3-6 bloků). */
  agenda_outline?: AgendaBlock[];
  /** SLICE 3 — předem připravené otázky pro Haničku k tomuto sezení. */
  questions_for_hanka?: string[];
  /** SLICE 3 — předem připravené otázky pro Káťu k tomuto sezení. */
  questions_for_kata?: string[];
}

interface ProposedPlayroom {
  id?: string;
  part_name: string;
  status?: "draft" | "awaiting_therapist_review" | "in_revision" | "approved" | "ready_to_start" | "in_progress" | "completed" | "evaluated" | "archived";
  why_this_part_today: string;
  main_theme: string;
  evidence_sources?: string[];
  goals?: string[];
  playroom_plan: {
    therapeutic_program?: AgendaBlock[];
    child_safe_version?: string;
    micro_steps?: string[];
    expected_child_reactions?: string[];
    recommended_karel_responses?: string[];
    risks_and_stop_signals?: string[];
    forbidden_directions?: string[];
    runtime_packet_seed?: Record<string, unknown>;
  };
  questions_for_hanka?: string[];
  questions_for_kata?: string[];
}

/** Nový tvar ask položky (id+text). Edge funkce vrací tohle od 2026-04-19. */
interface AskItemObj { id: string; text: string }
type AskItemRaw = string | AskItemObj;

interface YesterdaySessionReview {
  held: boolean;
  part_name?: string;
  lead?: "Hanička" | "Káťa" | "společně";
  completion?: "completed" | "partial" | "abandoned";
  /** Karlovo přetlumočení sezení (4–7 vět, smysl ne provoz). */
  karel_summary: string;
  /** Klíčové zjištění o části (2–4 věty). */
  key_finding_about_part: string;
  /** Co z toho plyne pro terapeutický plán (2–4 věty). */
  implications_for_plan: string;
  /** Poděkování / stmelení týmu (1–3 věty). */
  team_acknowledgement: string;
}

interface BriefingPayload {
  greeting: string;
  last_3_days: string;
  lingering?: string;
  yesterday_session_review?: YesterdaySessionReview | null;
  decisions: BriefingDecision[];
  proposed_session?: ProposedSession | null;
  proposed_playroom?: ProposedPlayroom | null;
  ask_hanka: AskItemRaw[];
  ask_kata: AskItemRaw[];
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

interface YesterdayFallbackReview extends YesterdaySessionReview {
  status_label?: string;
  mode?: "playroom" | "session";
  practical_report?: string | null;
  detailed_analysis?: string | null;
  sync_status?: string | null;
  team_closing?: string | null;
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

/** Mapování briefing decision typu → kanonický deliberation_type. */
const DECISION_TO_DELIB_TYPE: Record<BriefingDecision["type"], DeliberationType> = {
  crisis: "crisis",
  session_plan: "session_plan",
  clinical_decision: "team_task",
  follow_up_review: "followup_review",
  supervision: "supervision",
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

const pragueYesterdayISO = (): string => {
  const today = pragueTodayISO();
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

const SectionHead = forwardRef<HTMLHeadingElement, { children: React.ReactNode; icon?: React.ReactNode }>(
  ({ children, icon }, ref) => (
  <h3 ref={ref} className="text-[12px] font-medium text-foreground/80 flex items-center gap-1.5 uppercase tracking-wide">
    {icon}
    {children}
  </h3>
));
SectionHead.displayName = "SectionHead";

const NarrativeDivider = forwardRef<HTMLDivElement>((_, ref) => (
  <div ref={ref} className="my-4 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
));
NarrativeDivider.displayName = "NarrativeDivider";

/**
 * Mark this navigation as originating from the briefing panel so that
 * `DidContentRouter` can route Back back to the `terapeut` dashboard.
 */
const markBriefingOrigin = () => {
  try {
    sessionStorage.setItem("karel_briefing_return", "1");
    sessionStorage.setItem("karel_hub_section", "did");
  } catch { /* ignore quota */ }
};

/**
 * Backward compat: pro legacy briefing s `ask_hanka: string[]` potřebujeme
 * stabilní pseudo-id, jinak by druhý klik na tentýž text otevřel jiný thread.
 * Klíč je odvozený z (briefing_id, role, text) a uložený v sessionStorage,
 * takže refresh stránky idempotenci nerozbije.
 */
const legacyAskIdFor = (
  briefingId: string,
  role: "ask_hanka" | "ask_kata",
  text: string,
): string => {
  const cacheKey = `legacy_ask_id::${briefingId}::${role}::${text.slice(0, 200)}`;
  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) return cached;
  } catch { /* ignore */ }
  const id = (typeof crypto !== "undefined" && "randomUUID" in crypto)
    ? crypto.randomUUID()
    : `legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try { sessionStorage.setItem(cacheKey, id); } catch { /* ignore */ }
  return id;
};

/** Normalizuje libovolnou ask položku na {id,text}. */
const toAskItem = (
  raw: AskItemRaw,
  briefingId: string,
  role: "ask_hanka" | "ask_kata",
): AskItemObj => {
  if (raw && typeof raw === "object" && "id" in raw && "text" in raw) {
    return { id: String(raw.id), text: String(raw.text) };
  }
  const text = String(raw ?? "");
  return { id: legacyAskIdFor(briefingId, role, text), text };
};

const createFallbackPlayroomProposal = (payload: BriefingPayload): ProposedPlayroom => {
  const session = payload.proposed_session;
  const partName = session?.part_name?.trim() || "část vybraná ranním přehledem";
  const why = session?.why_today?.trim()
    || payload.last_3_days?.trim()
    || "Ranní přehled zatím nemá uložený samostatný playroom payload, ale Herna musí mít každý den vlastní program k poradě.";

  return {
    part_name: partName,
    status: "awaiting_therapist_review",
    why_this_part_today: why,
    main_theme: `Bezpečný kontakt a cílené zmapování toho, co ${partName} dnes unese`,
    evidence_sources: ["Karlův ranní přehled", "návrh dnešního sezení", "poslední 3 dny"],
    goals: [
      "navázat kontakt bez tlaku na výkon",
      "rozlišit aktuální míru bezpečí, ochoty a únavy",
      "získat konkrétní materiál pro klinické vyhodnocení Herny",
      "ukončit včas při známkách zahlcení nebo stažení",
    ],
    playroom_plan: {
      therapeutic_program: [
        { block: "Bezpečný práh", minutes: 3, detail: "Karel nabídne dvě jednoduché volby kontaktu: slovo, emoji/symbol nebo ticho. Cílem je zjistit dostupnost části, ne ji tlačit do výkonu." },
        { block: "Mapa dnešního vnitřního počasí", minutes: 6, detail: "Část popíše obrazem, barvou nebo jedním slovem, jak se dnes uvnitř má. Karel sleduje míru konkrétnosti, vyhýbání a schopnost zůstat v kontaktu." },
        { block: "Symbolická hra s jednou postavou", minutes: 8, detail: "Karel nechá část vybrat postavu, místo nebo předmět a vede krátký dialog přes bezpečný symbol, bez otevírání traumatické paměti." },
        { block: "Co potřebuje malý krok", minutes: 5, detail: "Karel hledá jeden zvládnutelný mikro-krok pro dnešek: co pomůže tělu, kontaktu nebo klidu, bez slibů a bez konfrontace." },
        { block: "Měkké uzavření", minutes: 3, detail: "Karel shrne, co slyšel, nabídne bezpečné zakotvení a uloží body pro pozdější review." },
      ],
      child_safe_version: "Dnes si spolu jen opatrně zkusíme, jaké je uvnitř počasí, kdo tam je poblíž a co by pomohlo, aby toho nebylo moc.",
      micro_steps: ["vybrat způsob odpovědi", "pojmenovat obraz nebo barvu", "nechat symbol něco říct", "zvolit jeden malý pomocný krok", "společně zavřít hru"],
      expected_child_reactions: ["krátké odpovědi", "nejistota", "odmítnutí konkrétního tématu", "zájem o symbolickou postavu", "únava"],
      recommended_karel_responses: ["zpomalit", "nabídnout volbu", "potvrdit právo neodpovědět", "držet symbolickou rovinu", "ukončit dřív při zahlcení"],
      risks_and_stop_signals: ["náhlé stažení", "zmatek v čase nebo místě", "somatické zhoršení", "tlak na tajemství nebo trauma", "výrazné odpojení"],
      forbidden_directions: ["nevynucovat vzpomínky", "neinterpretovat kresbu jako diagnózu bez review", "neeskalovat trauma", "nepokračovat přes stop signál"],
      runtime_packet_seed: { source: "ui_fallback_until_next_briefing_regeneration" },
    },
    questions_for_hanka: ["Je pro tuto část dnes bezpečnější krátká Karel-led Herna, nebo má být Hanička poblíž jako fyzická opora?"],
    questions_for_kata: ["Vidíš u této části dnes riziko, kvůli kterému má být Herna jen stabilizační a ne hlubinně explorativní?"],
  };
};

const DidDailyBriefingPanel = ({ refreshTrigger, onOpenDeliberation }: Props) => {
  const navigate = useNavigate();
  const didThreads = useDidThreads();
  const [briefing, setBriefing] = useState<BriefingRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [openingItemId, setOpeningItemId] = useState<string | null>(null);
  const [yesterdaySessionFallback, setYesterdaySessionFallback] = useState<YesterdayFallbackReview | null>(null);
  const [yesterdayPlayroomFallback, setYesterdayPlayroomFallback] = useState<YesterdayFallbackReview | null>(null);
  /**
   * THERAPIST-LED TRUTH PASS (2026-04-22) — Duplicity guard.
   * Set obsahuje názvy částí, pro které dnes existuje schválený
   * `did_daily_session_plans` (status='approved'). Pokud briefingem navržené
   * sezení směřuje na takovou část, briefing skryje "Návrh sezení k poradě"
   * a zobrazí pouze info, že plán je schválený a leží v Pracovna → Dnes.
   */
  const [approvedTodayParts, setApprovedTodayParts] = useState<Set<string>>(new Set());

  const loadApprovedToday = useCallback(async () => {
    try {
      const today = pragueTodayISO();
      const { data, error } = await supabase
        .from("did_daily_session_plans")
        .select("selected_part,status")
        .eq("plan_date", today)
        .eq("status", "approved");
      if (error) throw error;
      const set = new Set<string>(
        ((data ?? []) as Array<{ selected_part: string | null }>)
          .map((r) => (r.selected_part || "").trim())
          .filter((s) => s.length > 0),
      );
      setApprovedTodayParts(set);
    } catch (e) {
      console.error("[DidDailyBriefingPanel] loadApprovedToday failed:", e);
      setApprovedTodayParts(new Set());
    }
  }, []);

  const loadYesterdayFallback = useCallback(async () => {
    try {
      const yesterday = pragueYesterdayISO();
      const { data: reviews } = await (supabase as any)
        .from("did_session_reviews")
        .select("mode,part_name,status,clinical_summary,therapeutic_implications,team_implications,next_session_recommendation,evidence_limitations,clinical_findings,implications_for_part,implications_for_whole_system,recommendations_for_therapists,recommendations_for_next_session,recommendations_for_next_playroom,team_closing,drive_sync_status,source_of_truth_status,analysis_json")
        .eq("session_date", yesterday)
        .eq("is_current", true)
        .order("updated_at", { ascending: false })
        .limit(4);
      const rows = (reviews || []) as any[];
      const mapReview = (review: any): YesterdayFallbackReview => ({
        held: true,
        mode: review.mode === "playroom" ? "playroom" : "session",
        part_name: review.part_name || undefined,
        completion: review.status === "analyzed" ? "completed" : review.status === "partially_analyzed" ? "partial" : "abandoned",
        karel_summary: review.analysis_json?.practical_report_text || review.clinical_summary || review.evidence_limitations || "Review existuje, ale klinické shrnutí zatím není uložené.",
        key_finding_about_part: review.implications_for_part || review.therapeutic_implications || review.clinical_findings || "Závěr je omezen dostupnou evidencí.",
        implications_for_plan: review.mode === "playroom" ? (review.recommendations_for_next_playroom || review.next_session_recommendation) : (review.recommendations_for_next_session || review.next_session_recommendation) || "Doplnit chybějící podklady a navázat v dalším plánování.",
        team_acknowledgement: review.team_closing || review.team_implications || "Děkuji Haničce a Kátě za držení kontinuity; i částečný záznam je pro tým užitečný, když je označen poctivě.",
        practical_report: review.analysis_json?.practical_report_text || review.clinical_summary || null,
        detailed_analysis: review.analysis_json?.detailed_analysis_text || review.analysis_json?.diagnostic_validity || null,
        sync_status: review.source_of_truth_status || review.drive_sync_status || null,
        team_closing: review.team_closing || null,
        status_label: review.status,
      });
      const playroomReview = rows.find((r) => r.mode === "playroom");
      const sessionReview = rows.find((r) => r.mode !== "playroom");
      if (playroomReview) setYesterdayPlayroomFallback(mapReview(playroomReview));
      if (sessionReview) setYesterdaySessionFallback(mapReview(sessionReview));

      if (!playroomReview) {
        const dayStart = `${yesterday}T00:00:00.000Z`;
        const dayEnd = `${yesterday}T23:59:59.999Z`;
        const { data: playroomThread } = await (supabase as any)
          .from("did_threads")
          .select("id,part_name,thread_label,messages,last_activity_at,started_at,created_at")
          .eq("sub_mode", "karel_part_session")
          .gte("last_activity_at", dayStart)
          .lte("last_activity_at", dayEnd)
          .order("last_activity_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (playroomThread) {
          const messages = Array.isArray(playroomThread.messages) ? playroomThread.messages : [];
          const userTurns = messages.filter((m: any) => m?.role === "user").length;
          const assistantTurns = messages.filter((m: any) => m?.role === "assistant").length;
          setYesterdayPlayroomFallback({
            held: true,
            mode: "playroom",
            part_name: playroomThread.part_name || undefined,
            completion: userTurns > 0 ? "partial" : "abandoned",
            karel_summary: userTurns > 0
              ? `Včerejší herna proběhla ve vlákně „${playroomThread.thread_label || "Herna"}“. Vidím ${userTurns} odpovědí části a ${assistantTurns} Karlových vstupů. Plné klinické vyhodnocení zatím není uložené, proto ji zde označuji jako čekající na review, ne jako hotový závěr.`
              : `Včerejší herna byla otevřená jako „${playroomThread.thread_label || "Herna"}“, ale zatím nevidím odpověď části. Sekce zůstává viditelná, aby Herna nezmizela z přehledu.`,
            key_finding_about_part: "Zatím jde o provozní evidenci z Herny; klinický závěr musí vzniknout až z uloženého playroom review.",
            implications_for_plan: "Doplnit/obnovit vyhodnocení Herny jako samostatný playroom report, oddělený od terapeutického sezení.",
            team_acknowledgement: "Děkuji za udržení samostatné stopy Herny — nebude se míchat s programem sezení.",
            practical_report: null,
            detailed_analysis: null,
            sync_status: "čeká na playroom review",
            status_label: "pending_review",
          });
        } else {
          setYesterdayPlayroomFallback(null);
        }
      }

      // Playroom review nesmí zabránit samostatnému fallbacku pro Včerejší sezení.
      // Dřív jakýkoliv řádek v did_session_reviews (typicky mode='playroom') ukončil
      // funkci a terapeutické sezení tiše zmizelo z Karlova přehledu.
      if (sessionReview) return;
      const { data: plan } = await (supabase as any)
        .from("did_daily_session_plans")
        .select("id,selected_part,session_lead,therapist,status,lifecycle_status,plan_markdown")
        .eq("plan_date", yesterday)
        .not("urgency_breakdown->>ui_surface", "eq", "did_kids_playroom")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!plan) { setYesterdaySessionFallback(null); return; }
      const { data: progress } = await (supabase as any)
        .from("did_live_session_progress")
        .select("completed_blocks,total_blocks,items")
        .eq("plan_id", plan.id)
        .maybeSingle();
      const completed = progress?.completed_blocks ?? 0;
      const total = progress?.total_blocks ?? null;
      setYesterdaySessionFallback({
        held: true,
        mode: "session",
        part_name: plan.selected_part || undefined,
        lead: String(plan.session_lead || plan.therapist || "").toLowerCase().includes("kat") ? "Káťa" : "Hanička",
        completion: completed > 0 ? "partial" : "abandoned",
        karel_summary: completed > 0
          ? `Včerejší sezení má částečnou evidenci (${completed}${total ? `/${total}` : ""} bodů). Plné klinické review ještě není uložené, proto zatím nebudu předstírat hotový závěr.`
          : "Včera existoval plán sezení, ale zatím k němu nevidím dost průběhových podkladů pro plné klinické zhodnocení.",
        key_finding_about_part: "Stav je evidence-limited: sekce zůstává viditelná, ale závěr čeká na review nebo doplnění podkladů.",
        implications_for_plan: "Karel má sezení předat finalizační cestě; pokud podklady chybí, má vzniknout evidence-limited review místo tichého zmizení sekce.",
        team_acknowledgement: "Haničko a Káťo, děkuji za udržení rámce — i nedokončené sezení se teď poctivě označí a neztratí se z přehledu.",
        status_label: plan.lifecycle_status || plan.status,
      });
    } catch (e) {
      console.error("[DidDailyBriefingPanel] loadYesterdayFallback failed:", e);
      setYesterdaySessionFallback(null);
      setYesterdayPlayroomFallback(null);
    }
  }, []);

  const loadLatest = useCallback(async () => {
    setLoading(true);
    try {
      const today = pragueTodayISO();
      const { data, error } = await supabase
        .from("did_daily_briefings")
        .select("*")
        .eq("is_stale", false)
        .eq("briefing_date", today)
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
    loadApprovedToday();
    loadYesterdayFallback();
  }, [loadLatest, loadApprovedToday, loadYesterdayFallback, refreshTrigger]);

  // Auto-refresh při nově vygenerovaném briefingu i při doplnění včerejšího review,
  // aby sekce Včerejší herna naskočila bez ručního reloadu dashboardu.
  useEffect(() => {
    const channel = supabase
      .channel("did_daily_briefings_panel")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "did_daily_briefings" },
        () => {
          loadLatest();
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "did_daily_briefings" },
        () => {
          loadLatest();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "did_session_reviews" },
        () => {
          loadYesterdayFallback();
        },
      )
      .subscribe();

    const onFocus = () => {
      loadLatest();
      loadYesterdayFallback();
    };
    window.addEventListener("focus", onFocus);

    return () => {
      window.removeEventListener("focus", onFocus);
      supabase.removeChannel(channel);
    };
  }, [loadLatest, loadYesterdayFallback]);

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

  // ─── Navigation helpers (Slice 2 — kanonické persistentní targety) ───

  /**
   * Lazy-otevře nebo založí kanonický did_threads workspace pro briefing ask.
   * Druhý klik na stejný ask resolvne tentýž thread (workspace lookup).
   */
  const openAskWorkspace = useCallback(
    async (
      role: "ask_hanka" | "ask_kata",
      item: AskItemObj,
    ) => {
      if (openingItemId) return; // de-dup paralelní double-click
      setOpeningItemId(item.id);
      try {
        const subMode = role === "ask_hanka" ? "mamka" : "kata";
        const recipientName = role === "ask_hanka" ? "Hanička" : "Káťa";

        // 1) Try canonical workspace lookup
        const existing = await didThreads.getThreadByWorkspace(role, item.id);
        if (existing) {
          markBriefingOrigin();
          navigate(`/chat?workspace_thread=${existing.id}`);
          return;
        }

        // 2) Lazy-create with Karel's intro
        const intro = [
          `📝 **Pro ${recipientName}** — z dnešního přehledu`,
          "",
          item.text,
          "",
          `*Proč to potřebuji:* tento bod jsem dnes ráno pojmenoval jako podstatný pro další postup. Bez tvojí odpovědi pracuji se slepým místem.`,
          "",
          `*Jak na to:* odpověz prosím vlastními slovy. Pokud potřebuješ, klidně mi nejdřív polož zpřesňující otázku.`,
        ].join("\n");

        const thread = await didThreads.createThread(
          "Karel",
          subMode,
          "cs",
          [{ role: "assistant", content: intro }],
          {
            threadLabel: `Pro ${recipientName}: ${item.text.slice(0, 60)}`,
            workspaceType: role,
            workspaceId: item.id,
          },
        );
        if (!thread) {
          toast.error("Nepodařilo se otevřít vlákno.");
          return;
        }
        markBriefingOrigin();
        navigate(`/chat?workspace_thread=${thread.id}`);
      } catch (e: any) {
        console.error("[DidDailyBriefingPanel] openAskWorkspace failed:", e);
        toast.error(e?.message || "Nepodařilo se otevřít vlákno.");
      } finally {
        setOpeningItemId(null);
      }
    },
    [didThreads, navigate, openingItemId],
  );

  /**
   * Klik na decision → najde/vytvoří persistentní did_team_deliberation.
   *
   * SLICE 3 — idempotence je AUTORITATIVNĚ řešená serverem přes
   * `linked_briefing_item_id` (kanonický stabilní id briefing itemu).
   * Druhý klik na stejný `decisions[i]` vrátí EXISTUJÍCÍ poradu
   * (server odpoví `reused: true`). Žádný klientský fuzzy ilike-match.
   *
   * Legacy fallback: pokud briefing je stará verze bez `id` na decisions,
   * generujeme stabilní pseudo-id přes legacyAskIdFor (cache podle title).
   */
  const openDecisionDeliberation = useCallback(
    async (d: BriefingDecision) => {
      if (openingItemId || !briefing) return;
      const itemId = d.id || legacyAskIdFor(briefing.id, "ask_hanka", `decision::${d.title}`);
      setOpeningItemId(itemId);
      try {
        const { data, error } = await (supabase as any).functions.invoke(
          "karel-team-deliberation-create",
          {
            body: {
              deliberation_type: DECISION_TO_DELIB_TYPE[d.type] ?? "team_task",
              subject_parts: d.part_name ? [d.part_name] : [],
              reason: d.reason,
              hint: d.title,
              priority: d.type === "crisis" ? "crisis" : "normal",
              linked_briefing_id: briefing.id,
              linked_briefing_item_id: itemId,
            },
          },
        );
        if (error) throw error;
        const created = (data as any)?.deliberation;
        if (!created?.id) throw new Error("Porada nebyla vytvořena.");

        // 2026-04-19 — markBriefingOrigin patří POUZE do navigate-fallback
        // větve. V modal flow (onOpenDeliberation existuje) zůstává uživatel
        // na DID dashboardu — DeliberationRoom je Dialog, který zavírá
        // setOpenDeliberationId(null) → návrat je nativní, žádný flag netřeba.
        // Bez tohoto guardu by `karel_briefing_return="1"` zůstal viset
        // v sessionStorage a omylem ho zkonzumoval první další chat-view.
        if (onOpenDeliberation) {
          onOpenDeliberation(created.id);
        } else {
          markBriefingOrigin();
          navigate(`/chat?deliberation_id=${created.id}`);
        }
        if (!(data as any)?.reused) toast.success("Porada vytvořena.");
      } catch (e: any) {
        console.error("[DidDailyBriefingPanel] openDecisionDeliberation failed:", e);
        toast.error(e?.message || "Nepodařilo se otevřít poradu.");
      } finally {
        setOpeningItemId(null);
      }
    },
    [briefing, navigate, onOpenDeliberation, openingItemId],
  );

  /**
   * Klik na proposed_session → session-plan deliberation s plným prefillem.
   *
   * SLICE 3 — payload pro create obsahuje:
   *   - linked_briefing_id / linked_briefing_item_id (idempotence serverside)
   *   - prefill { initial_karel_brief, karel_proposed_plan, agenda_outline,
   *     questions_for_hanka, questions_for_kata } — server prefill preferuje
   *     před AI generací, takže obsah porady je deterministický a vychází
   *     z briefingu, ne z druhotné AI iterace.
   *
   * Při schválení (3 podpisy) bridguje karel-team-deliberation-signoff
   * do did_daily_session_plans.
   */
  const openProposedSessionDeliberation = useCallback(
    async (s: ProposedSession) => {
      if (openingItemId || !briefing) return;
      const itemId = s.id || legacyAskIdFor(briefing.id, "ask_hanka", `session::${s.part_name}`);
      setOpeningItemId(itemId);
      try {
        const titleHint = `Plán sezení s ${s.part_name}`;

        const reasonText = [
          s.why_today,
          s.kata_involvement ? `(Káťa: ${s.kata_involvement})` : "",
        ].filter(Boolean).join(" — ");

        // Prefill obsahu z briefingu — server ho použije přímo, místo AI re-generace.
        const introBrief = [
          `📅 **${titleHint}** (vede ${s.led_by}${s.duration_min ? `, ~${s.duration_min} min` : ""})`,
          "",
          `*Proč právě dnes:* ${s.why_today}`,
          s.kata_involvement ? `\n*Káťa:* ${s.kata_involvement}` : "",
          "",
          "Otevírám tuhle poradu, abychom prošli osnovu a doladili otázky před sezením.",
        ].filter(Boolean).join("\n");

        // Schválené session parametry — bridge do did_daily_session_plans je čte
        // autoritativně. Žádný hardcoded „hanka/individual“ na straně signoff.
        const sessionParams = {
          part_name: s.part_name,
          led_by: s.led_by,                                      // "Hanička"|"Káťa"|"společně"
          session_format: s.led_by === "společně" ? "joint" : "individual",
          duration_min: typeof s.duration_min === "number" ? s.duration_min : null,
          why_today: s.why_today ?? null,
          kata_involvement: s.kata_involvement ?? null,
          hybrid_contract: (s as any).hybrid_contract && typeof (s as any).hybrid_contract === "object"
            ? (s as any).hybrid_contract
            : null,
        };

        const prefill = {
          title: titleHint,
          reason: reasonText,
          initial_karel_brief: introBrief,
          karel_proposed_plan: s.first_draft,
          agenda_outline: Array.isArray(s.agenda_outline) ? s.agenda_outline : [],
          questions_for_hanka: Array.isArray(s.questions_for_hanka) ? s.questions_for_hanka : [],
          questions_for_kata: Array.isArray(s.questions_for_kata) ? s.questions_for_kata : [],
          session_params: sessionParams,
        };

        const { data, error } = await (supabase as any).functions.invoke(
          "karel-team-deliberation-create",
          {
            body: {
              deliberation_type: "session_plan",
              subject_parts: [s.part_name],
              reason: reasonText,
              hint: titleHint,
              priority: "high",
              linked_briefing_id: briefing.id,
              linked_briefing_item_id: itemId,
              prefill,
            },
          },
        );
        if (error) throw error;
        const created = (data as any)?.deliberation;
        if (!created?.id) throw new Error("Plán sezení nebyl vytvořen.");

        // Stejný guard jako u openDecisionDeliberation: markBriefingOrigin
        // patří jen do navigate-fallback větve. Modal flow zavírá Dialog
        // nativně přes setOpenDeliberationId(null) — žádný flag netřeba.
        // Bez tohoto guardu zůstane "karel_briefing_return"='1' viset
        // a první další chat-view (typicky další ask_hanka klik) ho omylem
        // zkonzumuje a hodí uživatele zpět na dashboard místo do vlákna.
        if (onOpenDeliberation) {
          onOpenDeliberation(created.id);
        } else {
          markBriefingOrigin();
          navigate(`/chat?deliberation_id=${created.id}`);
        }
        if (!(data as any)?.reused) toast.success("Plán sezení otevřen jako porada týmu.");
      } catch (e: any) {
        console.error("[DidDailyBriefingPanel] openProposedSessionDeliberation failed:", e);
        toast.error(e?.message || "Nepodařilo se otevřít plán sezení.");
      } finally {
        setOpeningItemId(null);
      }
    },
    [briefing, navigate, onOpenDeliberation, openingItemId],
  );

  const openProposedPlayroomDeliberation = useCallback(
    async (s: ProposedPlayroom) => {
      if (openingItemId || !briefing) return;
      const itemId = s.id || legacyAskIdFor(briefing.id, "ask_kata", `playroom::${s.part_name}`);
      setOpeningItemId(itemId);
      try {
        const titleHint = `Plán dnešní herny s ${s.part_name}`;
        const program = Array.isArray(s.playroom_plan?.therapeutic_program) ? s.playroom_plan.therapeutic_program : [];
        const reasonText = [s.main_theme, s.why_this_part_today].filter(Boolean).join(" — ");
        const introBrief = [
          `🎲 **${titleHint}**`,
          "",
          `*Hlavní téma:* ${s.main_theme}`,
          `*Proč právě dnes:* ${s.why_this_part_today}`,
          "",
          "Otevírám poradu ke schválení samostatného programu Herny. Herna je Karel-led práce s částí; nepoužije se plán terapeutického sezení ani first_draft.",
        ].join("\n");
        const karelPlan = [
          `Část: ${s.part_name}`,
          `Stav: ${s.status || "awaiting_therapist_review"}`,
          `Hlavní téma: ${s.main_theme}`,
          "",
          `Proč právě tato herna:\n${s.why_this_part_today}`,
          "",
          s.goals?.length ? `Cíle dnešní herny:\n${s.goals.map((g, i) => `${i + 1}. ${g}`).join("\n")}` : "",
          "",
          s.playroom_plan?.child_safe_version ? `Dětsky bezpečná verze programu:\n${s.playroom_plan.child_safe_version}` : "",
          "",
          s.playroom_plan?.risks_and_stop_signals?.length ? `Rizika a stop signály:\n${s.playroom_plan.risks_and_stop_signals.map((x) => `- ${x}`).join("\n")}` : "",
          "",
          s.playroom_plan?.forbidden_directions?.length ? `Zakázané směry:\n${s.playroom_plan.forbidden_directions.map((x) => `- ${x}`).join("\n")}` : "",
        ].filter(Boolean).join("\n");
        const prefill = {
          title: titleHint,
          reason: reasonText,
          initial_karel_brief: introBrief,
          karel_proposed_plan: karelPlan,
          agenda_outline: program,
          questions_for_hanka: Array.isArray(s.questions_for_hanka) ? s.questions_for_hanka : [],
          questions_for_kata: Array.isArray(s.questions_for_kata) ? s.questions_for_kata : [],
          session_params: {
            part_name: s.part_name,
            led_by: "Karel",
            session_format: "playroom",
            why_today: s.why_this_part_today,
            session_mode: "playroom",
            session_actor: "karel_direct",
            ui_surface: "did_kids_playroom",
            approved_for_child_session: false,
            human_review_required: true,
            review_state: s.status || "awaiting_therapist_review",
            playroom_plan: s.playroom_plan,
          },
        };
        const { data, error } = await (supabase as any).functions.invoke("karel-team-deliberation-create", {
          body: {
            deliberation_type: "session_plan",
            subject_parts: [s.part_name],
            reason: reasonText,
            hint: titleHint,
            priority: "high",
            linked_briefing_id: briefing.id,
            linked_briefing_item_id: itemId,
            prefill,
          },
        });
        if (error) throw error;
        const created = (data as any)?.deliberation;
        if (!created?.id) throw new Error("Plán herny nebyl vytvořen.");
        if (onOpenDeliberation) onOpenDeliberation(created.id);
        else { markBriefingOrigin(); navigate(`/chat?deliberation_id=${created.id}`); }
        if (!(data as any)?.reused) toast.success("Návrh herny otevřen jako porada týmu.");
      } catch (e: any) {
        console.error("[DidDailyBriefingPanel] openProposedPlayroomDeliberation failed:", e);
        toast.error(e?.message || "Nepodařilo se otevřít návrh herny.");
      } finally {
        setOpeningItemId(null);
      }
    },
    [briefing, navigate, onOpenDeliberation, openingItemId],
  );

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
  const yesterdayReview = (p.yesterday_session_review && p.yesterday_session_review.held)
    ? p.yesterday_session_review
    : yesterdaySessionFallback;
  const yesterdayPlayroomReview = yesterdayPlayroomFallback;
  const yesterdaySessionVisible = true;
  const hasProposed = !!p.proposed_session?.part_name;
  const proposedPartName = (p.proposed_session?.part_name ?? "").trim();
  const proposedAlreadyApproved =
    proposedPartName.length > 0 && approvedTodayParts.has(proposedPartName);
  const hasPlayroomProposal = !!p.proposed_playroom?.part_name;
  const decisions = (p.decisions ?? []).slice(0, 3);
  const hankaItems = (p.ask_hanka ?? []).map((raw) => toAskItem(raw, briefing.id, "ask_hanka"));
  const kataItems = (p.ask_kata ?? []).map((raw) => toAskItem(raw, briefing.id, "ask_kata"));

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

      {/* 3.5 Včerejší herna — samostatná vyhrazená sekce, nikdy nesmí splývat se sezením */}
      {yesterdayPlayroomReview && yesterdayPlayroomReview.held && (
        <>
          <NarrativeDivider />
          <SectionHead icon={<Sparkles className="w-3.5 h-3.5 text-primary/70" />}>
            Včerejší herna
          </SectionHead>
          <div className="mt-2 rounded-lg border border-border/60 bg-card/40 p-3 space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              {yesterdayPlayroomReview.part_name && <Badge className="text-[10px] h-5 px-2 bg-primary/15 text-primary border-primary/30">{yesterdayPlayroomReview.part_name}</Badge>}
              <Badge className="text-[10px] h-5 px-2 bg-muted text-muted-foreground border-border">vedl Karel</Badge>
              {yesterdayPlayroomReview.sync_status && <Badge className="text-[10px] h-5 px-2 bg-muted text-muted-foreground border-border">{yesterdayPlayroomReview.sync_status}</Badge>}
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Praktický report</p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-foreground/85 whitespace-pre-line">{yesterdayPlayroomReview.practical_report || yesterdayPlayroomReview.karel_summary}</p>
            </div>
            {yesterdayPlayroomReview.key_finding_about_part && <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Význam pro část</p><p className="mt-0.5 text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line">{yesterdayPlayroomReview.key_finding_about_part}</p></div>}
            {yesterdayPlayroomReview.implications_for_plan && <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Doporučení pro další hernu</p><p className="mt-0.5 text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line">{yesterdayPlayroomReview.implications_for_plan}</p></div>}
            {yesterdayPlayroomReview.detailed_analysis && (
              <details className="rounded-md border border-border/50 bg-background/35 p-2">
                <summary className="cursor-pointer text-[12px] font-medium text-primary">Přečíst si detailní analýzu ze včerejší herny</summary>
                <p className="mt-2 text-[12px] leading-relaxed text-foreground/75 whitespace-pre-line">{yesterdayPlayroomReview.detailed_analysis}</p>
              </details>
            )}
          </div>
        </>
      )}

      {/* 3.6 Včerejší sezení — samostatná vyhrazená sekce, nikdy nesmí splývat s Hernou */}
      {yesterdaySessionVisible && (
        <>
          <NarrativeDivider />
          <SectionHead icon={<Users className="w-3.5 h-3.5 text-primary/70" />}>
            Včerejší sezení
          </SectionHead>
          <div className="mt-2 p-3 rounded-lg border border-border/60 bg-card/40 space-y-2">
            {yesterdayReview && yesterdayReview.held ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  {yesterdayReview.part_name && (
                    <Badge className="text-[10px] h-5 px-2 bg-primary/15 text-primary border-primary/30">
                      {yesterdayReview.part_name}
                    </Badge>
                  )}
                  {yesterdayReview.lead && (
                    <Badge className="text-[10px] h-5 px-2 bg-muted text-muted-foreground border-border">
                      vedla {yesterdayReview.lead}
                    </Badge>
                  )}
                  {yesterdayReview.completion && (
                    <Badge
                      className={`text-[10px] h-5 px-2 border ${
                        yesterdayReview.completion === "completed"
                          ? "bg-emerald-500/15 text-emerald-700 border-emerald-500/30"
                          : yesterdayReview.completion === "partial"
                          ? "bg-amber-500/15 text-amber-700 border-amber-500/30"
                          : "bg-destructive/15 text-destructive border-destructive/30"
                      }`}
                    >
                      {yesterdayReview.completion === "completed"
                        ? "Dokončeno"
                        : yesterdayReview.completion === "partial"
                        ? "Částečně"
                        : "Nedokončeno"}
                    </Badge>
                  )}
                </div>
                {yesterdayReview.karel_summary ? (
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Karlovo vyhodnocení</p>
                    <p className="text-[13px] leading-relaxed text-foreground/85 whitespace-pre-line">
                      {yesterdayReview.karel_summary}
                    </p>
                  </div>
                ) : (
                  <div className="text-[12px] italic text-muted-foreground">
                    Karlovo přetlumočení se právě dogeneruvává. Pokud se neobjeví do minuty, klikni „Přegenerovat".
                  </div>
                )}
                {yesterdayReview.key_finding_about_part && (
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Co teď víme o části</p>
                    <p className="text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line mt-0.5">
                      {yesterdayReview.key_finding_about_part}
                    </p>
                  </div>
                )}
                {yesterdayReview.implications_for_plan && (
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Co z toho plyne pro plán</p>
                    <p className="text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line mt-0.5">
                      {yesterdayReview.implications_for_plan}
                    </p>
                  </div>
                )}
                {yesterdayReview.team_acknowledgement && (
                  <div className="pt-1 border-t border-border/40">
                    <p className="text-[11px] uppercase tracking-wide text-primary/70">Týmové uzavření</p>
                    <p className="text-[12px] leading-relaxed text-foreground/85 italic whitespace-pre-line mt-0.5">
                      {yesterdayReview.team_acknowledgement}
                    </p>
                  </div>
                )}
                {(yesterdayReview as YesterdayFallbackReview).detailed_analysis && (
                  <details className="rounded-md border border-border/50 bg-background/35 p-2">
                    <summary className="cursor-pointer text-[12px] font-medium text-primary">Přečíst si detailní analýzu ze včerejšího sezení</summary>
                    <p className="mt-2 text-[12px] leading-relaxed text-foreground/75 whitespace-pre-line">{(yesterdayReview as YesterdayFallbackReview).detailed_analysis}</p>
                  </details>
                )}
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge className="text-[10px] h-5 px-2 bg-muted text-muted-foreground border-border">evidence zatím chybí</Badge>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Faktický stav</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line">
                    Samostatná stopa včerejšího terapeutického sezení zatím není v Karlově přehledu dohledaná. Sekce zůstává viditelná schválně, aby se Včerejší sezení nikdy neztratilo za Hernou ani za prázdným briefing payloadem.
                  </p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Další krok</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line">
                    Karel má dohledat nebo dogenerovat evidence-limited review sezení odděleně od playroom review; Herna nesmí být použita jako náhrada terapeutického sezení.
                  </p>
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* 4. Dnešní navržené sezení — klikatelné.
          THERAPIST-LED TRUTH PASS (2026-04-22): Tato sekce zobrazuje POUZE
          první návrh sezení a CTA "Otevřít poradu". Pokud je porada už
          schválená (status='approved' nebo existuje plan v
          did_daily_session_plans), schová se — autoritativní zdroj je
          v Pracovna → Dnes → "Plán dnešního sezení". */}
      {hasProposed && p.proposed_session && !proposedAlreadyApproved && (
        <>
          <NarrativeDivider />
          <SectionHead icon={<Sparkles className="w-3.5 h-3.5 text-primary" />}>
            Návrh sezení k poradě
          </SectionHead>
          <button
            type="button"
            onClick={() => openProposedSessionDeliberation(p.proposed_session!)}
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
              <span className="text-muted-foreground italic">První pracovní verze (k diskusi v poradě): </span>
              {p.proposed_session.first_draft}
            </div>
            {p.proposed_session.kata_involvement && (
              <p className="text-[12px] text-muted-foreground italic whitespace-pre-line">
                {p.proposed_session.kata_involvement}
              </p>
            )}
            <p className="text-[11px] text-primary/70 italic">
              Otevřít poradu →
            </p>
          </button>
        </>
      )}

      {/* 4.5 Dnešní navržená Herna — samostatný Karel-led program, nikdy ne session first_draft. */}
      {hasPlayroomProposal && p.proposed_playroom && (
        <>
          <NarrativeDivider />
          <SectionHead icon={<Sparkles className="w-3.5 h-3.5 text-primary" />}>
            Návrh dnešní herny s {p.proposed_playroom.part_name}
          </SectionHead>
          <button
            type="button"
            onClick={() => openProposedPlayroomDeliberation(p.proposed_playroom!)}
            className="mt-2 w-full text-left p-3 rounded-lg border border-primary/20 bg-primary/5 hover:bg-primary/10 transition-colors space-y-3 cursor-pointer"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <Badge className="text-[10px] h-5 px-2 bg-primary/15 text-primary border-primary/30">Část: {p.proposed_playroom.part_name}</Badge>
              <Badge className="text-[10px] h-5 px-2 bg-muted text-muted-foreground border-border">{p.proposed_playroom.status || "awaiting_therapist_review"}</Badge>
              <Badge className="text-[10px] h-5 px-2 bg-muted text-muted-foreground border-border">vede Karel</Badge>
              <ArrowRight className="w-3.5 h-3.5 text-primary/60 ml-auto" />
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Hlavní téma dnešní Herny</p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-foreground/85 whitespace-pre-line">{p.proposed_playroom.main_theme}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Proč právě tato Herna</p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line">{p.proposed_playroom.why_this_part_today}</p>
            </div>
            {Array.isArray(p.proposed_playroom.goals) && p.proposed_playroom.goals.length > 0 && (
              <div>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Cíle Herny</p>
                <ul className="mt-1 space-y-1 text-[13px] leading-relaxed text-foreground/80">
                  {p.proposed_playroom.goals.slice(0, 4).map((goal, index) => <li key={`${goal}-${index}`}>{index + 1}. {goal}</li>)}
                </ul>
              </div>
            )}
            {Array.isArray(p.proposed_playroom.playroom_plan?.therapeutic_program) && p.proposed_playroom.playroom_plan.therapeutic_program.length > 0 && (
              <div>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Program pro Hernu</p>
                <div className="mt-1 space-y-1.5">
                  {p.proposed_playroom.playroom_plan.therapeutic_program.slice(0, 5).map((block, index) => (
                    <p key={`${block.block}-${index}`} className="text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line"><span className="font-medium text-foreground/90">{index + 1}. {block.block}</span>{block.detail ? ` — ${block.detail}` : ""}</p>
                  ))}
                </div>
              </div>
            )}
            {p.proposed_playroom.playroom_plan?.child_safe_version && <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Dětsky bezpečná verze</p><p className="mt-0.5 text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line">{p.proposed_playroom.playroom_plan.child_safe_version}</p></div>}
            {Array.isArray(p.proposed_playroom.playroom_plan?.risks_and_stop_signals) && p.proposed_playroom.playroom_plan.risks_and_stop_signals.length > 0 && <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Rizika a stop signály</p><p className="mt-0.5 text-[13px] leading-relaxed text-foreground/80 whitespace-pre-line">{p.proposed_playroom.playroom_plan.risks_and_stop_signals.slice(0, 4).map((x) => `- ${x}`).join("\n")}</p></div>}
            <p className="text-[11px] text-primary/70 italic">Otevřít poradu ke schválení Herny →</p>
          </button>
        </>
      )}

      {/* DUPLICITY GUARD — když porada už schválena, briefing nezdvojuje plán.
          Autoritativní karta je v Pracovna → Dnes → "Plán dnešního sezení". */}
      {hasProposed && p.proposed_session && proposedAlreadyApproved && (
        <>
          <NarrativeDivider />
          <SectionHead icon={<Sparkles className="w-3.5 h-3.5 text-primary" />}>
            Dnešní sezení je schválené
          </SectionHead>
          <p className="mt-2 text-[12px] text-muted-foreground italic">
            Plán sezení s {p.proposed_session.part_name} je schválen oběma terapeutkami.
            Otevři ho v sekci <strong>Dnes → Plán dnešního sezení</strong>.
          </p>
        </>
      )}

      {/* 5. Co potřebuji od Haničky — KLIKATELNÉ → kanonický did_threads workspace */}
      {hankaItems.length > 0 && (
        <>
          <NarrativeDivider />
          <SectionHead>Haničko, potřebuji od tebe</SectionHead>
          <ul className="mt-2 space-y-1.5">
            {hankaItems.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={openingItemId === item.id}
                  onClick={() => openAskWorkspace("ask_hanka", item)}
                  className="w-full text-left flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-primary/5 transition-colors cursor-pointer group disabled:opacity-60"
                >
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/40 group-hover:bg-primary/70 transition-colors" />
                  <span className="text-[13px] text-foreground/80 leading-relaxed flex-1">
                    {item.text}
                  </span>
                  {openingItemId === item.id ? (
                    <Loader2 className="w-3 h-3 text-primary animate-spin mt-1 shrink-0" />
                  ) : (
                    <ArrowRight className="w-3 h-3 text-muted-foreground/40 group-hover:text-primary/70 mt-1 shrink-0 transition-colors" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* 6. Co potřebuji od Káti — KLIKATELNÉ → kanonický did_threads workspace */}
      {kataItems.length > 0 && (
        <>
          <NarrativeDivider />
          <SectionHead>Káťo, potřebuji od tebe</SectionHead>
          <ul className="mt-2 space-y-1.5">
            {kataItems.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={openingItemId === item.id}
                  onClick={() => openAskWorkspace("ask_kata", item)}
                  className="w-full text-left flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/5 transition-colors cursor-pointer group disabled:opacity-60"
                >
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent/40 group-hover:bg-accent/70 transition-colors" />
                  <span className="text-[13px] text-foreground/80 leading-relaxed flex-1">
                    {item.text}
                  </span>
                  {openingItemId === item.id ? (
                    <Loader2 className="w-3 h-3 text-accent animate-spin mt-1 shrink-0" />
                  ) : (
                    <ArrowRight className="w-3 h-3 text-muted-foreground/40 group-hover:text-accent/70 mt-1 shrink-0 transition-colors" />
                  )}
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
                  disabled={openingItemId === `decision::${d.title}`}
                  onClick={() => openDecisionDeliberation(d)}
                  className="w-full text-left rounded-lg border border-border/60 bg-card/40 hover:bg-card/70 hover:border-primary/30 p-3 space-y-1.5 transition-colors cursor-pointer group disabled:opacity-60"
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
          ...hankaItems.map(it => it.text),
          ...kataItems.map(it => it.text),
          ...decisions.map(d => d.title),
        ].map(s => (s ?? "").toLowerCase().slice(0, 40));

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

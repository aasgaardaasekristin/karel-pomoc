/**
 * DailyDecisionTasks — Slice 3B (Daily Lifecycle + Decision Deck Cleanup)
 *
 * Decision-deck blok pro Karlův přehled. Ukazuje JEN dnešní rozhodovací
 * práci (Slice 2 RE-ANCHOR SPEC, sekce D):
 *   - new_today
 *   - needs_reissue
 *   - escalate_to_meeting
 *   - blocking subset waiting_response
 *
 * NESMÍ ukazovat:
 *   - celý backlog (operativa dne má vlastní místo)
 *   - done / dropped / not_relevant_anymore
 *   - scheduled_for_session
 *   - admin/inspect položky
 *
 * Žádné writes. Žádný owner stavu. Pure render z `useDailyLifecycle()`.
 */

import { useMemo } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  CalendarClock,
  CircleDot,
  Loader2,
  RotateCcw,
} from "lucide-react";
import { useDailyLifecycle } from "@/hooks/useDailyLifecycle";
import {
  DailyLifecycleItem,
  DailyLifecycleStatus,
} from "@/types/dailyLifecycle";

interface Props {
  refreshTrigger?: number;
}

interface Group {
  status: DailyLifecycleStatus;
  label: string;
  description: string;
  Icon: typeof AlertTriangle;
  tone: string;
  items: DailyLifecycleItem[];
}

const STATUS_LABEL: Record<DailyLifecycleStatus, string> = {
  new_today: "Nové dnes",
  needs_reissue: "Vyžaduje reissue",
  escalate_to_meeting: "Eskalovat na poradu",
  waiting_response: "Blokující čekání",
  scheduled_for_session: "Pro sezení",
  done: "Hotovo",
  dropped: "Zahozeno",
  not_relevant_anymore: "Nerelevantní",
};

const STATUS_DESCRIPTION: Record<string, string> = {
  new_today: "Vzniklo dnes — Karel potřebuje rozhodnutí.",
  needs_reissue: "Expirovalo nebo prošlo due — znovu otevřít.",
  escalate_to_meeting: "Tasky, které mají eskalaci ≥ 1.",
  waiting_response: "Otevřené otázky se sloupcem `blocking` — drží rozhodnutí.",
};

const AUDIENCE_LABEL: Record<string, string> = {
  hanka: "Hanička",
  kata: "Káťa",
  both: "Obě",
  karel: "Karel",
  system: "Systém",
  unknown: "—",
};

const SOURCE_LABEL: Record<string, string> = {
  task: "task",
  pending_question: "otázka",
  briefing_ask: "briefing",
  briefing_decision: "briefing",
  crisis_deficit: "krize",
  session_proposal: "návrh sezení",
};

const formatAge = (iso: string): string => {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "právě teď";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "právě teď";
  if (hours < 24) return `před ${hours}h`;
  return `před ${Math.floor(hours / 24)}d`;
};

const DailyDecisionTasks = ({ refreshTrigger }: Props) => {
  const { buckets, loading, error } = useDailyLifecycle(refreshTrigger);

  const groups: Group[] = useMemo(
    () => [
      {
        status: "new_today",
        label: STATUS_LABEL.new_today,
        description: STATUS_DESCRIPTION.new_today,
        Icon: CircleDot,
        tone: "text-primary",
        items: buckets.newToday,
      },
      {
        status: "needs_reissue",
        label: STATUS_LABEL.needs_reissue,
        description: STATUS_DESCRIPTION.needs_reissue,
        Icon: RotateCcw,
        tone: "text-amber-700",
        items: buckets.needsReissue,
      },
      {
        status: "escalate_to_meeting",
        label: STATUS_LABEL.escalate_to_meeting,
        description: STATUS_DESCRIPTION.escalate_to_meeting,
        Icon: ArrowUpRight,
        tone: "text-destructive",
        items: buckets.escalateToMeeting,
      },
      {
        status: "waiting_response",
        label: STATUS_LABEL.waiting_response,
        description: STATUS_DESCRIPTION.waiting_response,
        Icon: AlertTriangle,
        tone: "text-amber-700",
        // Slice 2 spec: do decision decku jde JEN blocking subset waiting_response.
        items: buckets.waitingResponse.filter((i) => i.isBlocking),
      },
    ],
    [buckets],
  );

  const totalDecision = groups.reduce((acc, g) => acc + g.items.length, 0);

  return (
    <div className="jung-card p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-serif">
        <CalendarClock className="h-4 w-4 text-primary" />
        <span>Dnešní rozhodovací práce</span>
        <span className="ml-auto text-[10px] font-light text-muted-foreground">
          decision deck · {totalDecision}
        </span>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Načítám…
        </div>
      ) : error ? (
        <p className="text-xs text-destructive">Chyba: {error}</p>
      ) : totalDecision === 0 ? (
        <p className="text-xs text-muted-foreground">
          Žádné dnešní rozhodovací položky. Operativa dne a uzavřené body sem nepatří.
        </p>
      ) : (
        <div className="space-y-3">
          {groups
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <DecisionGroup key={g.status} group={g} />
            ))}
        </div>
      )}
    </div>
  );
};

const DecisionGroup = ({ group }: { group: Group }) => {
  const { Icon, tone, label, description, items } = group;
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Icon className={`h-3.5 w-3.5 ${tone}`} />
        <span className="text-[12px] font-medium tracking-wide">
          {label}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {items.length}
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground leading-snug">
        {description}
      </p>
      <ul className="space-y-1.5">
        {items.slice(0, 8).map((item) => (
          <DecisionRow key={`${item.source}:${item.id}`} item={item} />
        ))}
        {items.length > 8 && (
          <li className="text-[10px] text-muted-foreground italic">
            …a dalších {items.length - 8} v operativě dne.
          </li>
        )}
      </ul>
    </div>
  );
};

const DecisionRow = ({ item }: { item: DailyLifecycleItem }) => {
  return (
    <li className="rounded-lg border border-border/40 bg-background/40 p-2 text-xs space-y-1">
      <div className="flex items-start gap-2">
        <span className="font-medium text-foreground leading-snug flex-1">
          {item.title}
        </span>
        {item.isBlocking && (
          <span className="text-[9px] uppercase tracking-wider text-destructive shrink-0 mt-0.5">
            blokuje
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
        <span>{SOURCE_LABEL[item.source] || item.source}</span>
        <span>·</span>
        <span>komu: {AUDIENCE_LABEL[item.audience] || item.audience}</span>
        <span>·</span>
        <span>{formatAge(item.createdAt)}</span>
        {item.partName && (
          <>
            <span>·</span>
            <span>{item.partName}</span>
          </>
        )}
        {item.rationale && (
          <>
            <span>·</span>
            <span className="italic">{item.rationale}</span>
          </>
        )}
      </div>
    </li>
  );
};

export default DailyDecisionTasks;

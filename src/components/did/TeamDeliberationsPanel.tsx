import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Users, AlertTriangle, ChevronDown, ChevronUp, Plus, CheckCircle2, Clock, Loader2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useTeamDeliberations } from "@/hooks/useTeamDeliberations";
import {
  partitionDashboardDeliberations,
  signoffProgress,
  type TeamDeliberation,
  type DeliberationType,
} from "@/types/teamDeliberation";

interface Props {
  refreshTrigger?: number;
  /** Otevře poradní místnost (modal v parent komponentě). */
  onOpenRoom: (deliberationId: string) => void;
}

const TYPE_LABEL: Record<DeliberationType, string> = {
  team_task: "Společné rozhodnutí",
  session_plan: "Plán sezení",
  crisis: "Krize",
  followup_review: "Vyhodnocení sezení",
  supervision: "Supervize",
};

const PRIORITY_TONE: Record<string, string> = {
  crisis: "bg-destructive/15 text-destructive border-destructive/30",
  urgent: "bg-amber-500/15 text-amber-700 border-amber-500/30",
  high: "bg-amber-500/10 text-amber-700 border-amber-500/20",
  normal: "bg-muted text-muted-foreground border-border",
  low: "bg-muted/50 text-muted-foreground border-border/50",
};

function DeliberationRow({
  d,
  onOpen,
}: { d: TeamDeliberation; onOpen: () => void }) {
  const sp = signoffProgress(d);
  return (
    <button
      onClick={onOpen}
      className="w-full text-left rounded-lg border border-border/60 bg-card/40 hover:bg-card/70 transition-colors p-3 space-y-2"
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap mb-1">
            <Badge className={`text-[9px] h-4 px-1.5 border ${PRIORITY_TONE[d.priority] ?? PRIORITY_TONE.normal}`}>
              {TYPE_LABEL[d.deliberation_type] ?? d.deliberation_type}
            </Badge>
            {d.priority === "crisis" && (
              <Badge className="text-[9px] h-4 px-1.5 bg-destructive/15 text-destructive border border-destructive/30">
                <AlertTriangle className="w-2.5 h-2.5 mr-0.5" /> krize
              </Badge>
            )}
            {d.subject_parts?.slice(0, 3).map((p) => (
              <Badge key={p} className="text-[9px] h-4 px-1.5 bg-primary/10 text-primary border border-primary/20">
                {p}
              </Badge>
            ))}
          </div>
          <p className="text-[12px] font-medium text-foreground leading-snug truncate">
            {d.title}
          </p>
          {d.reason && (
            <p className="text-[10px] text-muted-foreground leading-snug line-clamp-2 mt-0.5">
              {d.reason}
            </p>
          )}
        </div>
        <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <Clock className="w-3 h-3" />
        <span>
          podpisy {sp.signed}/{sp.total}
          {sp.missing.length > 0 && (
            <> · chybí {sp.missing.map((m) => (m === "hanka" ? "Hanička" : m === "kata" ? "Káťa" : "Karel")).join(", ")}</>
          )}
        </span>
        {d.status === "awaiting_signoff" && (
          <Badge className="text-[8px] h-3.5 px-1 bg-amber-500/15 text-amber-700 border-amber-500/30 ml-auto">
            čeká na podpis
          </Badge>
        )}
        {d.status === "active" && sp.signed === 0 && (
          <Badge className="text-[8px] h-3.5 px-1 bg-primary/10 text-primary border-primary/20 ml-auto">
            otevřená
          </Badge>
        )}
      </div>
    </button>
  );
}

const TeamDeliberationsPanel = ({ refreshTrigger, onOpenRoom }: Props) => {
  const { items, loading, creating, create } = useTeamDeliberations(refreshTrigger ?? 0);
  const [showOverflow, setShowOverflow] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  const { primary, overflow } = partitionDashboardDeliberations(items);

  const handleCreate = async (type: DeliberationType, hint: string) => {
    try {
      const created = await create({ deliberation_type: type, hint, reason: hint });
      if (created?.id) {
        setShowCreate(false);
        onOpenRoom(created.id);
      }
    } catch (e) {
      console.error("[TeamDeliberationsPanel] create failed:", e);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5 text-primary" />
          Společná porada týmu
          {primary.length > 0 && (
            <Badge className="text-[9px] h-4 px-1.5 bg-muted text-muted-foreground border-border">
              {primary.length}
            </Badge>
          )}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[10px]"
          onClick={() => setShowCreate((v) => !v)}
        >
          <Plus className="w-3 h-3 mr-1" /> Svolat
        </Button>
      </div>

      {showCreate && (
        <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3 space-y-2">
          <p className="text-[10px] text-muted-foreground">
            Týmová porada smí vzniknout jen pro skutečné společné rozhodnutí.
            Žádný individuální task, žádná běžná operativa.
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            {([
              ["session_plan", "Plán dnešního sezení"],
              ["crisis", "Krizová koordinace"],
              ["team_task", "Společné rozhodnutí"],
              ["followup_review", "Vyhodnocení sezení"],
              ["supervision", "Supervizní bod"],
            ] as Array<[DeliberationType, string]>).map(([t, label]) => (
              <Button
                key={t}
                variant="outline"
                size="sm"
                className="h-8 text-[10px] justify-start"
                disabled={creating}
                onClick={() => handleCreate(t, label)}
              >
                {creating ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
                {label}
              </Button>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        </div>
      ) : primary.length === 0 ? (
        <p className="text-[10px] text-muted-foreground italic px-1">
          Žádná otevřená porada. Karel poradu svolá, jen když je potřeba společné rozhodnutí.
        </p>
      ) : (
        <div className="space-y-2">
          {primary.map((d) => (
            <DeliberationRow key={d.id} d={d} onOpen={() => onOpenRoom(d.id)} />
          ))}
        </div>
      )}

      {overflow.length > 0 && (
        <div>
          <button
            className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1"
            onClick={() => setShowOverflow((v) => !v)}
          >
            {showOverflow ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            Další otevřené porady ({overflow.length})
          </button>
          {showOverflow && (
            <div className="space-y-2 mt-2 pl-2 border-l border-border/50">
              {overflow.map((d) => (
                <DeliberationRow key={d.id} d={d} onOpen={() => onOpenRoom(d.id)} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default TeamDeliberationsPanel;

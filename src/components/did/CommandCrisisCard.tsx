import { useEffect, useState } from "react";
import { AlertOctagon, Clock, ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import DidCrisisPanel from "./DidCrisisPanel";

export interface CommandCrisis {
  partName: string;
  state: string; // active | awaiting_feedback | ready_to_close
  severity: string;
  hoursStaleUpdate: number | null;
  missing: string[];
  requires: string[];
  ctas: { label: string; path: string }[];
}

const STATE_LABEL: Record<string, string> = {
  active: "Aktivní",
  awaiting_feedback: "Čeká na feedback",
  ready_to_close: "Připraveno k uzavření",
  closed: "Uzavřeno",
};

const SEVERITY_LABEL: Record<string, string> = {
  critical: "kritická",
  high: "vysoká",
  medium: "střední",
  low: "nízká",
};

interface Props {
  crises: CommandCrisis[];
  refreshTrigger?: number;
}

export default function CommandCrisisCard({ crises, refreshTrigger }: Props) {
  const navigate = useNavigate();
  const [openDetailFor, setOpenDetailFor] = useState<string | null>(null);

  // Reset open sheet on refresh
  useEffect(() => {
    setOpenDetailFor(null);
  }, [refreshTrigger]);

  if (!crises || crises.length === 0) return null;

  const goTo = (path: string) => {
    try {
      sessionStorage.setItem("karel_hub_section", "did");
    } catch {
      /* ignore */
    }
    navigate(path);
  };

  return (
    <div className="space-y-2">
      {crises.map((c, i) => {
        const stateLabel = STATE_LABEL[c.state] || c.state;
        const sevLabel = SEVERITY_LABEL[c.severity] || c.severity || "—";
        const stale =
          c.hoursStaleUpdate != null
            ? c.hoursStaleUpdate < 1
              ? "<1h"
              : c.hoursStaleUpdate < 24
                ? `${c.hoursStaleUpdate}h`
                : `${Math.round(c.hoursStaleUpdate / 24)}d`
            : "—";

        // Take primary 2 CTAs only
        const primary = c.ctas?.slice(0, 2) || [];

        return (
          <div
            key={`${c.partName}-${i}`}
            className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 shadow-sm"
            data-cmd-crisis={c.partName}
          >
            <div className="flex items-start gap-3">
              <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="min-w-0 flex-1 space-y-2">
                {/* Top row — entity + state + severity + stale */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
                  <span className="font-serif text-[15px] font-semibold text-destructive">
                    {c.partName}
                  </span>
                  <span className="rounded-md bg-destructive/15 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-destructive">
                    {stateLabel}
                  </span>
                  <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {sevLabel}
                  </span>
                  <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    update {stale}
                  </span>
                </div>

                {/* Co dnes chybí */}
                {c.missing && c.missing.length > 0 && (
                  <div className="text-[12px] leading-5 text-foreground/75">
                    <span className="font-medium text-foreground/85">
                      Dnes chybí:
                    </span>{" "}
                    {c.missing.slice(0, 3).join(" · ")}
                  </div>
                )}

                {/* Co Karel vyžaduje */}
                {c.requires && c.requires.length > 0 && (
                  <div className="text-[12px] leading-5 text-foreground/75">
                    <span className="font-medium text-foreground/85">
                      Karel vyžaduje:
                    </span>{" "}
                    {c.requires.slice(0, 2).join(" · ")}
                  </div>
                )}

                {/* CTA row */}
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  {primary.map((cta, ci) => (
                    <button
                      key={ci}
                      onClick={() => goTo(cta.path)}
                      className="inline-flex items-center gap-1 rounded-md bg-destructive px-2.5 py-1 text-[11.5px] font-medium text-destructive-foreground transition-colors hover:bg-destructive/90"
                    >
                      {cta.label}
                      <ChevronRight className="h-3 w-3" />
                    </button>
                  ))}

                  <Sheet
                    open={openDetailFor === c.partName}
                    onOpenChange={(o) =>
                      setOpenDetailFor(o ? c.partName : null)
                    }
                  >
                    <SheetTrigger asChild>
                      <button
                        className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-card/40 px-2.5 py-1 text-[11.5px] font-medium text-foreground/80 transition-colors hover:bg-card/70"
                      >
                        Otevřít detail
                      </button>
                    </SheetTrigger>
                    <SheetContent
                      side="right"
                      className="w-full overflow-y-auto sm:max-w-md"
                    >
                      <SheetHeader>
                        <SheetTitle className="font-serif text-base">
                          Krizový detail — {c.partName}
                        </SheetTitle>
                      </SheetHeader>
                      <div className="mt-4">
                        <DidCrisisPanel partName={c.partName} />
                      </div>
                    </SheetContent>
                  </Sheet>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * P7: Externí realita — warning sekce „Možné vnější zatížení"
 *
 * Zobrazuje aktivní (resolved_at IS NULL) external_event_impacts
 * pro canonical DID usera. Bezpečné pravidla:
 *  - žádný raw text z high-graphic events (sentinel ho už nahradil)
 *  - žádné potvrzení identity Arthura jako reálné osoby
 *  - jen klinická doporučení a recommended_action
 *
 * Použití: vložit do briefingu, Herny, plánu sezení.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, ShieldAlert, Eye } from "lucide-react";
import { callEdgeFunction } from "@/lib/safeEdgeFunction";

type Impact = {
  id: string;
  event_id: string;
  part_name: string;
  risk_level: "watch" | "amber" | "red";
  reason: string;
  recommended_action: string | null;
  external_reality_events?: {
    event_title: string;
    event_type: string;
    source_type: string;
    verification_status: string;
    graphic_content_risk: string;
    summary_for_therapists: string;
  } | null;
};

const RISK_META: Record<Impact["risk_level"], { label: string; tone: string; Icon: typeof Eye }> = {
  watch: { label: "Sledovat", tone: "border-slate-300 bg-slate-50/40 text-slate-800", Icon: Eye },
  amber: { label: "Pozor", tone: "border-amber-300 bg-amber-50/40 text-amber-900", Icon: AlertTriangle },
  red: { label: "Vysoké riziko", tone: "border-rose-300 bg-rose-50/40 text-rose-900", Icon: ShieldAlert },
};

interface Props {
  /** When true, render even if list is empty (for debugging UI). Default false. */
  showWhenEmpty?: boolean;
}

export default function ExternalLoadWarning({ showWhenEmpty = false }: Props) {
  const [loading, setLoading] = useState(true);
  const [impacts, setImpacts] = useState<Impact[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await callEdgeFunction("karel-external-reality-sentinel", {
          action: "list_impacts",
        });
        if (cancelled) return;
        setImpacts(((res as { impacts?: Impact[] })?.impacts ?? []) as Impact[]);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Načtení selhalo");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return null;
  if (error) {
    return (
      <div className="rounded-md border border-rose-300/50 bg-rose-50/30 p-2 text-xs text-rose-800">
        Možné vnější zatížení: nepodařilo se načíst ({error}).
      </div>
    );
  }
  if (impacts.length === 0 && !showWhenEmpty) return null;

  return (
    <section
      data-testid="external-load-warning"
      className="rounded-lg border border-border/60 bg-background/40 p-3 space-y-2"
    >
      <header className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-700" aria-hidden />
        <h3 className="font-serif text-base text-foreground">Možné vnější zatížení</h3>
        <span className="text-xs text-muted-foreground">
          ({impacts.length} {impacts.length === 1 ? "téma" : impacts.length < 5 ? "témata" : "témat"})
        </span>
      </header>
      {impacts.length === 0 ? (
        <p className="text-xs text-muted-foreground">Aktuálně žádná aktivní vnější zátěž.</p>
      ) : (
        <ul className="space-y-1.5">
          {impacts.slice(0, 8).map((imp) => {
            const meta = RISK_META[imp.risk_level];
            const Icon = meta.Icon;
            const ev = imp.external_reality_events;
            return (
              <li
                key={imp.id}
                className={`rounded-md border p-2 text-xs ${meta.tone}`}
                data-risk={imp.risk_level}
                data-part={imp.part_name}
              >
                <div className="flex items-center gap-2 font-medium">
                  <Icon className="h-3.5 w-3.5" aria-hidden />
                  <span>{imp.part_name}</span>
                  <span className="opacity-70">·</span>
                  <span className="uppercase tracking-wide text-[10px]">{meta.label}</span>
                  {ev && (
                    <span className="opacity-70 truncate">
                      · {ev.event_title}
                    </span>
                  )}
                </div>
                <div className="mt-1 leading-snug">{imp.reason}</div>
                {imp.recommended_action && (
                  <div className="mt-1 italic opacity-90">
                    Doporučení: {imp.recommended_action}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[10px] text-muted-foreground italic">
        Externí realita: pouze klinická doporučení. Žádný grafický obsah, žádné potvrzování identity.
      </p>
    </section>
  );
}

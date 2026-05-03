/**
 * P7 + P11: Externí realita — sekce „Možné vnější zatížení".
 *
 * Renders only humanized, deduplicated/clustered cards.
 * NEVER renders raw `reason` / `recommended_action` from the DB.
 * NEVER renders internal classifier tokens (animal_suffering, rescue_failure,
 * broken_promise, types: ...).
 *
 * One card per (part_name, theme cluster) — see externalImpactHumanizer.ts.
 */

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ShieldAlert, Eye } from "lucide-react";
import { callEdgeFunction } from "@/lib/safeEdgeFunction";
import {
  clusterAndHumanizeExternalImpacts,
  type RawExternalImpact,
  type DisplayExternalImpact,
} from "@/lib/externalImpactHumanizer";
import { useVisibleClinicalTextAudit } from "@/lib/visibleClinicalTextGuard";

const RISK_META: Record<DisplayExternalImpact["risk_level"], { label: string; tone: string; Icon: typeof Eye }> = {
  watch: { label: "Sledovat", tone: "border-slate-300 bg-slate-50/40 text-slate-800", Icon: Eye },
  amber: { label: "Pozor", tone: "border-amber-300 bg-amber-50/40 text-amber-900", Icon: AlertTriangle },
  red: { label: "Vysoká citlivost", tone: "border-rose-300 bg-rose-50/40 text-rose-900", Icon: ShieldAlert },
};

interface Props {
  /** When true, render even if list is empty (for debugging UI). Default false. */
  showWhenEmpty?: boolean;
}

export default function ExternalLoadWarning({ showWhenEmpty = false }: Props) {
  const [loading, setLoading] = useState(true);
  const [cards, setCards] = useState<DisplayExternalImpact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  // P1: throw in test env if any forbidden token leaks into the rendered DOM.
  useVisibleClinicalTextAudit("briefing", panelRef as React.RefObject<HTMLElement>);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await callEdgeFunction("karel-external-reality-sentinel", {
          action: "list_impacts",
        });
        if (cancelled) return;
        const raw = ((res as { impacts?: RawExternalImpact[] })?.impacts ?? []) as RawExternalImpact[];
        const display = clusterAndHumanizeExternalImpacts(raw);
        setCards(display);
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
        Možné vnější zatížení: nepodařilo se načíst.
      </div>
    );
  }
  if (cards.length === 0 && !showWhenEmpty) return null;

  return (
    <section
      ref={panelRef as React.RefObject<HTMLElement>}
      data-testid="external-load-warning"
      data-visible-clinical-panel="briefing"
      className="rounded-lg border border-border/60 bg-background/40 p-3 space-y-2"
    >
      <header className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-700" aria-hidden />
        <h3 className="font-serif text-base text-foreground">Možné vnější zatížení</h3>
        <span className="text-xs text-muted-foreground">
          ({cards.length} {cards.length === 1 ? "téma" : cards.length < 5 ? "témata" : "témat"})
        </span>
      </header>
      {cards.length === 0 ? (
        <p className="text-xs text-muted-foreground">Aktuálně žádná aktivní vnější zátěž.</p>
      ) : (
        <ul className="space-y-1.5">
          {cards.slice(0, 8).map((c) => {
            const meta = RISK_META[c.risk_level];
            const Icon = meta.Icon;
            return (
              <li
                key={c.key}
                className={`rounded-md border p-2 text-xs ${meta.tone}`}
                data-risk={c.risk_level}
                data-part={c.part_name}
              >
                <div className="flex items-center gap-2 font-medium">
                  <Icon className="h-3.5 w-3.5" aria-hidden />
                  <span>{c.part_name}</span>
                  <span className="opacity-70">·</span>
                  <span className="uppercase tracking-wide text-[10px]">{meta.label}</span>
                  <span className="opacity-70 truncate">· {c.theme_label}</span>
                </div>
                <div className="mt-1 leading-snug">{c.body}</div>
                {c.recommendation && (
                  <div className="mt-1 italic opacity-90">
                    Doporučení: {c.recommendation}
                  </div>
                )}
                <div className="mt-1 text-[10px] opacity-60">
                  Co dnes hlídat: tělo · emoci · pocit bezpečí · zahlcení · potřebu zastavit.
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[10px] text-muted-foreground italic">
        Klinické doporučení. Nepřidávejte grafické detaily ani neověřené zprávy.
      </p>
    </section>
  );
}

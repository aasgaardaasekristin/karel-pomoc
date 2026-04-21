/**
 * KarelCrisisDeficits — Crisis Function Reallocation Repair Pass (2026-04-21).
 *
 * Smysl:
 *   Banner je signalizační vrstva. Nesmí nést Karlovy pracovní deficity
 *   (chybí dnešní hodnocení / chybí feedback / dlouho bez kontaktu).
 *   Tyto deficity jsou Karlovy rozhodovací úkoly — patří do Karlova přehledu.
 *
 * Co tato komponenta dělá:
 *   - Z `useCrisisOperationalState` přečte aktivní krize.
 *   - Pro každou krizi vyhodnotí deficity:
 *       • missingTodayInterview     → "Chybí dnešní hodnocení"
 *       • missingTherapistFeedback  → "Chybí feedback terapeutek"
 *       • isStale                   → "Dlouho bez kontaktu (Xh)"
 *   - Pro každý deficit nabídne CTA `Otevřít detail`, který emituje
 *     `karel:open-crisis-detail` event s eventId/alertId. CrisisAlert
 *     na něj zareaguje rozbalením příslušné krize. (Minimální handoff,
 *     žádný route přepis v tomto passu.)
 *
 * Co tato komponenta NEdělá:
 *   - žádné přímé side-effect workflow akce (vše vede do detailu krize)
 *   - žádný technický inspect
 *   - žádné mid-level orchestrace
 */

import React from "react";
import { AlertCircle, Clock, ClipboardList, Play, ExternalLink } from "lucide-react";
import { useCrisisOperationalState, type CrisisOperationalCard } from "@/hooks/useCrisisOperationalState";

type DeficitKind = "missing_interview" | "missing_feedback" | "stale";

interface Deficit {
  cardId: string;
  partName: string;
  displayName: string;
  kind: DeficitKind;
  label: string;
  detail?: string;
  icon: React.ReactNode;
}

function buildDeficits(cards: CrisisOperationalCard[]): Deficit[] {
  const out: Deficit[] = [];
  for (const c of cards) {
    const id = c.eventId || c.alertId || c.partName;
    if (c.missingTodayInterview) {
      out.push({
        cardId: id,
        partName: c.partName,
        displayName: c.displayName,
        kind: "missing_interview",
        label: "Chybí dnešní hodnocení",
        detail: "Karel ještě dnes nevedl interview s částí.",
        icon: <Play className="w-3.5 h-3.5" />,
      });
    }
    if (c.missingTherapistFeedback) {
      out.push({
        cardId: id,
        partName: c.partName,
        displayName: c.displayName,
        kind: "missing_feedback",
        label: "Chybí feedback terapeutek",
        detail: "Čekáme na vyjádření Haničky / Káti.",
        icon: <ClipboardList className="w-3.5 h-3.5" />,
      });
    }
    if (c.isStale) {
      out.push({
        cardId: id,
        partName: c.partName,
        displayName: c.displayName,
        kind: "stale",
        label: "Dlouho bez kontaktu",
        detail: `${Math.round(c.hoursStale)}h bez kontaktu — potřeba doplnit pozorování.`,
        icon: <Clock className="w-3.5 h-3.5" />,
      });
    }
  }
  return out;
}

function emitOpenCrisisDetail(cardId: string) {
  // Lightweight handoff bridge — CrisisAlert může v budoucnu poslouchat.
  // V tomto passu nechceme přepisovat routing; toto je nejmenší correct handoff.
  try {
    window.dispatchEvent(new CustomEvent("karel:open-crisis-detail", { detail: { cardId } }));
  } catch {
    /* no-op */
  }
  // Plus: scroll na vrch, kde je banner.
  window.scrollTo({ top: 0, behavior: "smooth" });
}

const KarelCrisisDeficits: React.FC = () => {
  const { cards, loading } = useCrisisOperationalState();

  if (loading) return null;
  const deficits = buildDeficits(cards);
  if (deficits.length === 0) {
    return (
      <div className="jung-card p-4 space-y-2">
        <div className="flex items-center gap-2 text-sm font-serif">
          <AlertCircle className="h-4 w-4 text-primary" />
          <span>Krizové deficity dne</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Žádné dnešní deficity — Karlův krizový pracovní seznam je vyčištěný.
        </p>
      </div>
    );
  }

  return (
    <div className="jung-card p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-serif">
        <AlertCircle className="h-4 w-4 text-primary" />
        <span>Krizové deficity dne</span>
        <span className="text-[10px] font-light text-muted-foreground ml-auto">
          {deficits.length} {deficits.length === 1 ? "položka" : deficits.length < 5 ? "položky" : "položek"}
        </span>
      </div>

      <ul className="space-y-1.5">
        {deficits.map((d, idx) => (
          <li
            key={`${d.cardId}-${d.kind}-${idx}`}
            className="rounded-lg border border-border/50 bg-card/40 p-2.5 flex items-start gap-3"
          >
            <span className="mt-0.5 text-muted-foreground shrink-0">{d.icon}</span>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-foreground">
                {d.displayName} — {d.label}
              </div>
              {d.detail && (
                <div className="text-[11px] text-muted-foreground leading-snug mt-0.5">
                  {d.detail}
                </div>
              )}
            </div>
            <button
              onClick={() => emitOpenCrisisDetail(d.cardId)}
              className="shrink-0 inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded text-primary hover:bg-primary/10 transition-colors"
              aria-label={`Otevřít detail krize pro ${d.displayName}`}
            >
              Otevřít detail <ExternalLink className="w-3 h-3" />
            </button>
          </li>
        ))}
      </ul>

      <p className="text-[10px] text-muted-foreground italic pt-1 border-t border-border/40">
        Workflow akce (spustit hodnocení, získat feedback, otevřít poradu) žijí v záložce „Řízení" v detailu krize.
      </p>
    </div>
  );
};

export default KarelCrisisDeficits;

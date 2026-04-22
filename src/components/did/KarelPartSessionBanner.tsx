/**
 * KarelPartSessionBanner
 *
 * Vizuální odlišovník "herny" (Karel + část room) uvnitř standardního
 * cast-thread shellu. Zobrazí se v Chat.tsx pouze pro vlákna se
 * `sub_mode === "karel_part_session"`. Žádný nový room, žádný nový shell —
 * jen jasná hlavička, která říká "tohle je dnešní herna Karla s částí".
 */

import { Sparkles, Dices } from "lucide-react";

interface Props {
  partName: string;
  dateLabel: string;
}

const KarelPartSessionBanner = ({ partName, dateLabel }: Props) => (
  <div
    className="rounded-xl border px-4 py-3 mb-3 flex items-center gap-3"
    style={{
      background: "linear-gradient(135deg, hsl(var(--primary) / 0.08), hsl(var(--accent) / 0.05))",
      borderColor: "hsl(var(--primary) / 0.18)",
    }}
  >
    <div
      className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
      style={{ background: "hsl(var(--primary) / 0.12)" }}
    >
      <Dices className="w-4 h-4 text-primary" />
    </div>
    <div className="flex-1 min-w-0">
      <div className="text-[12px] uppercase tracking-wider text-primary/70 font-medium flex items-center gap-1.5">
        <Sparkles className="w-3 h-3" />
        Karel-led herna · online přes obrazovku
      </div>
      <div className="text-[14px] text-foreground/90 font-serif">
        Sezení vede <span className="font-semibold">Karel</span> s{" "}
        <span className="font-semibold">{partName}</span>
        <span className="text-muted-foreground"> · {dateLabel}</span>
      </div>
    </div>
  </div>
);

export default KarelPartSessionBanner;

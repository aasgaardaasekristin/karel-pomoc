import { ShieldAlert } from "lucide-react";

const CrisisIntroSection = () => (
  <div className="space-y-3 text-foreground/90">
    <div className="flex items-start gap-3 p-3 rounded-lg bg-destructive/5 border border-destructive/15">
      <ShieldAlert className="w-5 h-5 text-destructive mt-0.5 shrink-0" />
      <div className="space-y-2 leading-relaxed">
        <p>Z Režimu C byla zachycena anonymní situace s vysokým distresem.</p>
        <p>Osoba odmítla krizové linky a zvažuje kontakt s terapeutkou pomocí <strong>kódu 11</strong>.</p>
        <p>Připravil jsem pro tebe supervizní přehled a návrhy bezpečného postupu.</p>
      </div>
    </div>
  </div>
);

export default CrisisIntroSection;

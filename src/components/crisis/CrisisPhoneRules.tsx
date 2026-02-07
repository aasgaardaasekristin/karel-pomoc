import { Phone, ShieldCheck, AlertTriangle } from "lucide-react";
import type { DbCrisisBrief } from "./types";

const CrisisPhoneRules = ({ brief }: { brief: DbCrisisBrief }) => {
  const bridgeTriggered = brief.therapist_bridge_triggered;
  const bridgeMethod = brief.therapist_bridge_method;

  return (
    <div className="space-y-4">
      {/* Rules */}
      <div className="space-y-2">
        <div className="flex items-start gap-2 text-sm">
          <AlertTriangle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
          <p>Telefonní číslo se <strong>NIKDY</strong> nevyžaduje automaticky.</p>
        </div>
        <div className="flex items-start gap-2 text-sm">
          <ShieldCheck className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          <p>Číslo se žádá <strong>pouze</strong> pokud je nabídnut telefonát a klient s ním výslovně souhlasí.</p>
        </div>
        <div className="flex items-start gap-2 text-sm">
          <Phone className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
          <p>Žádost musí vždy obsahovat: <em>„Pouze pro tento jeden domluvený hovor."</em></p>
        </div>
        <div className="flex items-start gap-2 text-sm">
          <ShieldCheck className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          <p>Pokud číslo neposkytne → respektuj to, pokračuj psanou formou.</p>
        </div>
      </div>

      {/* Status from this brief */}
      <div className="p-3 rounded-lg bg-muted/50 border border-border space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">Stav u tohoto briefu:</p>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className={`px-2.5 py-1 rounded-md ${bridgeTriggered ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
            Most k terapeutce: {bridgeTriggered ? "ano" : "ne"}
          </span>
          <span className="px-2.5 py-1 rounded-md bg-muted text-muted-foreground">
            Metoda: {bridgeMethod || "zatím nevybrána"}
          </span>
          <span className={`px-2.5 py-1 rounded-md ${bridgeMethod === "email" || bridgeMethod === "sms" ? "bg-amber-500/10 text-amber-700 dark:text-amber-400" : "bg-muted text-muted-foreground"}`}>
            Doporučení: {bridgeMethod === "sms" ? "telefonát možný (se souhlasem)" : "psaná forma"}
          </span>
        </div>
      </div>
    </div>
  );
};

export default CrisisPhoneRules;

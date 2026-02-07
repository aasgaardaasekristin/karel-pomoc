import { Mail, MessageSquare, Phone } from "lucide-react";
import type { DbCrisisBrief } from "./types";

interface RecommendationOption {
  icon: React.ReactNode;
  label: string;
  reason: string;
  recommended: boolean;
}

const CrisisContactRecommendation = ({ brief }: { brief: DbCrisisBrief }) => {
  const signals = brief.signals || {};
  const highHopelessness = signals.hopelessness === true || signals.narrowedFuture === true;
  const helpRefusal = signals.helpRefusal === true;

  // Logic: high hopelessness or help refusal → written form first
  const options: RecommendationOption[] = [
    {
      icon: <Mail className="w-4 h-4" />,
      label: "Začít e-mailem",
      reason: highHopelessness
        ? "Vysoká beznaděj → psaná forma je bezpečnější úvod, klient nemusí hned mluvit."
        : "E-mail umožňuje promyšlenou odpověď bez tlaku na okamžitou reakci.",
      recommended: highHopelessness || helpRefusal,
    },
    {
      icon: <MessageSquare className="w-4 h-4" />,
      label: "Zůstat u psané formy",
      reason: helpRefusal
        ? "Osoba odmítla pomoc – psaná forma respektuje její tempo a hranice."
        : "Psaná forma je méně invazivní a dává prostor pro formulaci.",
      recommended: helpRefusal && !highHopelessness,
    },
    {
      icon: <Phone className="w-4 h-4" />,
      label: "Krátký telefonát (10–15 min), pouze se souhlasem",
      reason: "Telefon pouze pokud klient sám požádá a souhlasí. Nikdy automaticky.",
      recommended: false,
    },
  ];

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Karel doporučuje formu prvního kontaktu podle zachycených signálů:</p>
      <div className="space-y-2">
        {options.map((opt, i) => (
          <div
            key={i}
            className={`flex items-start gap-3 p-3 rounded-lg border ${
              opt.recommended
                ? "border-primary/30 bg-primary/5"
                : "border-border bg-muted/30"
            }`}
          >
            <div className={`mt-0.5 ${opt.recommended ? "text-primary" : "text-muted-foreground"}`}>
              {opt.icon}
            </div>
            <div>
              <p className={`text-sm font-medium ${opt.recommended ? "text-primary" : "text-foreground"}`}>
                {opt.recommended && "✦ "}{opt.label}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">{opt.reason}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default CrisisContactRecommendation;

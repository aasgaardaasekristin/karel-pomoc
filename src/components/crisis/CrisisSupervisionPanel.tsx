import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ShieldAlert, X, ChevronDown, ChevronUp, Mail } from "lucide-react";
import type { DbCrisisBrief } from "./types";
import CrisisIntroSection from "./CrisisIntroSection";
import CrisisImprintSection from "./CrisisImprintSection";
import CrisisContactRecommendation from "./CrisisContactRecommendation";
import CrisisTemplates from "./CrisisTemplates";
import CrisisPhoneRules from "./CrisisPhoneRules";
import CrisisSafetyChecklist from "./CrisisSafetyChecklist";
import CrisisRightsBlock from "./CrisisRightsBlock";
import CrisisSupervisionChat from "./CrisisSupervisionChat";

interface Props {
  brief: DbCrisisBrief;
  onMarkRead: (id: string) => void;
  onClose: () => void;
}

const CrisisSupervisionPanel = ({ brief, onMarkRead, onClose }: Props) => {
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

  const toggleSection = (key: string) => {
    setCollapsedSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const exportBriefToEmail = () => {
    const signals = brief.signals as Record<string, boolean>;
    const activeSignals = Object.entries(signals)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(", ");

    const body = [
      `KRIZOVÝ SUPERVIZNÍ BRIEF`,
      `Datum: ${new Date(brief.created_at).toLocaleString("cs-CZ")}`,
      `Scénář: ${brief.scenario}`,
      `Risk score: ${brief.risk_score}`,
      ``,
      `--- Přehled rizika ---`,
      brief.risk_overview,
      ``,
      `--- Aktivní signály ---`,
      activeSignals || "žádné",
      ``,
      `--- Doporučený kontakt ---`,
      brief.recommended_contact,
      ``,
      `--- Formulace rizika ---`,
      ...(brief.risk_formulations || []).map((r, i) => `${i + 1}. ${r}`),
      ``,
      `--- Další kroky ---`,
      ...(brief.next_steps || []).map((s, i) => `${i + 1}. ${s}`),
      ``,
      `--- Navržená úvodní slova ---`,
      ...(brief.suggested_opening_lines || []).map((l, i) => `${i + 1}. ${l}`),
      ``,
      `Poznámka: ${brief.note || "—"}`,
    ].join("\n");

    const subject = `Krizový brief – ${brief.scenario} (risk ${brief.risk_score}) – ${new Date(brief.created_at).toLocaleDateString("cs-CZ")}`;
    const mailto = `mailto:psychoterapie@hana-chlebcova.cz?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(mailto, "_blank");
  };

  const sections = [
    { key: "intro", label: "Úvodní shrnutí", component: <CrisisIntroSection /> },
    { key: "imprint", label: "Krizový otisk", component: <CrisisImprintSection brief={brief} /> },
    { key: "contact", label: "Doporučená forma kontaktu", component: <CrisisContactRecommendation brief={brief} /> },
    { key: "templates", label: "Navržené odpovědi – klikni a pošli", component: <CrisisTemplates /> },
    { key: "phone", label: "Pravidla pro telefonní číslo", component: <CrisisPhoneRules brief={brief} /> },
    { key: "safety", label: "Na co si dát pozor", component: <CrisisSafetyChecklist /> },
    { key: "rights", label: "Práva a povinnosti terapeutky", component: <CrisisRightsBlock /> },
    { key: "supervision", label: "Supervizní rozhovor s Karlem", component: <CrisisSupervisionChat brief={brief} /> },
  ];

  return (
    <div className="border-b-2 border-destructive/30 bg-card flex flex-col" style={{ maxHeight: 'calc(100vh - 140px)' }}>
      {/* Header */}
      <div className="border-b border-destructive/20 bg-destructive/5 px-4 py-4 shrink-0">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ShieldAlert className="w-6 h-6 text-destructive" />
            <div>
              <h2 className="text-base font-serif font-semibold text-foreground">Krizový supervizní panel</h2>
              <p className="text-xs text-muted-foreground">
                {brief.scenario} · Risk {brief.risk_score} · {new Date(brief.created_at).toLocaleString("cs-CZ")}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={exportBriefToEmail} className="text-xs">
              <Mail className="w-3 h-3 mr-1" />
              Exportovat brief
            </Button>
            <Button variant="outline" size="sm" onClick={() => onMarkRead(brief.id)} className="text-xs">
              Označit jako přečtené
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-4xl mx-auto px-4 py-4 space-y-1">
          {sections.map(({ key, label, component }, idx) => {
            const isCollapsed = collapsedSections[key];
            return (
              <div key={key} className="border border-border rounded-lg overflow-hidden">
                <button
                  onClick={() => toggleSection(key)}
                  className="w-full flex items-center justify-between px-4 py-3 bg-muted/50 hover:bg-muted transition-colors text-left"
                >
                  <span className="text-sm font-medium text-foreground">
                    {idx + 1}. {label}
                  </span>
                  {isCollapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
                </button>
                {!isCollapsed && (
                  <div className="px-4 py-4 bg-card text-sm">
                    {component}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="max-w-4xl mx-auto px-4 pb-4">
          <p className="text-[0.6875rem] text-muted-foreground border-t border-border pt-3 mt-2">
            Karel nepracuje s klientem. Karel připravuje terapeutku. Žádná identita nebyla předána. Žádné chat logy z Režimu C nebyly přeneseny.
          </p>
        </div>
      </div>
    </div>
  );
};

export default CrisisSupervisionPanel;

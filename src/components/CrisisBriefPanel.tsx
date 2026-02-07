import { useCrisisSupervision } from "@/contexts/CrisisSupervisionContext";
import { Button } from "@/components/ui/button";
import { ShieldAlert, Phone, MessageSquare, AlertTriangle, ChevronRight, Loader2, X } from "lucide-react";
import { toast } from "sonner";

const CrisisBriefPanel = () => {
  const {
    pendingImprints,
    crisisBrief,
    setCrisisBrief,
    clearImprints,
    isBriefLoading,
    setIsBriefLoading,
  } = useCrisisSupervision();

  const latestImprint = pendingImprints[pendingImprints.length - 1];

  const generateBrief = async () => {
    if (!latestImprint) return;
    setIsBriefLoading(true);

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-crisis-brief`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({ imprint: latestImprint }),
        }
      );

      if (!response.ok) throw new Error("Brief generation failed");

      const data = await response.json();
      setCrisisBrief({
        ...data,
        imprint: latestImprint,
      });
    } catch (error) {
      console.error("Crisis brief error:", error);
      toast.error("Chyba při generování krizového briefu");
    } finally {
      setIsBriefLoading(false);
    }
  };

  if (pendingImprints.length === 0 && !crisisBrief) return null;

  // Notification banner (before brief is generated)
  if (!crisisBrief && !isBriefLoading) {
    return (
      <div className="border-b border-destructive/30 bg-destructive/5 px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ShieldAlert className="w-5 h-5 text-destructive shrink-0" />
            <div>
              <p className="text-sm font-medium text-foreground">
                Krizový supervizní brief čeká na zpracování
              </p>
              <p className="text-xs text-muted-foreground">
                Anonymní otisk z Režimu C – {latestImprint?.scenario} (risk: {latestImprint?.riskScore})
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={clearImprints} className="text-xs">
              <X className="w-3 h-3 mr-1" />
              Zavřít
            </Button>
            <Button size="sm" onClick={generateBrief} className="text-xs">
              <ChevronRight className="w-3 h-3 mr-1" />
              Zobrazit brief
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Loading state
  if (isBriefLoading) {
    return (
      <div className="border-b border-primary/30 bg-primary/5 px-4 py-4">
        <div className="max-w-4xl mx-auto flex items-center gap-3">
          <Loader2 className="w-5 h-5 text-primary animate-spin" />
          <p className="text-sm text-foreground">Karel připravuje supervizní brief...</p>
        </div>
      </div>
    );
  }

  // Full brief view
  if (crisisBrief) {
    return (
      <div className="border-b border-destructive/20 bg-card">
        <div className="max-w-4xl mx-auto px-4 py-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-destructive" />
              <h3 className="text-sm font-semibold text-foreground">Krizový supervizní brief</h3>
              <span className="text-xs bg-destructive/10 text-destructive px-2 py-0.5 rounded-full">
                Risk {crisisBrief.imprint.riskScore}
              </span>
            </div>
            <Button variant="ghost" size="sm" onClick={clearImprints} className="text-xs text-muted-foreground">
              <X className="w-3 h-3 mr-1" />
              Zavřít
            </Button>
          </div>

          <div className="grid gap-4 text-sm">
            {/* Risk Overview */}
            {crisisBrief.riskOverview && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-destructive font-medium">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Přehled rizik
                </div>
                <p className="text-foreground/90 pl-5">{crisisBrief.riskOverview}</p>
              </div>
            )}

            {/* Recommended Contact */}
            {crisisBrief.recommendedContact && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-primary font-medium">
                  <Phone className="w-3.5 h-3.5" />
                  Doporučený způsob kontaktu
                </div>
                <p className="text-foreground/90 pl-5">{crisisBrief.recommendedContact}</p>
              </div>
            )}

            {/* Suggested Opening Lines */}
            {crisisBrief.suggestedOpeningLines.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-primary font-medium">
                  <MessageSquare className="w-3.5 h-3.5" />
                  Návrh prvních vět
                </div>
                <ul className="space-y-1 pl-5">
                  {crisisBrief.suggestedOpeningLines.map((line, i) => (
                    <li key={i} className="text-foreground/90 italic">„{line}"</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Risk Formulations */}
            {crisisBrief.riskFormulations.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-amber-600 font-medium">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Rizikové formulace
                </div>
                <ul className="space-y-1 pl-5">
                  {crisisBrief.riskFormulations.map((f, i) => (
                    <li key={i} className="text-foreground/90">{f}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Next Steps */}
            {crisisBrief.nextSteps.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-primary font-medium">
                  <ChevronRight className="w-3.5 h-3.5" />
                  Další doporučené kroky
                </div>
                <ul className="space-y-1 pl-5">
                  {crisisBrief.nextSteps.map((s, i) => (
                    <li key={i} className="text-foreground/90">{s}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <p className="text-[11px] text-muted-foreground mt-4 border-t border-border pt-3">
            Karel nepracuje s klientem. Karel připravuje terapeutku. Žádná identita nebyla předána.
          </p>
        </div>
      </div>
    );
  }

  return null;
};

export default CrisisBriefPanel;

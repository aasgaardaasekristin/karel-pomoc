import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ShieldAlert, Phone, MessageSquare, AlertTriangle, ChevronRight, Loader2, X, Check } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface DbCrisisBrief {
  id: string;
  created_at: string;
  scenario: string;
  risk_score: number;
  risk_overview: string;
  recommended_contact: string;
  suggested_opening_lines: string[];
  risk_formulations: string[];
  next_steps: string[];
  is_read: boolean;
}

const CrisisBriefPanel = () => {
  const [briefs, setBriefs] = useState<DbCrisisBrief[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Load unread briefs from DB on mount and poll every 30s
  useEffect(() => {
    const loadBriefs = async () => {
      const { data, error } = await supabase
        .from("crisis_briefs")
        .select("id, created_at, scenario, risk_score, risk_overview, recommended_contact, suggested_opening_lines, risk_formulations, next_steps, is_read")
        .eq("is_read", false)
        .order("created_at", { ascending: false })
        .limit(10);

      if (!error && data) {
        setBriefs(data as unknown as DbCrisisBrief[]);
      }
      setLoading(false);
    };

    loadBriefs();
    const interval = setInterval(loadBriefs, 30000);
    return () => clearInterval(interval);
  }, []);

  const markAsRead = async (id: string) => {
    await supabase.from("crisis_briefs").update({ is_read: true }).eq("id", id);
    setBriefs(prev => prev.filter(b => b.id !== id));
    setExpandedId(null);
  };

  const dismissAll = async () => {
    for (const b of briefs) {
      await supabase.from("crisis_briefs").update({ is_read: true }).eq("id", b.id);
    }
    setBriefs([]);
    setExpandedId(null);
  };

  if (loading || briefs.length === 0) return null;

  const expanded = briefs.find(b => b.id === expandedId);

  // Expanded view of a single brief
  if (expanded) {
    return (
      <div className="border-b border-destructive/20 bg-card">
        <div className="max-w-4xl mx-auto px-4 py-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-destructive" />
              <h3 className="text-sm font-semibold text-foreground">Krizový supervizní brief</h3>
              <span className="text-xs bg-destructive/10 text-destructive px-2 py-0.5 rounded-full">
                Risk {expanded.risk_score}
              </span>
              <span className="text-xs text-muted-foreground">
                {new Date(expanded.created_at).toLocaleString("cs-CZ")}
              </span>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => markAsRead(expanded.id)} className="text-xs">
                <Check className="w-3 h-3 mr-1" />
                Přečteno
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setExpandedId(null)} className="text-xs text-muted-foreground">
                <X className="w-3 h-3 mr-1" />
                Zavřít
              </Button>
            </div>
          </div>

          <div className="grid gap-4 text-sm">
            {expanded.risk_overview && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-destructive font-medium">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Přehled rizik
                </div>
                <p className="text-foreground/90 pl-5">{expanded.risk_overview}</p>
              </div>
            )}

            {expanded.recommended_contact && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-primary font-medium">
                  <Phone className="w-3.5 h-3.5" />
                  Doporučený způsob kontaktu
                </div>
                <p className="text-foreground/90 pl-5">{expanded.recommended_contact}</p>
              </div>
            )}

            {expanded.suggested_opening_lines?.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-primary font-medium">
                  <MessageSquare className="w-3.5 h-3.5" />
                  Návrh prvních vět
                </div>
                <ul className="space-y-1 pl-5">
                  {expanded.suggested_opening_lines.map((line, i) => (
                    <li key={i} className="text-foreground/90 italic">„{line}"</li>
                  ))}
                </ul>
              </div>
            )}

            {expanded.risk_formulations?.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-amber-600 font-medium">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Rizikové formulace
                </div>
                <ul className="space-y-1 pl-5">
                  {expanded.risk_formulations.map((f, i) => (
                    <li key={i} className="text-foreground/90">{f}</li>
                  ))}
                </ul>
              </div>
            )}

            {expanded.next_steps?.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-primary font-medium">
                  <ChevronRight className="w-3.5 h-3.5" />
                  Další doporučené kroky
                </div>
                <ul className="space-y-1 pl-5">
                  {expanded.next_steps.map((s, i) => (
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

  // Notification banner(s)
  return (
    <div className="border-b border-destructive/30 bg-destructive/5 px-4 py-3">
      <div className="max-w-4xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShieldAlert className="w-5 h-5 text-destructive shrink-0" />
          <div>
            <p className="text-sm font-medium text-foreground">
              {briefs.length === 1
                ? "Krizový supervizní brief čeká na přečtení"
                : `${briefs.length} krizové briefy čekají na přečtení`}
            </p>
            <p className="text-xs text-muted-foreground">
              Nejnovější: {briefs[0].scenario} (risk: {briefs[0].risk_score}) – {new Date(briefs[0].created_at).toLocaleString("cs-CZ")}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          {briefs.length > 1 && (
            <Button variant="outline" size="sm" onClick={dismissAll} className="text-xs">
              <Check className="w-3 h-3 mr-1" />
              Vše přečteno
            </Button>
          )}
          <Button size="sm" onClick={() => setExpandedId(briefs[0].id)} className="text-xs">
            <ChevronRight className="w-3 h-3 mr-1" />
            Zobrazit brief
          </Button>
        </div>
      </div>
    </div>
  );
};

export default CrisisBriefPanel;

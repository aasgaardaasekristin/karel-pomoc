import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Users, Play, FileText, CheckCircle2, Circle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";

interface ClientSummaryCardProps {
  clientId: string;
  clientName: string;
  onStartLiveSession: () => void;
  onCaseSummaryLoaded?: (summary: string | null) => void;
}

interface FormFieldStatus {
  label: string;
  filled: boolean;
}

const ClientSummaryCard = ({ clientId, clientName, onStartLiveSession, onCaseSummaryLoaded }: ClientSummaryCardProps) => {
  const [caseSummary, setCaseSummary] = useState<string | null>(null);
  const [lastSessionSummary, setLastSessionSummary] = useState<string | null>(null);
  const [formFields, setFormFields] = useState<FormFieldStatus[]>([]);
  const [sessionCount, setSessionCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  const loadClientData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [clientRes, sessionsRes] = await Promise.all([
        supabase.from("clients").select("*").eq("id", clientId).single(),
        supabase.from("client_sessions")
          .select("*")
          .eq("client_id", clientId)
          .order("session_date", { ascending: false }),
      ]);

      const client = clientRes.data;
      const sessions = sessionsRes.data || [];
      setSessionCount(sessions.length);

      if (client) {
        setFormFields([
          { label: "Věk", filled: !!client.age },
          { label: "Pohlaví", filled: !!client.gender },
          { label: "Diagnóza", filled: !!client.diagnosis?.trim() },
          { label: "Typ terapie", filled: !!client.therapy_type?.trim() },
          { label: "Klíčová anamnéza", filled: !!client.key_history?.trim() },
          { label: "Rodinný kontext", filled: !!client.family_context?.trim() },
          { label: "Zdroj doporučení", filled: !!client.referral_source?.trim() },
          { label: "Poznámky", filled: !!client.notes?.trim() },
        ]);
      }

      if (sessions.length === 0) {
        setCaseSummary("Nový klient – zatím žádná sezení v kartotéce.");
        setLastSessionSummary(null);
        setIsLoading(false);
        return;
      }

      const headers = await getAuthHeaders();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-client-summary`, {
        method: "POST",
        headers,
        body: JSON.stringify({ clientId }),
      });

      if (!res.ok) {
        setCaseSummary(`${clientName} – ${sessions.length} sezení v kartotéce.`);
        const last = sessions[0];
        if (last?.ai_analysis) {
          setLastSessionSummary(last.ai_analysis.slice(0, 300) + (last.ai_analysis.length > 300 ? "…" : ""));
        }
      } else {
        const data = await res.json();
        setCaseSummary(data.caseSummary || null);
        setLastSessionSummary(data.lastSessionSummary || null);
        onCaseSummaryLoaded?.(data.caseSummary || null);
      }
    } catch (e) {
      console.error("Client data load error:", e);
      setCaseSummary("Nepodařilo se načíst data klienta.");
    } finally {
      setIsLoading(false);
    }
  }, [clientId, clientName]);

  useEffect(() => {
    loadClientData();
  }, [loadClientData]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center space-y-4">
          <Loader2 className="w-10 h-10 animate-spin text-primary mx-auto" />
          <div>
            <p className="text-sm font-medium text-foreground">Karel analyzuje kartu klienta</p>
            <p className="text-xs text-muted-foreground mt-1">Načítám historii sezení a připravuji shrnutí…</p>
          </div>
        </div>
      </div>
    );
  }

  const filledCount = formFields.filter(f => f.filled).length;
  const fillPercent = formFields.length > 0 ? Math.round((filledCount / formFields.length) * 100) : 0;

  return (
    <ScrollArea className="flex-1">
      <div className="max-w-2xl mx-auto px-4 py-8 sm:py-12 space-y-6">
        {/* Client header */}
        <div className="text-center space-y-3">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
            <Users className="w-8 h-8 text-primary" />
          </div>
          <div>
            <h2 className="text-xl sm:text-2xl font-serif font-semibold text-foreground">{clientName}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {sessionCount === 0 ? "Nový klient" : `${sessionCount} ${sessionCount === 1 ? "sezení" : sessionCount < 5 ? "sezení" : "sezení"} v kartotéce`}
            </p>
          </div>
        </div>

        {/* Case summary */}
        {caseSummary && (
          <div className="bg-card border border-border rounded-xl p-5 space-y-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Shrnutí případu</h3>
            <p className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed">{caseSummary}</p>
          </div>
        )}

        {/* Last session summary */}
        {lastSessionSummary && (
          <div className="bg-card border border-border rounded-xl p-5 space-y-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Poslední sezení</h3>
            <p className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed">{lastSessionSummary}</p>
          </div>
        )}

        {/* Form status */}
        {formFields.length > 0 && (
          <div className="bg-card border border-border rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                <FileText className="w-3 h-3" />
                Stav karty
              </h3>
              <span className="text-xs text-muted-foreground">{fillPercent}% vyplněno</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {formFields.map((f) => (
                <div
                  key={f.label}
                  className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg ${
                    f.filled
                      ? "bg-primary/5 text-primary"
                      : "bg-muted/30 text-muted-foreground"
                  }`}
                >
                  {f.filled ? <CheckCircle2 className="w-3 h-3 shrink-0" /> : <Circle className="w-3 h-3 shrink-0" />}
                  {f.label}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Start button */}
        <div className="pt-2">
          <Button
            size="lg"
            onClick={onStartLiveSession}
            className="w-full h-14 text-base gap-3 rounded-xl shadow-sm"
          >
            <Play className="w-5 h-5" />
            Zahájit sezení za přítomnosti Karla
          </Button>
          <p className="text-xs text-muted-foreground text-center mt-3">
            Karel bude v reálném čase radit během sezení s klientem.
          </p>
        </div>
      </div>
    </ScrollArea>
  );
};

export default ClientSummaryCard;

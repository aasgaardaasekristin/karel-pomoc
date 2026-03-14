import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Users, Play, FileText } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";

interface ClientSummaryCardProps {
  clientId: string;
  clientName: string;
  onStartLiveSession: () => void;
}

interface FormFieldStatus {
  label: string;
  filled: boolean;
}

const ClientSummaryCard = ({ clientId, clientName, onStartLiveSession }: ClientSummaryCardProps) => {
  const [caseSummary, setCaseSummary] = useState<string | null>(null);
  const [lastSessionSummary, setLastSessionSummary] = useState<string | null>(null);
  const [formFields, setFormFields] = useState<FormFieldStatus[]>([]);
  const [sessionCount, setSessionCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  const loadClientData = useCallback(async () => {
    setIsLoading(true);
    try {
      // Fetch client info and all sessions in parallel
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

      // Build form field status from client card
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

      // Call AI to generate summary
      const headers = await getAuthHeaders();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-client-summary`, {
        method: "POST",
        headers,
        body: JSON.stringify({ clientId }),
      });

      if (!res.ok) {
        console.error("Summary fetch failed:", res.status);
        // Fallback to basic info
        setCaseSummary(`${clientName} – ${sessions.length} sezení v kartotéce.`);
        const last = sessions[0];
        if (last?.ai_analysis) {
          setLastSessionSummary(last.ai_analysis.slice(0, 300) + (last.ai_analysis.length > 300 ? "…" : ""));
        }
      } else {
        const data = await res.json();
        setCaseSummary(data.caseSummary || null);
        setLastSessionSummary(data.lastSessionSummary || null);
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
        <div className="text-center space-y-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto" />
          <p className="text-sm text-muted-foreground">Karel analyzuje kartu klienta...</p>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1">
      <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-5">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
            <Users className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">{clientName}</h2>
            <p className="text-xs text-muted-foreground">{sessionCount} sezení v kartotéce</p>
          </div>
        </div>

        {/* Intro text */}
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-sm text-foreground leading-relaxed">
            Hani, jsem tu s Tebou na tomto sezení pro: <strong>{clientName}</strong>
          </p>
        </div>

        {/* Case summary */}
        {caseSummary && (
          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Shrnutí případu</h3>
            <div className="bg-card border border-border rounded-lg p-4">
              <p className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed">{caseSummary}</p>
            </div>
          </div>
        )}

        {/* Last session summary */}
        {lastSessionSummary && (
          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Poslední sezení</h3>
            <div className="bg-card border border-border rounded-lg p-4">
              <p className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed">{lastSessionSummary}</p>
            </div>
          </div>
        )}

        {/* Form status (small text) */}
        {formFields.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <FileText className="w-3 h-3" />
              Stav karty klienta
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {formFields.map((f) => (
                <span
                  key={f.label}
                  className={`text-[10px] px-2 py-0.5 rounded-full border ${
                    f.filled
                      ? "bg-primary/10 border-primary/20 text-primary"
                      : "bg-muted/50 border-border text-muted-foreground"
                  }`}
                >
                  {f.filled ? "✓" : "○"} {f.label}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Start button */}
        <div className="pt-2">
          <Button
            size="lg"
            onClick={onStartLiveSession}
            className="w-full h-12 text-base gap-2"
          >
            <Play className="w-5 h-5" />
            Zahájit sezení za přítomnosti Karla
          </Button>
        </div>
      </div>
    </ScrollArea>
  );
};

export default ClientSummaryCard;

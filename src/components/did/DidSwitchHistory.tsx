import { useState, useEffect, useCallback } from "react";
import { Shuffle, ChevronDown, ChevronUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";

interface SwitchEvent {
  date: string;
  partName: string;
  therapist: string;
  switches: string[];
}

const DidSwitchHistory = ({ refreshTrigger }: { refreshTrigger: number }) => {
  const [events, setEvents] = useState<SwitchEvent[]>([]);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("did_part_sessions")
      .select("session_date, part_name, therapist, karel_notes")
      .order("session_date", { ascending: false })
      .limit(50);

    if (!data) return;

    const parsed: SwitchEvent[] = [];
    for (const s of data) {
      const notes = s.karel_notes || "";
      const match = notes.match(/## SWITCH LOG\n([\s\S]*?)(?=\n## |$)/);
      if (match) {
        const lines = match[1].trim().split("\n").filter((l: string) => l.trim());
        if (lines.length > 0) {
          parsed.push({
            date: s.session_date,
            partName: s.part_name,
            therapist: s.therapist,
            switches: lines,
          });
        }
      }
    }

    setEvents(parsed);
  }, []);

  useEffect(() => { load(); }, [load, refreshTrigger]);

  if (events.length === 0) return null;

  const totalSwitches = events.reduce((a, e) => a + e.switches.length, 0);

  return (
    <div className="mb-4 rounded-lg border border-border/70 bg-card/38 p-3 backdrop-blur-sm sm:p-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full text-left"
      >
        <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <Shuffle className="w-3.5 h-3.5 text-primary" />
          Historie switchů
          <Badge variant="secondary" className="text-[0.5rem] h-4 px-1.5 ml-1">
            {totalSwitches} switchů v {events.length} sezeních
          </Badge>
        </h4>
        {expanded ? (
          <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="mt-3 space-y-2">
          {events.slice(0, 10).map((event, i) => (
            <div
              key={i}
              className="rounded-md border border-border/50 bg-background/50 p-2"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-[0.625rem] font-medium text-foreground">
                  {new Date(event.date).toLocaleDateString("cs-CZ")} — {event.partName}
                </span>
                <span className="text-[0.5625rem] text-muted-foreground">
                  {event.therapist} · {event.switches.length} switchů
                </span>
              </div>
              <div className="space-y-0.5">
                {event.switches.map((sw, j) => (
                  <p key={j} className="text-[0.5625rem] text-muted-foreground leading-tight">
                    {sw}
                  </p>
                ))}
              </div>
            </div>
          ))}
          {events.length > 10 && (
            <p className="text-[0.5625rem] text-muted-foreground text-center pt-1">
              …a dalších {events.length - 10} sezení se switchi
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default DidSwitchHistory;

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ClipboardCheck, Loader2, FileText, Shuffle, PenLine, ListChecks, ChevronDown, ChevronUp, History } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import RichMarkdown from "@/components/ui/RichMarkdown";

interface ReportMeta {
  periodDays: number;
  sessionCount: number;
  partCount: number;
  switchCount: number;
  reflectionCount: number;
  taskStats: {
    total: number;
    done: number;
    pending: number;
    hankaActive: number;
    kataActive: number;
  };
}

interface SavedReport {
  id: string;
  period_days: number;
  report_markdown: string;
  meta_json: ReportMeta;
  created_at: string;
}

interface Props {
  refreshTrigger: number;
}

const DidSupervisionReport = ({ refreshTrigger }: Props) => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [meta, setMeta] = useState<ReportMeta | null>(null);
  const [period, setPeriod] = useState("14");
  const [expanded, setExpanded] = useState(false);
  const [pastReports, setPastReports] = useState<SavedReport[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedPastId, setSelectedPastId] = useState<string | null>(null);

  const loadPastReports = useCallback(async () => {
    const { data } = await supabase
      .from("did_supervision_reports")
      .select("id, period_days, report_markdown, meta_json, created_at")
      .order("created_at", { ascending: false })
      .limit(10);
    if (data) setPastReports(data as unknown as SavedReport[]);
  }, []);

  useEffect(() => { loadPastReports(); }, [loadPastReports, refreshTrigger]);

  const generateReport = async () => {
    setIsGenerating(true);
    setSelectedPastId(null);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-supervision-report`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ periodDays: parseInt(period) }),
        }
      );

      if (!response.ok) throw new Error("Chyba při generování reportu");
      const data = await response.json();
      setReport(data.report);
      setMeta(data.meta);
      setExpanded(true);
      toast.success("Supervizní report vygenerován a uložen");
      loadPastReports();
    } catch (error) {
      console.error("Supervision report error:", error);
      toast.error("Nepodařilo se vygenerovat report");
    } finally {
      setIsGenerating(false);
    }
  };

  const showPastReport = (r: SavedReport) => {
    setReport(r.report_markdown);
    setMeta(r.meta_json);
    setExpanded(true);
    setSelectedPastId(r.id);
    setShowHistory(false);
  };

  const copyReport = () => {
    if (report) {
      navigator.clipboard.writeText(report);
      toast.success("Report zkopírován do schránky");
    }
  };

  return (
    <div className="mb-4 rounded-lg border border-border/70 bg-card/38 p-3 backdrop-blur-sm sm:p-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <ClipboardCheck className="w-3.5 h-3.5 text-primary" />
          Supervizní report
        </h4>
        <div className="flex items-center gap-2">
          {pastReports.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowHistory(!showHistory)}
              className="h-7 text-[10px] gap-1 text-muted-foreground"
            >
              <History className="w-3 h-3" />
              {pastReports.length}
            </Button>
          )}
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="h-7 text-[10px] w-[100px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">7 dní</SelectItem>
              <SelectItem value="14">14 dní</SelectItem>
              <SelectItem value="30">30 dní</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            onClick={generateReport}
            disabled={isGenerating}
            className="h-7 text-[10px] gap-1"
          >
            {isGenerating ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileText className="w-3 h-3" />}
            {isGenerating ? "Generuji…" : "Generovat"}
          </Button>
        </div>
      </div>

      {showHistory && pastReports.length > 0 && (
        <div className="mb-3 rounded-md border border-border/50 bg-background/40 p-2 space-y-1">
          <p className="text-[10px] text-muted-foreground font-medium mb-1">Historie reportů</p>
          {pastReports.map((r) => (
            <button
              key={r.id}
              onClick={() => showPastReport(r)}
              className={`w-full text-left rounded px-2 py-1.5 text-[10px] transition-colors flex items-center justify-between ${
                selectedPastId === r.id
                  ? "bg-primary/10 text-primary"
                  : "hover:bg-muted/50 text-foreground"
              }`}
            >
              <span>
                {new Date(r.created_at).toLocaleDateString("cs-CZ")} — {r.period_days}d
              </span>
              <span className="text-muted-foreground">
                {r.meta_json?.sessionCount || "?"} sezení
              </span>
            </button>
          ))}
        </div>
      )}

      {meta && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          <Badge variant="secondary" className="text-[9px] h-5 gap-0.5">
            <FileText className="w-2.5 h-2.5" />
            {meta.sessionCount} sezení
          </Badge>
          <Badge variant="secondary" className="text-[9px] h-5 gap-0.5">
            🧩 {meta.partCount} částí
          </Badge>
          <Badge variant="secondary" className="text-[9px] h-5 gap-0.5">
            <Shuffle className="w-2.5 h-2.5" />
            {meta.switchCount} switchů
          </Badge>
          <Badge variant="secondary" className="text-[9px] h-5 gap-0.5">
            <PenLine className="w-2.5 h-2.5" />
            {meta.reflectionCount} reflexí
          </Badge>
          <Badge variant="secondary" className="text-[9px] h-5 gap-0.5">
            <ListChecks className="w-2.5 h-2.5" />
            {meta.taskStats.done}/{meta.taskStats.total} úkolů
          </Badge>
        </div>
      )}

      {report && (
        <>
          <div className="flex items-center gap-2 mb-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded(!expanded)}
              className="h-6 px-2 text-[10px] gap-1 text-muted-foreground"
            >
              {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {expanded ? "Sbalit" : "Rozbalit report"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={copyReport}
              className="h-6 px-2 text-[10px] gap-1 text-muted-foreground"
            >
              📋 Kopírovat
            </Button>
            {selectedPastId && (
              <span className="text-[9px] text-muted-foreground ml-auto">Historický report</span>
            )}
          </div>

          {expanded && (
            <ScrollArea className="max-h-[500px]">
              <div className="rounded-md border border-border/60 bg-background/40 p-3">
                <div className="prose prose-sm max-w-none text-[11px] leading-5 text-foreground
                  prose-headings:text-foreground prose-headings:font-semibold
                  prose-h1:text-sm prose-h1:mb-2 prose-h1:mt-0
                  prose-h2:text-xs prose-h2:mb-1.5 prose-h2:mt-3
                  prose-p:mb-1.5 prose-p:mt-0
                  prose-li:my-0.5
                  prose-strong:text-foreground">
                  <ReactMarkdown>{report}</ReactMarkdown>
                </div>
              </div>
            </ScrollArea>
          )}
        </>
      )}

      {isGenerating && (
        <div className="flex items-center gap-2 py-4 justify-center text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-xs">Karel analyzuje data a generuje supervizní report…</span>
        </div>
      )}
    </div>
  );
};

export default DidSupervisionReport;

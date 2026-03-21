import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ClipboardCheck, Loader2, FileText, Shuffle, PenLine, ListChecks, ChevronDown, ChevronUp } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";

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

interface Props {
  refreshTrigger: number;
}

const DidSupervisionReport = ({ refreshTrigger }: Props) => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [meta, setMeta] = useState<ReportMeta | null>(null);
  const [period, setPeriod] = useState("14");
  const [expanded, setExpanded] = useState(false);

  const generateReport = async () => {
    setIsGenerating(true);
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
      toast.success("Supervizní report vygenerován");
    } catch (error) {
      console.error("Supervision report error:", error);
      toast.error("Nepodařilo se vygenerovat report");
    } finally {
      setIsGenerating(false);
    }
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

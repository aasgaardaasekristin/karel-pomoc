import { Button } from "@/components/ui/button";
import { Copy, Download, FileText, FileCode, Globe } from "lucide-react";
import ReactMarkdown from "react-markdown";

interface ReportOutputProps {
  report: string;
  onCopy: () => void;
  onDownload: (format: "txt" | "md" | "html") => void;
}

const ReportOutput = ({ report, onCopy, onDownload }: ReportOutputProps) => {
  return (
    <div className="space-y-4 bg-card rounded-xl border border-border p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-lg font-serif font-semibold text-foreground">Vygenerovaný report</h3>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onCopy} className="gap-1.5">
            <Copy className="w-3.5 h-3.5" />
            Zkopírovat
          </Button>
          <Button variant="outline" size="sm" onClick={() => onDownload("txt")} className="gap-1.5">
            <FileText className="w-3.5 h-3.5" />
            .txt
          </Button>
          <Button variant="outline" size="sm" onClick={() => onDownload("md")} className="gap-1.5">
            <FileCode className="w-3.5 h-3.5" />
            .md
          </Button>
          <Button variant="outline" size="sm" onClick={() => onDownload("html")} className="gap-1.5">
            <Globe className="w-3.5 h-3.5" />
            .html
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground text-center">
        Soubor se stáhne pouze do tohoto počítače. Nic se nikam neodesílá.
      </p>

      <div className="prose prose-sm max-w-none text-foreground prose-headings:text-foreground prose-headings:font-serif prose-p:my-2 prose-ul:my-2 prose-li:my-0.5 bg-secondary/30 rounded-lg p-4">
        <ReactMarkdown>{report}</ReactMarkdown>
      </div>
    </div>
  );
};

export default ReportOutput;

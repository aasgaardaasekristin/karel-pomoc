import { Button } from "@/components/ui/button";
import { Copy, Download } from "lucide-react";
import ReactMarkdown from "react-markdown";

interface ReportOutputProps {
  report: string;
  onCopy: () => void;
  onDownload: (format: "txt" | "md") => void;
}

const ReportOutput = ({ report, onCopy, onDownload }: ReportOutputProps) => {
  return (
    <div className="space-y-4 bg-card rounded-xl border border-border p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-serif font-semibold text-foreground">Vygenerovaný report</h3>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onCopy}>
            <Copy className="w-4 h-4 mr-2" />
            Zkopírovat
          </Button>
          <Button variant="outline" size="sm" onClick={() => onDownload("txt")}>
            <Download className="w-4 h-4 mr-2" />
            .txt
          </Button>
          <Button variant="outline" size="sm" onClick={() => onDownload("md")}>
            <Download className="w-4 h-4 mr-2" />
            .md
          </Button>
        </div>
      </div>

      <div className="prose prose-sm max-w-none text-foreground prose-headings:text-foreground prose-headings:font-serif prose-p:my-2 prose-ul:my-2 prose-li:my-0.5 bg-secondary/30 rounded-lg p-4">
        <ReactMarkdown>{report}</ReactMarkdown>
      </div>
    </div>
  );
};

export default ReportOutput;

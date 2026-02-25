import { Button } from "@/components/ui/button";
import { X, Copy, Check, Mail, Loader2 } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import { getAuthHeaders } from "@/lib/auth";

interface Props {
  material: string;
  onClose: () => void;
}

const StudyMaterialPanel = ({ material, onClose }: Props) => {
  const [copied, setCopied] = useState(false);
  const [isSending, setIsSending] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(material);
      setCopied(true);
      toast.success("Zkopírováno do schránky");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Nepodařilo se zkopírovat");
    }
  };

  const handleSendEmail = async () => {
    setIsSending(true);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-email-report`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            reportContent: material,
            partName: "Studijní materiál ze supervize",
            date: new Date().toLocaleDateString("cs-CZ"),
          }),
        }
      );
      if (!response.ok) throw new Error("Chyba při odesílání");
      toast.success("Učební materiál odeslán na email");
    } catch (error) {
      console.error("Email send error:", error);
      toast.error("Nepodařilo se odeslat email");
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 className="text-base font-serif font-semibold text-foreground">📚 Studijní materiál ze supervize</h2>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleSendEmail} disabled={isSending} className="gap-1.5 text-xs">
              {isSending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />}
              {isSending ? "Odesílám..." : "Poslat emailem"}
            </Button>
            <Button variant="outline" size="sm" onClick={handleCopy} className="gap-1.5 text-xs">
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? "Zkopírováno" : "Kopírovat"}
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0">
          <div className="prose prose-sm max-w-none text-foreground
            prose-headings:text-foreground prose-h1:text-lg prose-h2:text-base prose-h3:text-sm
            prose-strong:text-foreground prose-em:text-muted-foreground
            prose-ul:my-2 prose-li:my-0.5
            prose-hr:border-border">
            <ReactMarkdown>{material}</ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
};

export default StudyMaterialPanel;

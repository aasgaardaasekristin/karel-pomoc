import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Copy, Check, Mail, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import { parseTaskSuggestions, TaskSuggestInline } from "@/components/did/TaskSuggestButtons";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ChatMessageProps {
  message: Message;
  onNotebookCopied?: () => void;
  onTaskAdded?: () => void;
}

// Section definitions with labels and target documents
const SECTION_CONFIG: Record<string, { label: string; icon: string; target: string }> = {
  HANDOVER: { label: "Handover", icon: "📋", target: "DID_300_Handover_reporty" },
  KARTA: { label: "Karta části", icon: "📇", target: "Karta části" },
  NOVA_CAST: { label: "Nová část", icon: "⚠️", target: "00_Seznam částí + 01_Hlavní mapa" },
  VZTAHY: { label: "Vztahy", icon: "🔗", target: "02_Vztahy a konflikty" },
  BEZPECNOST: { label: "Bezpečnost", icon: "🛡️", target: "03_Bezpečnostní rámec" },
  ANALYZA: { label: "Analýza", icon: "📊", target: "Odborná analýza" },
  REPORT: { label: "Zápis ze sezení", icon: "📝", target: "Email report" },
};

interface ParsedSection {
  key: string;
  content: string;
}

const parseSections = (content: string): { beforeSections: string; sections: ParsedSection[] } => {
  const sectionRegex = /<!-- SECTION:(\w+) -->([\s\S]*?)<!-- \/SECTION:\1 -->/g;
  const sections: ParsedSection[] = [];
  let match;

  while ((match = sectionRegex.exec(content)) !== null) {
    sections.push({ key: match[1], content: match[2].trim() });
  }

  if (sections.length === 0) {
    return { beforeSections: content, sections: [] };
  }

  // Everything before the first section marker
  const firstIdx = content.indexOf("<!-- SECTION:");
  const beforeSections = firstIdx > 0 ? content.substring(0, firstIdx).trim() : "";

  return { beforeSections, sections };
};

// Strip HTML comments from display text
const cleanForDisplay = (text: string): string => {
  return text.replace(/<!-- \/?SECTION:\w+ -->/g, "").trim();
};

// Strip HTML comments for copying
const cleanForCopy = (text: string): string => {
  return text.replace(/<!-- \/?SECTION:\w+ -->/g, "").trim();
};

const CopyButton = ({ text, label, onCopied }: { text: string; label: string; onCopied?: () => void }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cleanForCopy(text));
    } catch {
      const ta = document.createElement("textarea");
      ta.value = cleanForCopy(text);
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
      onCopied?.();
    }, 1500);
  };

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-border bg-muted/50 hover:bg-muted transition-colors text-foreground"
      title={`Zkopírovat: ${label}`}
    >
      {copied ? (
        <>
          <Check className="w-3.5 h-3.5 text-green-500" />
          Zkopírováno!
        </>
      ) : (
        <>
          <Copy className="w-3.5 h-3.5" />
          📋 {label}
        </>
      )}
    </button>
  );
};

const EmailReportButton = ({ content, partName }: { content: string; partName: string }) => {
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    setSending(true);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-email-report`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            reportContent: cleanForCopy(content),
            partName,
            date: new Date().toLocaleDateString("cs-CZ"),
          }),
        }
      );
      if (!response.ok) throw new Error("Chyba při odesílání");
      toast.success("Zápis odeslán na email");
    } catch (error) {
      toast.error("Nepodařilo se odeslat email");
      console.error(error);
    } finally {
      setSending(false);
    }
  };

  return (
    <button
      onClick={handleSend}
      disabled={sending}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-primary/30 bg-primary/10 hover:bg-primary/20 transition-colors text-foreground"
      title="Odeslat zápis na email"
    >
      {sending ? (
        <>
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Odesílám...
        </>
      ) : (
        <>
          <Mail className="w-3.5 h-3.5" />
          📧 Odeslat na email
        </>
      )}
    </button>
  );
};

// Legacy fallback for non-sectioned messages
const extractNotebookLMSection = (content: string): string | null => {
  const match = content.match(/📌\s*\*?\*?Co (?:uložit|aktualizovat) (?:do|v) NotebookLM.*$/s);
  if (match) return match[0].trim();
  const handoverMatch = content.match(/🔽\s*\*?\*?Tohle je pro mamku.*$/s);
  return handoverMatch ? handoverMatch[0].trim() : null;
};

const ChatMessage = ({ message, onNotebookCopied, onTaskAdded }: ChatMessageProps) => {
  const isUser = message.role === "user";

  if (isUser) {
    // Extract images from multimodal content
    const images: string[] = [];
    let textContent = "";

    if (Array.isArray(message.content)) {
      (message.content as any[]).forEach((part: any) => {
        if (part.type === "image_url" && part.image_url?.url) {
          images.push(part.image_url.url);
        } else if (part.type === "text") {
          textContent = part.text || "";
        }
      });
    } else {
      textContent = message.content as string;
    }

    return (
      <div className="flex justify-end">
        <div className="max-w-[92%] sm:max-w-[85%] md:max-w-[75%] chat-message-user">
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {images.map((src, i) => (
                <img
                  key={i}
                  src={src}
                  alt={`Příloha ${i + 1}`}
                  className="max-w-[200px] max-h-[200px] rounded-md object-cover border border-border/50"
                />
              ))}
            </div>
          )}
          {textContent && <p className="text-foreground whitespace-pre-wrap">{textContent}</p>}
        </div>
      </div>
    );
  }

  // Parse task suggestions from content
  const { cleanContent: contentWithoutTasks, suggestions: taskSuggestions } = parseTaskSuggestions(message.content);

  const { beforeSections, sections } = parseSections(contentWithoutTasks);

  // If no structured sections, use legacy rendering
  if (sections.length === 0) {
    const notebookSection = extractNotebookLMSection(contentWithoutTasks);
    return (
      <div className="flex justify-start">
        <div className="max-w-[92%] sm:max-w-[85%] md:max-w-[75%] chat-message-assistant">
          <div className="prose prose-sm max-w-none text-foreground prose-p:my-2 prose-ul:my-2 prose-li:my-0.5 prose-a:text-primary prose-a:underline prose-a:decoration-primary/50 hover:prose-a:decoration-primary">
            <ReactMarkdown
              components={{
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
                ),
              }}
            >{contentWithoutTasks}</ReactMarkdown>
            {notebookSection && <CopyButton text={notebookSection} label="Kopírovat pro NotebookLM" />}
            <TaskSuggestInline suggestions={taskSuggestions} onTaskAdded={onTaskAdded} />
          </div>
        </div>
      </div>
    );
  }

  // Extract part name from HANDOVER section for email
  const handoverSection = sections.find(s => s.key === "HANDOVER");
  const partNameMatch = handoverSection?.content.match(/S KÝM KAREL MLUVIL:\*?\*?\s*(.+)/);
  const partName = partNameMatch ? partNameMatch[1].trim() : "neznámá část";

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] sm:max-w-[85%] md:max-w-[75%] chat-message-assistant">
        <div className="prose prose-sm max-w-none text-foreground prose-p:my-2 prose-ul:my-2 prose-li:my-0.5 prose-a:text-primary prose-a:underline prose-a:decoration-primary/50 hover:prose-a:decoration-primary">
          {/* Render text before sections (farewell etc.) */}
          {beforeSections && (
            <ReactMarkdown
              components={{
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
                ),
              }}
            >{cleanForDisplay(beforeSections)}</ReactMarkdown>
          )}

          {/* Render each section with its own copy button */}
          {sections.map((section) => {
            const config = SECTION_CONFIG[section.key];
            if (!config) return null;

            return (
              <div key={section.key} className="mt-4 p-3 rounded-lg border border-border/50 bg-muted/20">
                <ReactMarkdown
                  components={{
                    a: ({ href, children }) => (
                      <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
                    ),
                  }}
                >{cleanForDisplay(section.content)}</ReactMarkdown>
                <div className="flex flex-wrap gap-2 mt-2">
                  <CopyButton
                    text={section.content}
                    label={`Kopírovat → ${config.target}`}
                  />
                  {section.key === "REPORT" && (
                    <EmailReportButton content={section.content} partName={partName} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default ChatMessage;

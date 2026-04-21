import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Loader2, ArrowLeft, MessageCircleQuestion, Camera, Mic, StickyNote, Send, Sparkles, X, Square, Pause, Play } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import { useImageUpload } from "@/hooks/useImageUpload";
import { useSessionAudioRecorder } from "@/hooks/useSessionAudioRecorder";

type LiveMessage = { role: "user" | "assistant"; content: string };
type SwitchLogEntry = { from: string; to: string; time: string };

export type InterrogationAnswer = {
  question: string;
  answer: string;
  attachments: { kind: "image" | "audio" | "note"; label: string; data?: string }[];
};

interface Props {
  partName: string;
  therapistName: string;
  contextBrief?: string;
  liveMessages: LiveMessage[];
  switchLog: SwitchLogEntry[];
  audioSegmentCount: number;
  imageSegmentCount: number;
  onCancel: () => void;
  onSubmit: (qa: InterrogationAnswer[], extraNote: string) => void;
  isSubmitting: boolean;
}

const formatDuration = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;

/**
 * Post-Session Interrogation Room (Pass v1)
 * ------------------------------------------
 * Mezikrok mezi LIVE sezením a finální Karlovou analýzou.
 * Karel klade cílené otázky k průběhu sezení (vygenerované AI z přepisu),
 * terapeut na ně odpovídá a může doplnit obrázek / audio / poznámku.
 * Teprve `Odeslat k finální analýze` přechází do plné analýzy.
 */
const DidPostSessionInterrogation = ({
  partName,
  therapistName,
  contextBrief,
  liveMessages,
  switchLog,
  audioSegmentCount,
  imageSegmentCount,
  onCancel,
  onSubmit,
  isSubmitting,
}: Props) => {
  const [questions, setQuestions] = useState<string[]>([]);
  const [isLoadingQuestions, setIsLoadingQuestions] = useState(true);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [extraNote, setExtraNote] = useState("");
  const [activeQ, setActiveQ] = useState<number | null>(null);
  const [perQuestionAttachments, setPerQuestionAttachments] = useState<Record<number, InterrogationAnswer["attachments"]>>({});

  const imageUpload = useImageUpload();
  const recorder = useSessionAudioRecorder();
  const [isAttachingAudio, setIsAttachingAudio] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const requestedRef = useRef(false);

  const transcript = useMemo(() => liveMessages
    .map(m => `${m.role === "user" ? "TERAPEUT" : "KAREL"}: ${m.content}`)
    .join("\n\n"), [liveMessages]);

  // Generate Karel's targeted questions on mount
  useEffect(() => {
    if (requestedRef.current) return;
    requestedRef.current = true;
    (async () => {
      try {
        const headers = await getAuthHeaders();
        const prompt = `Sezení s DID částí "${partName}" (vedla ${therapistName}) právě skončilo.

PŘEPIS:
${transcript.slice(0, 6000)}

${switchLog.length > 0 ? `SWITCHE BĚHEM SEZENÍ:\n${switchLog.map(s => `- ${s.time}: ${s.from} → ${s.to}`).join("\n")}` : ""}

${contextBrief ? `\nSCHVÁLENÝ PLÁN SEZENÍ (z přípravy):\n${contextBrief.slice(0, 2000)}` : ""}

ÚKOL: Než vytvoříš finální klinickou analýzu, polož ${therapistName} **5 cílených odborných otázek** k průběhu sezení.
Otázky musí být:
- konkrétní (ne "jaké to bylo"), navázané na body plánu nebo zachycené momenty z přepisu
- klinicky relevantní pro analýzu (reakce části, neverbální signály, switching, regrese, kontratranference)
- formulované česky, krátce, jako jednou větou

VÝSTUP: Pouze 5 otázek, každá na samostatném řádku, bez číslování ani odrážek. Žádný úvod ani závěr.`;

        const resp = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-chat`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              messages: [{ role: "user", content: prompt }],
              mode: "supervision",
            }),
          }
        );
        if (!resp.ok || !resp.body) throw new Error("Chyba");
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let raw = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n")) !== -1) {
            let line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            if (!line.startsWith("data: ")) continue;
            const json = line.slice(6).trim();
            if (json === "[DONE]") break;
            try {
              const parsed = JSON.parse(json);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) raw += content;
            } catch { break; }
          }
        }
        const parsed = raw
          .split("\n")
          .map(l => l.replace(/^[\s\-•*\d.]+/, "").trim())
          .filter(l => l.length > 8 && l.endsWith("?"));
        const final = parsed.slice(0, 5);
        if (final.length === 0) {
          // Fallback robust questions
          setQuestions([
            `Jak ${partName} reagovala na klíčový bod plánu — co konkrétně se ukázalo jako nečekané?`,
            `Byly v sezení neverbální signály (tělo, pohled, ticho), které jsi zachytila a které v přepisu nejsou?`,
            switchLog.length > 0
              ? `Co podle tebe spustilo ${switchLog.length === 1 ? "switch" : `${switchLog.length} switche`}? Bylo to bezpečné, nebo regresivní?`
              : `Měla jsi pocit, že byla blízko switche, i když k němu nedošlo? Co tě k tomu vedlo?`,
            `Co tě v tom sezení emočně zasáhlo nebo rozhodilo (kontratranference)?`,
            `Co bys teď, s odstupem, považovala za nejdůležitější moment celého sezení?`,
          ]);
        } else {
          setQuestions(final);
        }
      } catch (err) {
        console.error("Failed to generate interrogation questions:", err);
        setQuestions([
          `Co bylo nejdůležitějším momentem sezení s ${partName}?`,
          `Která tvoje intervence v sezení skutečně zasáhla — a podle čeho to víš?`,
          `Které tvoje slovo nebo otázka naopak nezafungovala a proč?`,
          `Byly v sezení neverbální signály, které v přepisu chybí (tělo, výraz, ticho)?`,
          `Co tě v sezení emočně zasáhlo nebo rozhodilo?`,
        ]);
        toast.error("Karel nemohl vygenerovat otázky — používám záložní sadu.");
      } finally {
        setIsLoadingQuestions(false);
      }
    })();
  }, [partName, therapistName, transcript, switchLog, contextBrief]);

  const setAnswer = (i: number, value: string) =>
    setAnswers(prev => ({ ...prev, [i]: value }));

  const attachImagesToActive = () => {
    if (activeQ == null) return;
    const imgs = imageUpload.pendingImages;
    if (imgs.length === 0) return;
    setPerQuestionAttachments(prev => ({
      ...prev,
      [activeQ]: [
        ...(prev[activeQ] || []),
        ...imgs.map(img => ({ kind: "image" as const, label: img.name, data: img.dataUrl })),
      ],
    }));
    imageUpload.clearImages();
    toast.success(`Přidáno ${imgs.length} obrázků k otázce`);
  };

  const attachAudioToActive = async () => {
    if (activeQ == null) return;
    setIsAttachingAudio(true);
    try {
      const base64 = await recorder.getBase64();
      if (!base64) throw new Error("Žádná nahrávka");
      const dur = formatDuration(recorder.duration);
      setPerQuestionAttachments(prev => ({
        ...prev,
        [activeQ]: [
          ...(prev[activeQ] || []),
          { kind: "audio", label: `Audio doplnění (${dur})`, data: base64 },
        ],
      }));
      recorder.reset();
      toast.success("Audio připojeno k otázce");
    } catch (e) {
      console.error(e);
      toast.error("Nepodařilo se připojit audio");
    } finally {
      setIsAttachingAudio(false);
    }
  };

  const removeAttachment = (qIdx: number, aIdx: number) =>
    setPerQuestionAttachments(prev => ({
      ...prev,
      [qIdx]: (prev[qIdx] || []).filter((_, i) => i !== aIdx),
    }));

  const answeredCount = questions.filter((_, i) => (answers[i] || "").trim().length > 0).length;
  const canSubmit = !isSubmitting && !isLoadingQuestions && answeredCount > 0;

  const handleSubmit = () => {
    const qa: InterrogationAnswer[] = questions.map((q, i) => ({
      question: q,
      answer: (answers[i] || "").trim(),
      attachments: perQuestionAttachments[i] || [],
    }));
    onSubmit(qa, extraNote.trim());
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-card/50">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Button variant="ghost" size="icon" onClick={onCancel} className="h-8 w-8 shrink-0" disabled={isSubmitting}>
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <MessageCircleQuestion className="w-4 h-4 text-primary" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-semibold text-foreground">Doptávání po sezení</h3>
                <Badge variant="outline" className="text-[9px] h-4 border-primary/30 text-primary">
                  před finální analýzou
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground truncate">
                Část: <span className="font-medium text-foreground">{partName}</span>
                {" · vedla "}<span className="font-medium text-foreground">{therapistName}</span>
              </p>
            </div>
          </div>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="gap-1.5 text-xs h-9"
          >
            {isSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">Odeslat k finální analýze</span>
            <span className="sm:hidden">Odeslat</span>
          </Button>
        </div>

        {/* Session summary strip */}
        <div className="mt-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
          <span>✓ Sezení ukončeno</span>
          <span>📝 Záznamů v toku: <span className="font-medium text-foreground">{liveMessages.length}</span></span>
          {audioSegmentCount > 0 && <span>🎙️ Audio segmenty: <span className="font-medium text-foreground">{audioSegmentCount}</span></span>}
          {imageSegmentCount > 0 && <span>📷 Obrázky: <span className="font-medium text-foreground">{imageSegmentCount}</span></span>}
          {switchLog.length > 0 && <span>⚡ Switche: <span className="font-medium text-foreground">{switchLog.length}×</span></span>}
          <span className="ml-auto italic">probíhá doplnění podkladů pro analýzu</span>
        </div>

        {/* Hidden file input for image attachments */}
        <input
          ref={imageUpload.fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          multiple
          onChange={imageUpload.handleFileChange}
          className="hidden"
        />
      </div>

      {/* Body */}
      <ScrollArea className="flex-1 px-2 sm:px-4" ref={scrollRef}>
        <div className="max-w-3xl mx-auto py-4 space-y-4">
          {isLoadingQuestions && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" />
              Karel formuluje cílené otázky k sezení…
            </div>
          )}

          {!isLoadingQuestions && questions.map((q, i) => {
            const att = perQuestionAttachments[i] || [];
            const isActive = activeQ === i;
            const hasAnswer = (answers[i] || "").trim().length > 0;
            return (
              <div
                key={i}
                className={`rounded-lg border ${isActive ? "border-primary/40 bg-primary/5" : "border-border bg-card"} p-3 sm:p-4 space-y-3 transition-colors`}
                onFocus={() => setActiveQ(i)}
                onClick={() => setActiveQ(i)}
              >
                <div className="flex items-start gap-2">
                  <div className="w-6 h-6 rounded-full bg-primary/15 text-primary text-xs font-semibold flex items-center justify-center shrink-0 mt-0.5">
                    {i + 1}
                  </div>
                  <p className="text-sm font-medium text-foreground leading-relaxed">{q}</p>
                  {hasAnswer && (
                    <Badge variant="outline" className="text-[9px] h-4 border-primary/30 text-primary shrink-0">
                      odpovězeno
                    </Badge>
                  )}
                </div>

                <Textarea
                  value={answers[i] || ""}
                  onChange={e => setAnswer(i, e.target.value)}
                  onFocus={() => setActiveQ(i)}
                  placeholder={`Odpověz Karlovi…`}
                  className="min-h-[4.5rem] text-sm"
                  disabled={isSubmitting}
                />

                {/* Attachment list */}
                {att.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {att.map((a, ai) => (
                      <Badge
                        key={ai}
                        variant="outline"
                        className="text-[10px] gap-1 pr-1 border-primary/25 bg-background"
                      >
                        {a.kind === "image" ? "📷" : a.kind === "audio" ? "🎙️" : "📝"} {a.label}
                        <button
                          onClick={(e) => { e.stopPropagation(); removeAttachment(i, ai); }}
                          className="rounded-full hover:bg-muted p-0.5"
                          disabled={isSubmitting}
                        >
                          <X className="w-2.5 h-2.5" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}

                {/* Per-question tools (only on active card) */}
                {isActive && (
                  <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-border/40">
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wider mr-1">Doplnit:</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => imageUpload.openFilePicker()}
                      disabled={isSubmitting}
                      className="gap-1 h-7 text-xs"
                    >
                      <Camera className="w-3 h-3" /> Obrázek
                    </Button>
                    {recorder.state === "idle" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={recorder.startRecording}
                        disabled={isSubmitting}
                        className="gap-1 h-7 text-xs"
                      >
                        <Mic className="w-3 h-3" /> Audio
                      </Button>
                    )}
                    {recorder.state === "recording" && (
                      <div className="flex items-center gap-1.5 bg-destructive/5 rounded-md px-2 py-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-destructive animate-pulse" />
                        <span className="text-[10px] tabular-nums text-destructive">{formatDuration(recorder.duration)}</span>
                        <Button variant="ghost" size="sm" onClick={recorder.pauseRecording} className="h-6 w-6 p-0">
                          <Pause className="w-3 h-3" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={recorder.stopRecording} className="h-6 w-6 p-0">
                          <Square className="w-2.5 h-2.5" />
                        </Button>
                      </div>
                    )}
                    {recorder.state === "paused" && (
                      <div className="flex items-center gap-1.5 bg-muted rounded-md px-2 py-1">
                        <span className="text-[10px] text-muted-foreground">⏸ {formatDuration(recorder.duration)}</span>
                        <Button variant="ghost" size="sm" onClick={recorder.resumeRecording} className="h-6 w-6 p-0">
                          <Play className="w-3 h-3" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={recorder.stopRecording} className="h-6 w-6 p-0">
                          <Square className="w-2.5 h-2.5" />
                        </Button>
                      </div>
                    )}
                    {recorder.state === "recorded" && (
                      <div className="flex items-center gap-1.5">
                        {recorder.audioUrl && <audio src={recorder.audioUrl} controls className="h-7 max-w-[10rem]" />}
                        <Button size="sm" onClick={attachAudioToActive} disabled={isAttachingAudio} className="h-7 text-xs gap-1">
                          {isAttachingAudio ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                          Připojit
                        </Button>
                        <Button variant="ghost" size="sm" onClick={recorder.discardRecording} className="h-7 text-xs">
                          Zahodit
                        </Button>
                      </div>
                    )}

                    {/* Pending images preview */}
                    {imageUpload.pendingImages.length > 0 && (
                      <>
                        {imageUpload.pendingImages.map((img, ii) => (
                          <img
                            key={ii}
                            src={img.dataUrl}
                            alt={img.name}
                            className="h-8 w-8 object-cover rounded border border-border"
                          />
                        ))}
                        <Button size="sm" onClick={attachImagesToActive} className="h-7 text-xs gap-1">
                          <Send className="w-3 h-3" /> Připojit obrázky
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Free-form extra note */}
          {!isLoadingQuestions && (
            <div className="rounded-lg border border-border bg-card p-3 sm:p-4 space-y-2">
              <div className="flex items-center gap-2">
                <StickyNote className="w-4 h-4 text-muted-foreground" />
                <p className="text-sm font-medium text-foreground">Vlastní postřeh nad rámec otázek</p>
                <Badge variant="outline" className="text-[9px] h-4">nepovinné</Badge>
              </div>
              <Textarea
                value={extraNote}
                onChange={e => setExtraNote(e.target.value)}
                placeholder="Cokoliv dalšího, co by mělo jít do finální analýzy…"
                className="min-h-[4rem] text-sm"
                disabled={isSubmitting}
              />
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Footer */}
      <div className="border-t border-border bg-card/50 backdrop-blur-sm px-3 sm:px-4 py-3">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Progress value={questions.length === 0 ? 0 : (answeredCount / questions.length) * 100} className="h-1.5 w-32" />
            <span>{answeredCount} / {questions.length} odpovězeno</span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={isSubmitting} className="h-9 text-xs">
              Zpět do sezení
            </Button>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="gap-1.5 h-9 text-xs"
            >
              {isSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              Odeslat k finální analýze
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DidPostSessionInterrogation;

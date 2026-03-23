import { useState, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { X, Loader2, FileCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";

const AUDIO_ACCEPT = ".mp3,.mp4,.m4a,.wav,.ogg,.webm,.aac";
const IMAGE_ACCEPT = ".jpg,.jpeg,.png,.heic,.webp";
const HANDWRITING_ACCEPT = ".jpg,.jpeg,.png,.pdf";

const MAX_AUDIO_SIZE = 100 * 1024 * 1024;
const MAX_IMAGE_COUNT = 10;
const MAX_HANDWRITING_COUNT = 5;

interface MediaItem {
  id: string;
  file: File;
  type: "audio" | "image" | "handwriting";
  preview?: string;
  uploading: boolean;
  analyzing: boolean;
  storagePath?: string;
  analysis?: string;
  error?: string;
}

interface SessionMediaUploadProps {
  clientId: string;
  sessionDate: string;
  onMediaContext: (context: string) => void;
}

export interface SessionMediaUploadHandle {
  triggerAudio: () => void;
  triggerImage: () => void;
  triggerHandwriting: () => void;
}

const SessionMediaUpload = forwardRef<SessionMediaUploadHandle, SessionMediaUploadProps>(
  ({ clientId, sessionDate, onMediaContext }, ref) => {
    const [items, setItems] = useState<MediaItem[]>([]);
    const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
    const audioRef = useRef<HTMLInputElement>(null);
    const imageRef = useRef<HTMLInputElement>(null);
    const handwritingRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(ref, () => ({
      triggerAudio: () => audioRef.current?.click(),
      triggerImage: () => imageRef.current?.click(),
      triggerHandwriting: () => handwritingRef.current?.click(),
    }));

    const updateItem = useCallback((id: string, patch: Partial<MediaItem>) => {
      setItems(prev => prev.map(it => it.id === id ? { ...it, ...patch } : it));
    }, []);

    const uploadToStorage = useCallback(async (file: File, type: string, index: number): Promise<string> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Nepřihlášen");
      const ext = file.name.split(".").pop() || "bin";
      const ts = Date.now();
      const path = `${clientId}/${sessionDate}/${type}_${index}_${ts}.${ext}`;
      const { error } = await supabase.storage.from("session-media").upload(path, file, { contentType: file.type });
      if (error) throw error;
      return path;
    }, [clientId, sessionDate]);

    const analyzeImage = useCallback(async (file: File, userPrompt: string): Promise<string> => {
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
      const headers = await getAuthHeaders();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-analyze-file`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          attachments: [{ dataUrl: base64, category: "image", name: file.name, type: file.type, size: file.size }],
          mode: "supervision",
          userPrompt,
        }),
      });
      if (!res.ok) throw new Error(`Chyba analýzy: ${res.status}`);
      const data = await res.json();
      return data.analysis || "Bez výsledku";
    }, []);

    const analyzeAudio = useCallback(async (file: File): Promise<string> => {
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result.split(",")[1] || result);
        };
        reader.readAsDataURL(file);
      });
      const headers = await getAuthHeaders();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-session-intake`, {
        method: "POST",
        headers,
        body: JSON.stringify({ clientId, inputType: "audio", audioBase64: base64, sessionDate }),
      });
      if (!res.ok) throw new Error(`Chyba přepisu: ${res.status}`);
      const data = await res.json();
      const parts: string[] = [];
      if (data.transcription) parts.push(`**Přepis:** ${data.transcription}`);
      if (data.sessionRecord?.summary) parts.push(`**Analýza:** ${data.sessionRecord.summary}`);
      return parts.join("\n\n") || "Přepis dokončen";
    }, [clientId, sessionDate]);

    const processItem = useCallback(async (item: MediaItem, index: number) => {
      updateItem(item.id, { uploading: true });
      try {
        const storagePath = await uploadToStorage(item.file, item.type, index);
        updateItem(item.id, { uploading: false, analyzing: true, storagePath });

        let analysis: string;
        if (item.type === "audio") {
          analysis = await analyzeAudio(item.file);
        } else if (item.type === "handwriting") {
          analysis = await analyzeImage(item.file,
            `Analyzuj tento dokument ve dvou vrstvách:\n\nVRSTVA 1 – ANALÝZA OBSAHU:\nCo klient napsal nebo nakreslil? Identifikuj témata, klíčová slova, emoce.\n\nVRSTVA 2 – GRAFOLOGICKÁ ANALÝZA:\nProveď grafologickou analýzu rukopisu. Analyzuj:\n- Tlak pera (silný/slabý/variabilní)\n- Sklon písma (doprava/doleva/kolmý)\n- Velikost písma (velké/malé/variabilní)\n- Mezery mezi slovy a řádky\n- Tvar písmen (zaoblený/hranatý/smíšený)\n- Spojitost (spojené/nespojené tahy)\n- Pravidelnost (pravidelné/nepravidelné)\n\nInterpretuj co to říká o osobnosti, emočním stavu a psychologických charakteristikách autora.\nUveď: co je jisté vs. co je hypotéza.\nFormuluj jako terapeuticky relevantní pozorování.`
          );
        } else {
          analysis = await analyzeImage(item.file,
            "Analyzuj tento obrázek ze sezení. Popiš co vidíš a identifikuj terapeuticky relevantní pozorování — emoce, téma, symbolika."
          );
        }

        updateItem(item.id, { analyzing: false, analysis });

        // Auto-aggregate and push media context
        setItems(prev => {
          const updated = prev.map(it => it.id === item.id ? { ...it, analysis } : it);
          const completed = updated.filter(i => i.analysis && !i.error);
          if (completed.length > 0) {
            const sections = completed.map(ci => {
              const label = ci.type === "audio" ? "🎙 Audio nahrávka" :
                            ci.type === "handwriting" ? "✍️ Grafologická analýza" : "🖼 Vizuální záznam";
              return `### ${label}: ${ci.file.name}\n${ci.analysis}`;
            });
            onMediaContext(sections.join("\n\n---\n\n"));
          }
          return updated;
        });

        await supabase.from("session_media" as any).insert({
          client_id: clientId,
          session_date: sessionDate,
          media_type: item.type,
          storage_path: storagePath,
          original_filename: item.file.name,
          ai_analysis: { text: analysis },
        });
      } catch (err: any) {
        console.error("Media process error:", err);
        updateItem(item.id, { uploading: false, analyzing: false, error: err.message });
        toast.error(`Chyba: ${item.file.name}`);
      }
    }, [uploadToStorage, analyzeAudio, analyzeImage, updateItem, clientId, sessionDate]);

    const handleFiles = useCallback((files: FileList | null, type: "audio" | "image" | "handwriting") => {
      if (!files) return;
      const arr = Array.from(files);
      const existing = items.filter(i => i.type === type).length;

      if (type === "audio" && arr.length > 1) { toast.error("Lze nahrát pouze jeden audio soubor"); return; }
      if (type === "audio" && arr[0]?.size > MAX_AUDIO_SIZE) { toast.error("Audio soubor je příliš velký (max 100 MB)"); return; }
      if (type === "image" && existing + arr.length > MAX_IMAGE_COUNT) { toast.error(`Max ${MAX_IMAGE_COUNT} obrázků`); return; }
      if (type === "handwriting" && existing + arr.length > MAX_HANDWRITING_COUNT) { toast.error(`Max ${MAX_HANDWRITING_COUNT} souborů rukopisu`); return; }

      const newItems: MediaItem[] = arr.map((file, i) => {
        const id = `${type}-${Date.now()}-${i}`;
        const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
        return { id, file, type, preview, uploading: false, analyzing: false };
      });

      setItems(prev => [...prev, ...newItems]);
      newItems.forEach((item, i) => processItem(item, existing + i));
    }, [items, processItem]);

    const removeItem = useCallback(async (id: string) => {
      const item = items.find(i => i.id === id);
      if (item?.storagePath) {
        await supabase.storage.from("session-media").remove([item.storagePath]);
      }
      if (item?.preview) URL.revokeObjectURL(item.preview);
      setItems(prev => prev.filter(i => i.id !== id));
    }, [items]);

    const toggleExpanded = useCallback((id: string) => {
      setExpandedItems(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
    }, []);

    // Hidden file inputs
    const hiddenInputs = (
      <>
        <input ref={audioRef} type="file" accept={AUDIO_ACCEPT} className="hidden"
          onChange={(e) => { handleFiles(e.target.files, "audio"); if (audioRef.current) audioRef.current.value = ""; }} />
        <input ref={imageRef} type="file" accept={IMAGE_ACCEPT} multiple className="hidden"
          onChange={(e) => { handleFiles(e.target.files, "image"); if (imageRef.current) imageRef.current.value = ""; }} />
        <input ref={handwritingRef} type="file" accept={HANDWRITING_ACCEPT} multiple className="hidden"
          onChange={(e) => { handleFiles(e.target.files, "handwriting"); if (handwritingRef.current) handwritingRef.current.value = ""; }} />
      </>
    );

    if (items.length === 0) return <>{hiddenInputs}</>;

    return (
      <>
        {hiddenInputs}
        <div className="space-y-2">
          {items.map(item => (
            <div key={item.id} className="bg-muted/30 rounded-lg p-2">
              <div className="flex items-center gap-2 mb-1">
                {item.preview && (
                  <img src={item.preview} alt="" className="w-10 h-10 object-cover rounded" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs truncate">{item.file.name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {(item.file.size / 1024 / 1024).toFixed(1)} MB
                  </p>
                </div>
                {item.uploading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
                {item.analyzing && <Badge variant="secondary" className="text-[10px]">Analyzuji…</Badge>}
                {item.analysis && <FileCheck className="w-3.5 h-3.5 text-primary" />}
                {item.error && <Badge variant="destructive" className="text-[10px]">Chyba</Badge>}
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => removeItem(item.id)}>
                  <X className="w-3 h-3" />
                </Button>
              </div>
              {(item.uploading || item.analyzing) && <Progress value={item.uploading ? 40 : 80} className="h-1" />}
              {item.analysis && (
                <div className="mt-2">
                  <div className="text-xs prose prose-sm max-w-none dark:prose-invert">
                    <ReactMarkdown>
                      {expandedItems.has(item.id) ? item.analysis : (item.analysis.length > 500 ? item.analysis.slice(0, 500) + "…" : item.analysis)}
                    </ReactMarkdown>
                  </div>
                  {item.analysis.length > 500 && (
                    <Button variant="ghost" size="sm" className="h-6 text-[10px] mt-1 text-muted-foreground" onClick={() => toggleExpanded(item.id)}>
                      {expandedItems.has(item.id) ? "Skrýt" : "Zobrazit celou analýzu"}
                    </Button>
                  )}
                </div>
              )}
              {item.error && <p className="text-xs text-destructive mt-1">{item.error}</p>}
            </div>
          ))}
        </div>
      </>
    );
  }
);

SessionMediaUpload.displayName = "SessionMediaUpload";

export default SessionMediaUpload;

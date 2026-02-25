import { useState, useRef, useCallback } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

const MAX_BASE64_SIZE = 4 * 1024 * 1024; // 4MB for inline base64
const MAX_STORAGE_SIZE = 50 * 1024 * 1024; // 50MB for storage

const ACCEPTED_TYPES = [
  // Images
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml",
  // Audio
  "audio/webm", "audio/mpeg", "audio/mp3", "audio/wav", "audio/ogg", "audio/mp4", "audio/x-m4a",
  // Video
  "video/mp4", "video/webm", "video/quicktime",
  // Documents
  "application/pdf",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain", "text/csv", "text/markdown",
  "application/json", "application/xml",
];

export type FileCategory = "image" | "audio" | "video" | "document" | "screenshot";

export interface PendingAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  category: FileCategory;
  /** For small files / images: base64 data URL */
  dataUrl?: string;
  /** For large files uploaded to Storage */
  storagePath?: string;
  /** For Google Drive files */
  driveFileId?: string;
  /** Uploading state */
  uploading?: boolean;
}

function categorizeFile(mimeType: string): FileCategory {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const useUniversalUpload = () => {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const addAttachment = useCallback((attachment: PendingAttachment) => {
    setAttachments(prev => [...prev, attachment]);
  }, []);

  const processFile = useCallback(async (file: File, category?: FileCategory) => {
    if (!ACCEPTED_TYPES.includes(file.type) && !file.type) {
      toast.error(`Nepodporovaný formát: ${file.name}`);
      return;
    }
    if (file.size > MAX_STORAGE_SIZE) {
      toast.error(`Soubor ${file.name} je příliš velký (max 50 MB).`);
      return;
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cat = category || categorizeFile(file.type);

    // Small images → base64 inline
    if (cat === "image" && file.size <= MAX_BASE64_SIZE) {
      const reader = new FileReader();
      reader.onload = () => {
        setAttachments(prev => [...prev, {
          id,
          name: file.name,
          type: file.type,
          size: file.size,
          category: cat,
          dataUrl: reader.result as string,
        }]);
      };
      reader.readAsDataURL(file);
      return;
    }

    // Large files → upload to Storage
    setAttachments(prev => [...prev, {
      id,
      name: file.name,
      type: file.type,
      size: file.size,
      category: cat,
      uploading: true,
    }]);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Nepřihlášen");

      const ext = file.name.split(".").pop() || "bin";
      const storagePath = `${user.id}/${id}.${ext}`;

      const { error } = await supabase.storage
        .from("chat-attachments")
        .upload(storagePath, file, { contentType: file.type });

      if (error) throw error;

      setAttachments(prev => prev.map(a =>
        a.id === id ? { ...a, uploading: false, storagePath } : a
      ));
      toast.success(`Nahráno: ${file.name} (${humanSize(file.size)})`);
    } catch (err) {
      console.error("Upload error:", err);
      toast.error(`Chyba při nahrávání: ${file.name}`);
      setAttachments(prev => prev.filter(a => a.id !== id));
    }
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    files.forEach(f => processFile(f));
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [processFile]);

  const captureScreenshot = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "monitor" } as any,
      });
      const track = stream.getVideoTracks()[0];
      const imageCapture = new (window as any).ImageCapture(track);
      const bitmap = await imageCapture.grabFrame();
      track.stop();

      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);

      const dataUrl = canvas.toDataURL("image/png");
      const id = `screenshot-${Date.now()}`;
      setAttachments(prev => [...prev, {
        id,
        name: `screenshot_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.png`,
        type: "image/png",
        size: Math.round(dataUrl.length * 0.75),
        category: "screenshot",
        dataUrl,
      }]);
      toast.success("Screenshot pořízen");
    } catch (err: any) {
      if (err.name !== "AbortError") {
        console.error("Screenshot error:", err);
        toast.error("Nepodařilo se pořídit screenshot");
      }
    }
  }, []);

  const removeAttachment = useCallback(async (id: string) => {
    const att = attachments.find(a => a.id === id);
    if (att?.storagePath) {
      await supabase.storage.from("chat-attachments").remove([att.storagePath]);
    }
    setAttachments(prev => prev.filter(a => a.id !== id));
  }, [attachments]);

  const clearAttachments = useCallback(() => {
    setAttachments([]);
  }, []);

  return {
    attachments,
    fileInputRef,
    openFilePicker,
    handleFileChange,
    captureScreenshot,
    removeAttachment,
    clearAttachments,
    addAttachment,
    processFile,
  };
};

/** Build multimodal content for AI - includes images inline, references storage files */
export const buildAttachmentContent = (
  text: string,
  attachments: PendingAttachment[]
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> => {
  if (attachments.length === 0) return text;

  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

  // Add images inline as base64
  attachments.forEach(att => {
    if (att.dataUrl && (att.category === "image" || att.category === "screenshot")) {
      parts.push({ type: "image_url", image_url: { url: att.dataUrl } });
    }
  });

  // Build text description for non-image attachments
  const nonImageAtts = attachments.filter(a => !a.dataUrl || (a.category !== "image" && a.category !== "screenshot"));
  let fullText = text;
  if (nonImageAtts.length > 0) {
    const fileList = nonImageAtts.map(a => `📎 ${a.name} (${a.type}, ${humanSize(a.size)})${a.storagePath ? ` [storage:${a.storagePath}]` : ""}${a.driveFileId ? ` [drive:${a.driveFileId}]` : ""}`).join("\n");
    fullText = `${fileList}\n\n${text}`;
  }

  if (fullText.trim()) {
    parts.push({ type: "text", text: fullText });
  }

  return parts.length === 1 && parts[0].type === "text" ? fullText : parts;
};

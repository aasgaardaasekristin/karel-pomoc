import { useState, useRef, useCallback } from "react";
import { toast } from "sonner";

const MAX_FILE_SIZE = 4 * 1024 * 1024; // 4MB (base64 inflates ~33%)
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export interface PendingImage {
  dataUrl: string;
  name: string;
}

export const useImageUpload = () => {
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    files.forEach((file) => {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        toast.error(`Nepodporovaný formát: ${file.name}. Použij JPG, PNG, WebP nebo GIF.`);
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        toast.error(`Soubor ${file.name} je příliš velký (max 4 MB).`);
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setPendingImages((prev) => [...prev, { dataUrl, name: file.name }]);
      };
      reader.readAsDataURL(file);
    });

    // Reset input so same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const removeImage = useCallback((index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearImages = useCallback(() => {
    setPendingImages([]);
  }, []);

  return {
    pendingImages,
    fileInputRef,
    openFilePicker,
    handleFileChange,
    removeImage,
    clearImages,
  };
};

/** Build OpenAI-compatible multimodal content array */
export const buildMultimodalContent = (
  text: string,
  images: PendingImage[]
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> => {
  if (images.length === 0) return text;

  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

  images.forEach((img) => {
    parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
  });

  if (text.trim()) {
    parts.push({ type: "text", text });
  }

  return parts;
};

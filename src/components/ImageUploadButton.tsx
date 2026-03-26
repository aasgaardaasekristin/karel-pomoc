import { ImagePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PendingImage } from "@/hooks/useImageUpload";

interface ImageUploadButtonProps {
  onOpenPicker: () => void;
  pendingImages: PendingImage[];
  onRemoveImage: (index: number) => void;
  disabled?: boolean;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

const ImageUploadButton = ({
  onOpenPicker,
  pendingImages,
  onRemoveImage,
  disabled,
  fileInputRef,
  onFileChange,
}: ImageUploadButtonProps) => {
  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        multiple
        className="hidden"
        onChange={onFileChange}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onOpenPicker}
        disabled={disabled}
        className="h-[2.5rem] w-[2.5rem] sm:h-[2.75rem] sm:w-[2.75rem] shrink-0"
        title="Přiložit obrázek"
      >
        <ImagePlus className="w-4 h-4 sm:w-5 sm:h-5" />
      </Button>
      {pendingImages.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 p-2 flex gap-2 flex-wrap bg-card/80 backdrop-blur-sm rounded-t-lg border border-b-0 border-border">
          {pendingImages.map((img, i) => (
            <div key={i} className="relative group w-16 h-16">
              <img
                src={img.dataUrl}
                alt={img.name}
                className="w-16 h-16 object-cover rounded-md border border-border"
              />
              <button
                type="button"
                onClick={() => onRemoveImage(i)}
                className="absolute -top-1.5 -right-1.5 bg-destructive text-destructive-foreground rounded-full w-5 h-5 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
};

export default ImageUploadButton;

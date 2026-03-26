import { Paperclip, Camera, HardDrive, Sparkles, X, FileText, Music, Video, Image as ImageIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import type { PendingAttachment, FileCategory } from "@/hooks/useUniversalUpload";
import { useState } from "react";

interface Props {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
  onOpenFilePicker: () => void;
  onCaptureScreenshot: () => void;
  onOpenDrivePicker: () => void;
  onAutoAnalyze: () => void;
  disabled?: boolean;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  isAnalyzing?: boolean;
}

const categoryIcon: Record<FileCategory, React.ReactNode> = {
  image: <ImageIcon className="w-4 h-4" />,
  audio: <Music className="w-4 h-4" />,
  video: <Video className="w-4 h-4" />,
  document: <FileText className="w-4 h-4" />,
  screenshot: <Camera className="w-4 h-4" />,
};

const categoryLabel: Record<FileCategory, string> = {
  image: "Obrázek",
  audio: "Audio",
  video: "Video",
  document: "Dokument",
  screenshot: "Screenshot",
};

const humanSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const UniversalAttachmentBar = ({
  attachments,
  onRemove,
  onOpenFilePicker,
  onCaptureScreenshot,
  onOpenDrivePicker,
  onAutoAnalyze,
  disabled,
  fileInputRef,
  onFileChange,
  isAnalyzing,
}: Props) => {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.md,.json,.xml"
        multiple
        className="hidden"
        onChange={onFileChange}
      />

      {/* Attachment menu */}
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            className="h-[2.5rem] w-[2.5rem] sm:h-[2.75rem] sm:w-[2.75rem] shrink-0"
            title="Připojit soubor"
          >
            <Paperclip className="w-4 h-4 sm:w-5 sm:h-5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-52 p-2" side="top" align="start">
          <div className="flex flex-col gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="justify-start gap-2 h-9"
              onClick={() => { onOpenFilePicker(); setMenuOpen(false); }}
            >
              <Paperclip className="w-4 h-4" />
              Nahrát soubor
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="justify-start gap-2 h-9"
              onClick={() => { onCaptureScreenshot(); setMenuOpen(false); }}
            >
              <Camera className="w-4 h-4" />
              Screenshot obrazovky
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="justify-start gap-2 h-9"
              onClick={() => { onOpenDrivePicker(); setMenuOpen(false); }}
            >
              <HardDrive className="w-4 h-4" />
              Google Drive
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {/* Auto-analyze button - visible when there are attachments */}
      {attachments.length > 0 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onAutoAnalyze}
          disabled={disabled || isAnalyzing || attachments.some(a => a.uploading)}
          className="h-[2.5rem] sm:h-[2.75rem] shrink-0 gap-1.5 px-3"
          title="Karel automaticky analyzuje přiložené soubory"
        >
          {isAnalyzing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Sparkles className="w-4 h-4" />
          )}
          <span className="hidden sm:inline">Analyzuj</span>
        </Button>
      )}

      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 p-2 flex gap-2 flex-wrap bg-card/90 backdrop-blur-sm rounded-t-lg border border-b-0 border-border max-h-32 overflow-y-auto">
          {attachments.map(att => (
            <div key={att.id} className="relative group flex items-center gap-1.5 bg-muted/60 rounded-md px-2 py-1.5 text-xs max-w-[12.5rem]">
              {att.uploading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground shrink-0" />
              ) : att.dataUrl && (att.category === "image" || att.category === "screenshot") ? (
                <img src={att.dataUrl} alt={att.name} className="w-10 h-10 object-cover rounded shrink-0" />
              ) : (
                <span className="text-muted-foreground shrink-0">{categoryIcon[att.category]}</span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{att.name}</p>
                <p className="text-muted-foreground">{categoryLabel[att.category]} · {humanSize(att.size)}</p>
              </div>
              <button
                type="button"
                onClick={() => onRemove(att.id)}
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

export default UniversalAttachmentBar;

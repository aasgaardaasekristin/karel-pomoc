import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Loader2 } from "lucide-react";
import UniversalAttachmentBar from "@/components/UniversalAttachmentBar";
import React from "react";

interface ChatInputAreaProps {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  isLoading: boolean;
  disabled?: boolean;
  isAnalyzing: boolean;
  attachments: any[];
  onRemoveAttachment: (id: string) => void;
  onOpenFilePicker: () => void;
  onCaptureScreenshot: () => void;
  onOpenDrivePicker: () => void;
  onAutoAnalyze: () => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  textareaRef?: React.RefObject<HTMLTextAreaElement>;
  children?: React.ReactNode;
  footerText?: string;
}

const ChatInputArea = ({
  input, setInput, onSend, onKeyDown,
  isLoading, disabled = false, isAnalyzing,
  attachments, onRemoveAttachment, onOpenFilePicker, onCaptureScreenshot,
  onOpenDrivePicker, onAutoAnalyze, fileInputRef, onFileChange,
  textareaRef, children, footerText,
}: ChatInputAreaProps) => (
  <div className="border-t border-border bg-card/50 backdrop-blur-sm">
    <div className="max-w-4xl mx-auto px-2 sm:px-4 py-2 sm:py-4">
      <div className="flex gap-2 sm:gap-3 items-end relative">
        <UniversalAttachmentBar
          attachments={attachments}
          onRemove={onRemoveAttachment}
          onOpenFilePicker={onOpenFilePicker}
          onCaptureScreenshot={onCaptureScreenshot}
          onOpenDrivePicker={onOpenDrivePicker}
          onAutoAnalyze={onAutoAnalyze}
          disabled={isLoading || disabled}
          fileInputRef={fileInputRef}
          onFileChange={onFileChange}
          isAnalyzing={isAnalyzing}
        />
        <Textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Napiš svou zprávu..."
          className="flex-1 min-w-0 min-h-[2.75rem] sm:min-h-[3.5rem] max-h-[9.375rem] sm:max-h-[12.5rem] resize-none text-sm sm:text-base"
          disabled={isLoading || disabled}
        />
        <Button
          onClick={onSend}
          disabled={(!input.trim() && attachments.length === 0) || isLoading || disabled}
          size="icon"
          className="h-[2.75rem] w-[2.75rem] sm:h-[3.5rem] sm:w-[3.5rem] shrink-0"
        >
          {isLoading ? <Loader2 className="w-4 h-4 sm:w-5 sm:h-5 animate-spin" /> : <Send className="w-4 h-4 sm:w-5 sm:h-5" />}
        </Button>
      </div>
      {children}
      {footerText && (
        <p className="text-xs text-muted-foreground mt-1.5 sm:mt-2 text-center">{footerText}</p>
      )}
    </div>
  </div>
);

export default ChatInputArea;

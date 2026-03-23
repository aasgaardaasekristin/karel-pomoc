import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, FileText, Download, Search, Link2 } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import { handleDriveError } from "@/lib/driveErrorHandler";
import type { PendingAttachment } from "@/hooks/useUniversalUpload";

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onFileSelected: (attachment: PendingAttachment) => void;
}

/** Extract a Google Drive file ID from various URL formats or raw ID */
function extractFileId(input: string): string | null {
  const trimmed = input.trim();

  // Direct file ID (no slashes, 20+ chars of alphanumeric/dash/underscore)
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) {
    return trimmed;
  }

  // Standard: /d/<id> or /file/d/<id>
  const dMatch = trimmed.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if (dMatch) return dMatch[1];

  // Spreadsheets: /spreadsheets/d/<id>
  const ssMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (ssMatch) return ssMatch[1];

  // Presentation: /presentation/d/<id>
  const prMatch = trimmed.match(/\/presentation\/d\/([a-zA-Z0-9_-]{20,})/);
  if (prMatch) return prMatch[1];

  // Open by ID: ?id=<id>
  const idParam = trimmed.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (idParam) return idParam[1];

  // Fallback: try the longest alphanumeric segment
  const segments = trimmed.split(/[/?&#=]/).filter(s => /^[a-zA-Z0-9_-]{20,}$/.test(s));
  if (segments.length > 0) return segments[0];

  return null;
}

const GoogleDrivePickerDialog = ({ open, onClose, onFileSelected }: Props) => {
  const [tab, setTab] = useState<string>("browse");
  const [query, setQuery] = useState("");
  const [driveUrl, setDriveUrl] = useState("");
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);

  const searchFiles = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setFiles([]);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-gdrive-list`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ query: query.trim() }),
        }
      );
      if (!resp.ok) {
        const errBody = await resp.text();
        console.error("Drive list error:", resp.status, errBody);
        throw new Error(`Chyba ${resp.status}`);
      }
      const data = await resp.json();
      const found = data.files || [];
      setFiles(found);
      if (found.length === 0) {
        toast.info("Žádné soubory nenalezeny pro tento dotaz");
      }
    } catch (err) {
      console.error("Drive search error:", err);
      toast.error("Nepodařilo se prohledat Google Drive");
    } finally {
      setLoading(false);
    }
  };

  const downloadFile = async (fileId: string, fileName: string) => {
    setDownloading(fileId);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-gdrive-download`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ fileId, fileName }),
        }
      );
      if (!resp.ok) {
        const errBody = await resp.text();
        console.error("Drive download error:", resp.status, errBody);
        throw new Error(`Chyba ${resp.status}`);
      }
      const data = await resp.json();

      const attachment: PendingAttachment = {
        id: `drive-${fileId}-${Date.now()}`,
        name: data.name || fileName,
        type: data.mimeType || "application/octet-stream",
        size: data.size || 0,
        category: data.mimeType?.startsWith("image/") ? "image"
          : data.mimeType?.startsWith("audio/") ? "audio"
          : data.mimeType?.startsWith("video/") ? "video"
          : "document",
        driveFileId: fileId,
        storagePath: data.storagePath,
      };

      onFileSelected(attachment);
      toast.success(`Soubor z Drive načten: ${data.name || fileName}`);
      onClose();
    } catch (err) {
      console.error("Drive download error:", err);
      toast.error("Nepodařilo se stáhnout soubor z Google Drive. Zkontroluj, zda je soubor sdílen s mujosobniasistentnamiru@gmail.com.");
    } finally {
      setDownloading(null);
    }
  };

  const handleUrlImport = async () => {
    if (!driveUrl.trim()) return;
    const fileId = extractFileId(driveUrl);
    if (!fileId) {
      toast.error("Nepodařilo se rozpoznat ID souboru. Vlož platný Google Drive odkaz nebo ID souboru.");
      return;
    }
    await downloadFile(fileId, `drive_file_${fileId.slice(0, 8)}`);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Google Drive</DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="w-full">
            <TabsTrigger value="browse" className="flex-1 gap-1.5">
              <Search className="w-4 h-4" />
              Procházet
            </TabsTrigger>
            <TabsTrigger value="url" className="flex-1 gap-1.5">
              <Link2 className="w-4 h-4" />
              Vložit odkaz
            </TabsTrigger>
          </TabsList>

          <TabsContent value="browse" className="space-y-3 mt-3">
            <div className="flex gap-2">
              <Input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Hledej soubory na Drive..."
                onKeyDown={e => e.key === "Enter" && searchFiles()}
              />
              <Button onClick={searchFiles} disabled={loading || !query.trim()} size="icon" className="shrink-0 h-10 w-10">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              </Button>
            </div>

            <div className="max-h-60 overflow-y-auto space-y-1">
              {files.length === 0 && !loading && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  Zadej hledaný výraz a stiskni Enter nebo klikni na lupu
                </p>
              )}
              {loading && (
                <div className="flex items-center justify-center py-6 gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Hledám na Google Drive...
                </div>
              )}
              {files.map(f => (
                <div key={f.id} className="flex items-center gap-2 p-2 rounded-md hover:bg-muted/50 group">
                  <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{f.name}</p>
                    <p className="text-xs text-muted-foreground">{f.mimeType}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => downloadFile(f.id, f.name)}
                    disabled={downloading === f.id}
                    className="h-8 px-2"
                  >
                    {downloading === f.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Download className="w-4 h-4" />
                    )}
                  </Button>
                </div>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="url" className="space-y-3 mt-3">
            <Input
              value={driveUrl}
              onChange={e => setDriveUrl(e.target.value)}
              placeholder="https://drive.google.com/... nebo ID souboru"
              onKeyDown={e => e.key === "Enter" && handleUrlImport()}
            />
            <p className="text-xs text-muted-foreground">
              Vlož odkaz na soubor z Google Drive nebo přímo ID souboru. Soubor musí být sdílen s mujosobniasistentnamiru@gmail.com.
            </p>
            <Button onClick={handleUrlImport} disabled={loading || downloading !== null || !driveUrl.trim()} className="w-full">
              {(loading || downloading !== null) ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Download className="w-4 h-4 mr-2" />}
              Importovat z Drive
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
};

export default GoogleDrivePickerDialog;
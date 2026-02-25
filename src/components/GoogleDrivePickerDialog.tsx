import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, FileText, Download, Search, Link2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
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
      if (!resp.ok) throw new Error("Chyba při hledání");
      const data = await resp.json();
      setFiles(data.files || []);
    } catch (err) {
      console.error(err);
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
      if (!resp.ok) throw new Error("Chyba při stahování");
      const data = await resp.json();

      const attachment: PendingAttachment = {
        id: `drive-${fileId}-${Date.now()}`,
        name: fileName,
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
      toast.success(`Soubor z Drive načten: ${fileName}`);
      onClose();
    } catch (err) {
      console.error(err);
      toast.error("Nepodařilo se stáhnout soubor z Drive");
    } finally {
      setDownloading(null);
    }
  };

  const handleUrlImport = async () => {
    if (!driveUrl.trim()) return;
    // Extract file ID from Google Drive URL
    const match = driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) {
      toast.error("Neplatný Google Drive odkaz");
      return;
    }
    const fileId = match[1];
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
              <Button onClick={searchFiles} disabled={loading} size="sm">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              </Button>
            </div>

            <div className="max-h-60 overflow-y-auto space-y-1">
              {files.length === 0 && !loading && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  Zadej hledaný výraz a stiskni Enter
                </p>
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
              placeholder="https://drive.google.com/file/d/..."
            />
            <Button onClick={handleUrlImport} disabled={loading || !driveUrl.trim()} className="w-full">
              {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Download className="w-4 h-4 mr-2" />}
              Importovat z Drive
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
};

export default GoogleDrivePickerDialog;

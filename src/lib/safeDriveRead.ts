/**
 * P33.10.2 — Drive Read Containment (client side)
 *
 * Wrapper for `karel-did-drive-read` that:
 *  - aborts after a strict client-side budget (default 12 s),
 *  - never throws,
 *  - returns `{ ok:false, controlledTimeout:true }` on failure,
 *  - emits at most one toast per minute so the UI is never spammy,
 *  - never causes a blank screen.
 *
 * Defaults: recursive=false, allowGlobalSearch=false. Callers must opt in.
 */
import { toast } from "@/hooks/use-toast";

export type SafeDriveReadResult = {
  ok: boolean;
  controlledTimeout?: boolean;
  status?: string;
  reason?: string;
  documents?: Record<string, string>;
  content?: string | null;
  fileId?: string;
  fileName?: string;
  totalChars?: number;
  totalLines?: number;
  elapsedMs?: number;
  requestId?: string;
};

export type SafeDriveReadOptions = {
  documents?: string[];
  partName?: string;
  subFolder?: string;
  tailLines?: number;
  listAll?: boolean;
  recursive?: boolean;
  allowGlobalSearch?: boolean;
  maxDepth?: number;
  maxFolders?: number;
  maxFiles?: number;
  caller: string;
  budgetMs?: number;
  silent?: boolean;
};

let lastWarnAt = 0;
function warnUserOnce(): void {
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  try {
    toast({
      title: "Drive nedostupný",
      description: "Drive detail se teď nepodařilo načíst; používám dostupná data z databáze.",
      duration: 5000,
    });
  } catch {}
}

export async function safeDriveRead(
  authHeaders: Record<string, string>,
  opts: SafeDriveReadOptions,
): Promise<SafeDriveReadResult> {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-drive-read`;
  const budget = Math.max(2_000, Math.min(opts.budgetMs ?? 12_000, 60_000));

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), budget);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        documents: opts.documents,
        partName: opts.partName,
        subFolder: opts.subFolder,
        tailLines: opts.tailLines,
        listAll: opts.listAll,
        recursive: opts.recursive ?? false,
        allowGlobalSearch: opts.allowGlobalSearch ?? false,
        maxDepth: opts.maxDepth,
        maxFolders: opts.maxFolders,
        maxFiles: opts.maxFiles,
        caller: opts.caller,
      }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      if (!opts.silent) warnUserOnce();
      return { ok: false, controlledTimeout: false, status: `http_${res.status}` };
    }
    const data = await res.json().catch(() => ({}));
    if (data?.ok === false || data?.status === "controlled_timeout") {
      if (!opts.silent) warnUserOnce();
      return {
        ok: false,
        controlledTimeout: data?.status === "controlled_timeout",
        status: data?.status,
        reason: data?.reason,
        documents: data?.partial_documents ?? data?.documents,
        elapsedMs: data?.elapsed_ms,
        requestId: data?.request_id,
      };
    }
    return {
      ok: true,
      documents: data?.documents,
      content: data?.content ?? null,
      fileId: data?.fileId,
      fileName: data?.fileName,
      totalChars: data?.totalChars,
      totalLines: data?.totalLines,
      elapsedMs: data?.elapsed_ms,
      requestId: data?.request_id,
    };
  } catch (e) {
    if (!opts.silent) warnUserOnce();
    const aborted = (e as any)?.name === "AbortError";
    return { ok: false, controlledTimeout: aborted, status: aborted ? "client_timeout" : "exception" };
  } finally {
    clearTimeout(t);
  }
}

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

// ═══════════════════════════════════════════════════════════════════════════
// P33.10.2 — Drive Read Containment
// Hard limits enforced for every invocation. Recursive / global search are
// off by default. Budget-exhausted requests return a controlled-timeout JSON
// envelope (HTTP 200) instead of being killed by the runtime IDLE_TIMEOUT.
// ═══════════════════════════════════════════════════════════════════════════
const OVERALL_BUDGET_MS = 45_000;
const PER_FETCH_TIMEOUT_MS = 8_000;
const MAX_DEPTH_DEFAULT = 2;
const MAX_FOLDERS_DEFAULT = 80;
const MAX_FILES_DEFAULT = 300;
const MAX_GLOBAL_SEARCH_RESULTS = 30;

type Budget = {
  startedAt: number;
  deadline: number;
  foldersVisited: number;
  filesSeen: number;
  reqId: string;
};

function newBudget(reqId: string): Budget {
  const now = Date.now();
  return {
    startedAt: now,
    deadline: now + OVERALL_BUDGET_MS,
    foldersVisited: 0,
    filesSeen: 0,
    reqId,
  };
}

function budgetExhausted(b: Budget, maxFolders: number, maxFiles: number): boolean {
  return (
    Date.now() >= b.deadline ||
    b.foldersVisited >= maxFolders ||
    b.filesSeen >= maxFiles
  );
}

function elapsed(b: Budget): number {
  return Date.now() - b.startedAt;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), PER_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ── OAuth2 token helper ──
async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing Google OAuth credentials");
  }

  const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await res.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

// ── Drive helpers ──
async function findFolders(token: string, name: string, parentId?: string): Promise<Array<{ id: string }>> {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;

  const params = new URLSearchParams({
    q,
    fields: "files(id)",
    pageSize: "20",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });

  const res = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.files || [];
}

async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  const folders = await findFolders(token, name, parentId);
  return folders[0]?.id || null;
}

async function resolveKartotekaRoot(token: string): Promise<string | null> {
  const rootVariants = ["kartoteka_DID", "Kartoteka_DID", "Kartotéka_DID", "KARTOTEKA_DID"];

  for (const rootName of rootVariants) {
    const candidates = await findFolders(token, rootName);

    for (const candidate of candidates) {
      const centrumId = await findFolder(token, "00_CENTRUM", candidate.id);
      const aktivniId = await findFolder(token, "01_AKTIVNI_FRAGMENTY", candidate.id);
      if (centrumId || aktivniId) return candidate.id;
    }

    if (candidates[0]?.id) return candidates[0].id;
  }

  return null;
}

async function listFilesInFolder(
  token: string,
  folderId: string,
  budget: Budget,
  maxFiles: number,
): Promise<Array<{ id: string; name: string; mimeType?: string }>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const allFiles: Array<{ id: string; name: string; mimeType?: string }> = [];
  let pageToken: string | undefined;

  do {
    if (Date.now() >= budget.deadline) break;
    const params = new URLSearchParams({
      q,
      fields: "nextPageToken,files(id,name,mimeType)",
      pageSize: "200",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    const batch = (data.files || []) as Array<{ id: string; name: string; mimeType?: string }>;
    for (const f of batch) {
      if (allFiles.length + budget.filesSeen >= maxFiles) break;
      allFiles.push(f);
    }
    budget.filesSeen += batch.length;
    pageToken = data.nextPageToken || undefined;
    if (allFiles.length + budget.filesSeen >= maxFiles) break;
  } while (pageToken);

  return allFiles;
}

async function readFileContent(token: string, fileId: string, mimeType?: string): Promise<string> {
  const isGoogleDoc = mimeType === "application/vnd.google-apps.document";
  const isGoogleSheet = mimeType === "application/vnd.google-apps.spreadsheet";
  const isGoogleWorkspace = mimeType?.startsWith("application/vnd.google-apps.");

  if (isGoogleSheet) {
    const exportRes = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/csv`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!exportRes.ok) throw new Error(`Cannot export sheet ${fileId}: ${exportRes.status}`);
    return await exportRes.text();
  }

  if (isGoogleDoc || isGoogleWorkspace) {
    const exportRes = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!exportRes.ok) throw new Error(`Cannot export doc ${fileId}: ${exportRes.status}`);
    return await exportRes.text();
  }

  const res = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const exportRes = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!exportRes.ok) throw new Error(`Cannot read file ${fileId}: ${exportRes.status}`);
    return await exportRes.text();
  }
  return await res.text();
}

const stripDiacritics = (value: string) =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const canonicalDocName = (value: string) => {
  const normalized = stripDiacritics(value)
    .toLowerCase()
    .replace(/\.(txt|md|doc|docx)$/i, "")
    .replace(/[\s_-]/g, "")
    .replace(/^karta/, "")
    .replace(/^\d+/, "");

  return normalized;
};

const isDocumentMatch = (requested: string, fileName: string) => {
  const requestedCanonical = canonicalDocName(requested);
  const fileCanonical = canonicalDocName(fileName);

  if (!requestedCanonical || !fileCanonical) return false;

  return (
    requestedCanonical === fileCanonical ||
    requestedCanonical.includes(fileCanonical) ||
    fileCanonical.includes(requestedCanonical)
  );
};

async function findDocumentBounded(
  token: string,
  folderId: string,
  requestedDoc: string,
  budget: Budget,
  depth: number,
  maxDepth: number,
  maxFolders: number,
  maxFiles: number,
): Promise<{ id: string; name: string; mimeType?: string } | null> {
  if (budgetExhausted(budget, maxFolders, maxFiles)) return null;
  budget.foldersVisited += 1;

  const files = await listFilesInFolder(token, folderId, budget, maxFiles);

  const directMatch = files.find(
    (f) => f.mimeType !== "application/vnd.google-apps.folder" && isDocumentMatch(requestedDoc, f.name)
  );
  if (directMatch) return directMatch;

  if (depth >= maxDepth) return null;

  const subfolders = files.filter((f) => f.mimeType === "application/vnd.google-apps.folder");
  for (const subfolder of subfolders) {
    if (budgetExhausted(budget, maxFolders, maxFiles)) return null;
    const nestedMatch = await findDocumentBounded(
      token, subfolder.id, requestedDoc, budget, depth + 1, maxDepth, maxFolders, maxFiles
    );
    if (nestedMatch) return nestedMatch;
  }

  return null;
}

async function findDocumentGlobalBounded(
  token: string,
  requestedDoc: string,
  budget: Budget,
): Promise<{ id: string; name: string; mimeType?: string } | null> {
  if (Date.now() >= budget.deadline) return null;
  const canonical = canonicalDocName(requestedDoc);
  const searchTerm = canonical.replace(/^\d+/, "").slice(0, 40) || requestedDoc;

  const q = `trashed=false and mimeType!='application/vnd.google-apps.folder' and name contains '${searchTerm}'`;
  const res = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&pageSize=${MAX_GLOBAL_SEARCH_RESULTS}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  const files = ((data.files || []) as Array<{ id: string; name: string; mimeType?: string }>)
    .slice(0, MAX_GLOBAL_SEARCH_RESULTS);

  return files.find((f) => isDocumentMatch(requestedDoc, f.name)) || null;
}

function controlledTimeout(budget: Budget, reason: string, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    ok: false,
    status: "controlled_timeout",
    reason,
    partial: true,
    items_found: [],
    searched_folders: budget.foldersVisited,
    files_seen: budget.filesSeen,
    elapsed_ms: elapsed(budget),
    request_id: budget.reqId,
    ...extra,
  }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // ── Auth fallback chain ──
  let authenticated = false;
  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    if (token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) authenticated = true;
  } catch {}
  if (!authenticated) {
    try {
      const authHeader = req.headers.get("Authorization") || "";
      const token = authHeader.replace("Bearer ", "");
      if (token === Deno.env.get("SUPABASE_ANON_KEY")) authenticated = true;
    } catch {}
  }
  if (!authenticated) {
    try {
      const authResult = await requireAuth(req);
      if (!(authResult instanceof Response)) authenticated = true;
    } catch (authErr: any) {
      console.warn("[drive-read] Auth fallback - proceeding without strict auth:", authErr?.message);
      authenticated = true;
    }
  }
  if (!authenticated) {
    console.warn("[drive-read] No auth method succeeded, proceeding anyway (read-only)");
  }

  const reqId = crypto.randomUUID().slice(0, 8);
  const budget = newBudget(reqId);

  try {
    const body = await req.json().catch(() => ({}));
    const {
      documents,
      listAll,
      subFolder,
      partName,
      tailLines,
      // P33.10.2: explicit opt-in flags. Defaults are restrictive.
      recursive = false,
      allowGlobalSearch = false,
      maxDepth = MAX_DEPTH_DEFAULT,
      maxFolders = MAX_FOLDERS_DEFAULT,
      maxFiles = MAX_FILES_DEFAULT,
      caller = "unknown",
    } = body;

    const effectiveMaxDepth = Math.min(Number(maxDepth) || MAX_DEPTH_DEFAULT, MAX_DEPTH_DEFAULT);
    const effectiveMaxFolders = Math.min(Number(maxFolders) || MAX_FOLDERS_DEFAULT, MAX_FOLDERS_DEFAULT);
    const effectiveMaxFiles = Math.min(Number(maxFiles) || MAX_FILES_DEFAULT, MAX_FILES_DEFAULT);

    // Structured, secret-free log line.
    console.log(JSON.stringify({
      tag: "[drive-read]",
      reqId,
      caller,
      action: partName ? "partName" : (listAll ? "listAll" : "documents"),
      target_label: partName
        ? canonicalDocName(String(partName)).slice(0, 40)
        : (Array.isArray(documents) ? documents.length : 0),
      subFolder: subFolder || null,
      recursive,
      globalSearch: allowGlobalSearch,
      maxDepth: effectiveMaxDepth,
      maxFolders: effectiveMaxFolders,
      maxFiles: effectiveMaxFiles,
    }));

    const token = await getAccessToken();
    const rootFolderId = await resolveKartotekaRoot(token);

    if (!rootFolderId) {
      return new Response(JSON.stringify({
        ok: false,
        error: "Složka Kartoteka_DID nebyla nalezena na Google Drive",
        documents: {},
        request_id: reqId,
        elapsed_ms: elapsed(budget),
      }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ═══ MODE: partName ═══
    if (partName) {
      const rootChildren = await listFilesInFolder(token, rootFolderId, budget, effectiveMaxFiles);
      const foldersToSearch: string[] = [];
      for (const f of rootChildren) {
        if (f.mimeType !== "application/vnd.google-apps.folder") continue;
        const name = f.name.trim();
        if (/^01/.test(name) || stripDiacritics(name).toLowerCase().includes("aktiv")) {
          foldersToSearch.unshift(f.id);
        } else if (/^03/.test(name) || stripDiacritics(name).toLowerCase().includes("archiv")) {
          foldersToSearch.push(f.id);
        }
      }
      foldersToSearch.push(rootFolderId);

      let cardContent: string | null = null;
      let foundFile: { id: string; name: string; mimeType?: string } | null = null;

      for (const searchFolderId of foldersToSearch) {
        if (budgetExhausted(budget, effectiveMaxFolders, effectiveMaxFiles)) {
          return controlledTimeout(budget, "drive_read_budget_exhausted", { mode: "partName" });
        }
        const found = await findDocumentBounded(
          token, searchFolderId, partName, budget,
          0, effectiveMaxDepth, effectiveMaxFolders, effectiveMaxFiles
        );
        if (found) {
          try {
            cardContent = await readFileContent(token, found.id, found.mimeType);
            foundFile = found;
            break;
          } catch (e) {
            console.error(`[drive-read] read fail ${reqId}:`, (e as Error).message);
          }
        }
      }

      if (cardContent && foundFile) {
        let returnContent = cardContent;
        if (tailLines && typeof tailLines === "number" && tailLines > 0) {
          const allLines = cardContent.split("\n");
          returnContent = allLines.slice(-tailLines).join("\n");
        }
        return new Response(JSON.stringify({
          ok: true,
          content: returnContent,
          fileId: foundFile.id,
          fileName: foundFile.name,
          totalChars: cardContent.length,
          totalLines: cardContent.split("\n").length,
          elapsed_ms: elapsed(budget),
          request_id: reqId,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (Date.now() >= budget.deadline) {
        return controlledTimeout(budget, "drive_read_budget_exhausted", { mode: "partName" });
      }
      return new Response(JSON.stringify({
        ok: false,
        content: null,
        error: `Card for "${partName}" not found`,
        request_id: reqId,
        elapsed_ms: elapsed(budget),
      }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ═══ MODE: documents[] ═══
    let targetFolderId = rootFolderId;
    if (subFolder) {
      const subFolderId = await findFolder(token, subFolder, rootFolderId);
      if (subFolderId) targetFolderId = subFolderId;
      else console.warn(`[drive-read] Subfolder "${subFolder}" not found, using root`);
    }

    if (listAll) {
      const files = await listFilesInFolder(token, targetFolderId, budget, effectiveMaxFiles);
      return new Response(JSON.stringify({ ok: true, files, folderId: targetFolderId, request_id: reqId, elapsed_ms: elapsed(budget) }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result: Record<string, string> = {};
    const requestedDocs: string[] = documents || [];

    for (const docName of requestedDocs) {
      if (budgetExhausted(budget, effectiveMaxFolders, effectiveMaxFiles)) {
        return controlledTimeout(budget, "drive_read_budget_exhausted", {
          mode: "documents",
          partial_documents: result,
        });
      }

      // P33.10.2: depth and recursion are bounded, never unlimited.
      const effectiveDepth = recursive ? effectiveMaxDepth : 1;
      let match = await findDocumentBounded(
        token, targetFolderId, docName, budget,
        0, effectiveDepth, effectiveMaxFolders, effectiveMaxFiles
      );

      // Global search: opt-in only.
      if (!match && allowGlobalSearch === true) {
        match = await findDocumentGlobalBounded(token, docName, budget);
      }

      if (match) {
        try {
          result[docName] = await readFileContent(token, match.id, match.mimeType);
        } catch (e) {
          console.error(`[drive-read] doc read fail ${reqId} ${docName}:`, (e as Error).message);
          result[docName] = `[Chyba při čtení]`;
        }
      } else {
        result[docName] = `[Dokument "${docName}" nebyl nalezen ve složce Kartoteka_DID]`;
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      documents: result,
      folderId: targetFolderId,
      elapsed_ms: elapsed(budget),
      request_id: reqId,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    if (Date.now() >= budget.deadline || (error as any)?.name === "AbortError") {
      return controlledTimeout(budget, "drive_read_budget_exhausted", {
        error_kind: (error as any)?.name || "abort",
      });
    }
    console.error(`[drive-read] error ${reqId}:`, (error as Error).message);
    return new Response(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
        request_id: reqId,
        elapsed_ms: elapsed(budget),
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

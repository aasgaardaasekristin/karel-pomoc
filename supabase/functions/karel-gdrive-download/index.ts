import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const { fileId, fileName } = await req.json();
    if (!fileId) throw new Error("Missing fileId");

    // Get access token
    const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
    const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error("Google OAuth credentials not configured");
    }

    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!tokenResp.ok) throw new Error("Failed to refresh Google token");
    const { access_token } = await tokenResp.json();

    // Get file metadata
    const metaResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,size&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    if (!metaResp.ok) {
      const metaErr = await metaResp.text();
      console.error("Metadata error:", metaResp.status, metaErr);
      throw new Error(`Failed to get file metadata: ${metaResp.status} ${metaErr}`);
    }
    const meta = await metaResp.json();

    // Determine if it's a Google Docs type that needs export
    const googleMimeTypes: Record<string, string> = {
      "application/vnd.google-apps.document": "application/pdf",
      "application/vnd.google-apps.spreadsheet": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.google-apps.presentation": "application/pdf",
    };

    let downloadUrl: string;
    let finalMimeType = meta.mimeType;

    if (googleMimeTypes[meta.mimeType]) {
      finalMimeType = googleMimeTypes[meta.mimeType];
      downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(finalMimeType)}`;
    } else {
      downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    }

    // Download file content
    const fileResp = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!fileResp.ok) throw new Error("Failed to download file");

    const fileBuffer = await fileResp.arrayBuffer();
    const fileBytes = new Uint8Array(fileBuffer);

    // Upload to Supabase Storage
    const ext = (fileName || meta.name || "file").split(".").pop() || "bin";
    const storagePath = `${user.id}/drive-${fileId}-${Date.now()}.${ext}`;

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { error: uploadError } = await supabaseAdmin.storage
      .from("chat-attachments")
      .upload(storagePath, fileBytes, {
        contentType: finalMimeType,
        upsert: false,
      });

    if (uploadError) throw uploadError;

    return new Response(JSON.stringify({
      storagePath,
      mimeType: finalMimeType,
      size: fileBytes.length,
      name: meta.name || fileName,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Drive download error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

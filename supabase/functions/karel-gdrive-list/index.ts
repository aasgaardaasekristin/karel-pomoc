import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const { query } = await req.json();
    if (!query) {
      return new Response(JSON.stringify({ files: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get access token using refresh token
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

    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      console.error("Token refresh failed:", tokenResp.status, errText);
      throw new Error("Failed to refresh Google token");
    }
    const { access_token } = await tokenResp.json();

    // Build search query - escape single quotes and add trashed=false
    const escapedQuery = query.replace(/'/g, "\\'");
    const driveQuery = `name contains '${escapedQuery}' and trashed=false`;
    
    // Also encode orderBy properly
    const params = new URLSearchParams({
      q: driveQuery,
      fields: "files(id,name,mimeType,size,modifiedTime)",
      pageSize: "20",
      orderBy: "modifiedTime desc",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });

    console.log(`[gdrive-list] Searching: "${query}" → q=${driveQuery}`);

    const driveResp = await fetch(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${access_token}` },
      }
    );

    if (!driveResp.ok) {
      const errText = await driveResp.text();
      console.error("Drive API error:", driveResp.status, errText);
      throw new Error(`Drive API error: ${driveResp.status}`);
    }
    const driveData = await driveResp.json();

    console.log(`[gdrive-list] Found ${(driveData.files || []).length} files for "${query}"`);

    return new Response(JSON.stringify({ files: driveData.files || [] }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Drive list error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
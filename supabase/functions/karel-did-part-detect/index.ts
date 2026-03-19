import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/auth.ts";
import {
  normalize,
  scoreName,
  scoreEntryMatch,
  loadDriveRegistryEntries,
  type DriveRegistryEntry,
} from "../_shared/driveRegistry.ts";

/**
 * Karel DID Part Detect – Unified identity resolver
 * 
 * Checks BOTH did_part_registry (DB) AND Drive Excel registry.
 * Parses Column B aliases: "ARTHUR (ARTUR, ARTÍK)" → primary + aliases.
 * Matches input against primary name AND each alias individually.
 * 
 * Input: { name: string }
 * Output: { matched, partName, displayName, source, matchScore, matchedAlias?, registry?, profile?, driveEntry? }
 */

// ── OAuth2 ──
async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing Google OAuth credentials");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { name } = await req.json();
    if (!name || typeof name !== "string") {
      return new Response(JSON.stringify({ error: "Missing name" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const inputNorm = normalize(name);
    if (!inputNorm) {
      return new Response(JSON.stringify({ matched: false, partName: name, displayName: name, source: "new" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── 1. Search DB registry ──
    const { data: registry } = await supabase
      .from("did_part_registry")
      .select("part_name, display_name, status, age_estimate, language, known_triggers, known_strengths, role_in_system, cluster, last_emotional_state")
      .eq("user_id", user.id);

    let bestDbMatch: any = null;
    let bestDbScore = 0;

    for (const row of (registry || [])) {
      const names = [row.part_name, row.display_name].filter(Boolean);
      for (const n of names) {
        const score = scoreName(inputNorm, normalize(n));
        if (score > bestDbScore) {
          bestDbScore = score;
          bestDbMatch = row;
        }
      }
    }

    // ── 2. Search Drive Excel registry with alias parsing ──
    let bestDriveMatch: DriveRegistryEntry | null = null;
    let bestDriveScore = 0;
    let matchedAlias: string | null = null;

    try {
      const driveToken = await getAccessToken();
      const driveEntries = await loadDriveRegistryEntries(driveToken);

      for (const entry of driveEntries) {
        // Score against primary name AND each alias individually
        const entryScore = scoreEntryMatch(inputNorm, entry);
        if (entryScore > bestDriveScore) {
          bestDriveScore = entryScore;
          bestDriveMatch = entry;

          // Determine which alias was matched
          if (scoreName(inputNorm, entry.normalizedName) === entryScore) {
            matchedAlias = entry.primaryName;
          } else {
            // Find which alias matched best
            for (let i = 0; i < entry.normalizedAliases.length; i++) {
              if (scoreName(inputNorm, entry.normalizedAliases[i]) === entryScore) {
                matchedAlias = entry.aliases[i];
                break;
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn("[part-detect] Drive lookup failed (non-blocking):", e.message);
    }

    // ── 3. Decide best match ──
    const MATCH_THRESHOLD = 60;
    const dbOk = bestDbMatch && bestDbScore >= MATCH_THRESHOLD;
    const driveOk = bestDriveMatch && bestDriveScore >= MATCH_THRESHOLD;

    if (dbOk || driveOk) {
      // Prefer Drive match for canonical name (authoritative alias source),
      // but use DB for profile data
      const useDb = dbOk && (!driveOk || bestDbScore >= bestDriveScore);
      
      // Canonical name: prefer Drive primary name (authoritative), fall back to DB
      const canonicalPartName = driveOk
        ? bestDriveMatch!.primaryName
        : bestDbMatch.part_name;
      const displayName = driveOk
        ? bestDriveMatch!.primaryName
        : (bestDbMatch?.display_name || bestDbMatch?.part_name);
      const source = dbOk && driveOk ? "both" : dbOk ? "db" : "drive";
      const finalScore = Math.max(bestDbScore, bestDriveScore);

      // Load profile using DB match part_name
      let profile = null;
      if (bestDbMatch) {
        const { data: p } = await supabase
          .from("did_part_profiles")
          .select("*")
          .eq("user_id", user.id)
          .eq("part_name", bestDbMatch.part_name)
          .maybeSingle();
        profile = p;
      }

      return new Response(JSON.stringify({
        matched: true,
        partName: canonicalPartName,
        displayName,
        source,
        matchScore: finalScore,
        matchedAlias: matchedAlias || null,
        registry: bestDbMatch || null,
        driveEntry: driveOk ? {
          id: bestDriveMatch!.id,
          name: bestDriveMatch!.primaryName,
          rawName: bestDriveMatch!.rawName,
          aliases: bestDriveMatch!.aliases,
          status: bestDriveMatch!.status,
        } : null,
        profile,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // No match
    return new Response(JSON.stringify({
      matched: false,
      partName: name.trim(),
      displayName: name.trim(),
      source: "new",
      matchScore: Math.max(bestDbScore, bestDriveScore),
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("Part detect error:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

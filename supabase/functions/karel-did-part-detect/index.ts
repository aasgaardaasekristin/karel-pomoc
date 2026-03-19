import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/auth.ts";

/**
 * Karel DID Part Detect – Fuzzy matching parts from did_part_registry
 * 
 * Input: { name: string }
 * Output: { matched: boolean, partName: string, displayName: string, profile?: object }
 */

function normalize(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "").trim();
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

    // Get user from token
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
      return new Response(JSON.stringify({ matched: false, partName: name, displayName: name }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 1. Search in did_part_registry (primary source)
    const { data: registry } = await supabase
      .from("did_part_registry")
      .select("part_name, display_name, status, age_estimate, language, known_triggers, known_strengths, role_in_system, cluster, last_emotional_state")
      .eq("user_id", user.id);

    let bestMatch: any = null;
    let bestScore = 0;

    for (const row of (registry || [])) {
      const names = [row.part_name, row.display_name].filter(Boolean);
      for (const n of names) {
        const normN = normalize(n);
        if (!normN) continue;

        let score = 0;
        if (normN === inputNorm) score = 100;
        else if (normN.includes(inputNorm)) score = 80;
        else if (inputNorm.includes(normN)) score = 70;
        else {
          // Check if names share substantial overlap (e.g., artur vs arthur)
          const shorter = inputNorm.length < normN.length ? inputNorm : normN;
          const longer = inputNorm.length < normN.length ? normN : inputNorm;
          if (shorter.length >= 3 && longer.includes(shorter.slice(0, 3))) score = 50;
        }

        if (score > bestScore) {
          bestScore = score;
          bestMatch = row;
        }
      }
    }

    if (bestMatch && bestScore >= 50) {
      // Load psychological profile if exists
      const { data: profile } = await supabase
        .from("did_part_profiles")
        .select("*")
        .eq("user_id", user.id)
        .eq("part_name", bestMatch.part_name)
        .maybeSingle();

      return new Response(JSON.stringify({
        matched: true,
        partName: bestMatch.part_name,
        displayName: bestMatch.display_name || bestMatch.part_name,
        status: bestMatch.status,
        registry: bestMatch,
        profile: profile || null,
        matchScore: bestScore,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // No match
    return new Response(JSON.stringify({
      matched: false,
      partName: name,
      displayName: name,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("Part detect error:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

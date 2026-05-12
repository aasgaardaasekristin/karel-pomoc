// Integration test: when no approved playroom_plan_snapshot exists for the
// requested part on today's plan, karel-chat MUST return HTTP 409 with a
// stable diagnostic shape. There is NO fallback to the live playroom_plan.
import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;

const ENDPOINT = `${SUPABASE_URL}/functions/v1/karel-chat`;

// Deterministically synthetic part name: extremely unlikely to match any row
// in did_daily_session_plans for today via ILIKE. This forces the
// loadApprovedPlayroomSnapshot() path to return reason="no_approved_plan_today"
// (or any other snapshot-unavailable reason), which MUST surface as 409.
const SYNTHETIC_PART = `__test_missing_snapshot_part_${Date.now()}__`;

Deno.test("karel-chat playroom returns 409 playroom_snapshot_unavailable when snapshot is missing", async () => {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({
      mode: "childcare",
      didSubMode: "playroom",
      didPartName: SYNTHETIC_PART,
      didThreadLabel: SYNTHETIC_PART,
      messages: [{ role: "user", content: "ahoj" }],
    }),
  });

  const text = await res.text();
  let body: any = {};
  try { body = JSON.parse(text); } catch { /* keep raw */ }

  assertEquals(res.status, 409, `expected 409, got ${res.status}: ${text}`);
  assertEquals(body.ok, false);
  assertEquals(body.error, "playroom_snapshot_unavailable");
  assertEquals(body.source, "snapshot");
  assert(typeof body.reason === "string" && body.reason.length > 0, "reason must be a non-empty string");
  assert("plan_id" in body, "plan_id key must be present (string or null)");
});

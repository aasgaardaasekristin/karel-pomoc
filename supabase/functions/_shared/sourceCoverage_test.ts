// @ts-nocheck
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildSourceCoverageSummary, buildDriveStatus } from "./sourceCoverage.ts";

/**
 * Minimal in-memory mock of the SupabaseClient surface used by sourceCoverage.
 * We seed per-table arrays and map .from(table).select().eq().gte().in().order().limit()
 * to filtered rows.
 */
function makeMockClient(tables: Record<string, any[]>) {
  return {
    from(table: string) {
      let rows: any[] = [...(tables[table] ?? [])];
      const filters: Array<(r: any) => boolean> = [];
      const api: any = {
        select(_: string) { return api; },
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return api; },
        neq(col: string, val: any) { filters.push((r) => r[col] !== val); return api; },
        gte(col: string, val: any) { filters.push((r) => String(r[col]) >= String(val)); return api; },
        lt(col: string, val: any) { filters.push((r) => String(r[col]) < String(val)); return api; },
        in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return api; },
        order(_c: string, _o: any) { return api; },
        limit(_n: number) {
          const data = rows.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data, error: null });
        },
        maybeSingle() {
          const data = rows.filter((r) => filters.every((f) => f(r)))[0] ?? null;
          return Promise.resolve({ data, error: null });
        },
      };
      return api;
    },
  };
}

const USER = "11111111-1111-1111-1111-111111111111";
const recent = () => new Date(Date.now() - 60_000).toISOString();

Deno.test("clinical raw>0, ingested=0 → reason_if_not_used non-empty", async () => {
  const sb = makeMockClient({
    did_threads: [
      { id: "t1", user_id: USER, last_activity_at: recent() },
      { id: "t2", user_id: USER, last_activity_at: recent() },
    ],
    did_event_ingestion_log: [],
    karel_pantry_b_entries: [],
  });
  const summary = await buildSourceCoverageSummary(sb as any, USER);
  const did = summary.sources.find((s) => s.source === "did_threads")!;
  assertEquals(did.raw_count, 2);
  assertEquals(did.ingested_count, 0);
  assertEquals(did.used_in_briefing, false);
  assert(did.reason_if_not_used && did.reason_if_not_used.length > 0,
    "reason_if_not_used must be non-empty when raw>0 and not used");
  assertEquals(did.reason_if_not_used, "no_new_relevant_content");
});

Deno.test("Hana personal raw>0, no DID implication → privacy_blocked", async () => {
  const sb = makeMockClient({
    karel_hana_conversations: [
      { id: "h1", user_id: USER, last_activity_at: recent() },
    ],
    did_event_ingestion_log: [],
    karel_pantry_b_entries: [],
  });
  const summary = await buildSourceCoverageSummary(sb as any, USER);
  const hana = summary.sources.find((s) => s.source === "karel_hana_conversations")!;
  assertEquals(hana.raw_count, 1);
  assertEquals(hana.used_in_briefing, false);
  assertEquals(hana.reason_if_not_used, "privacy_blocked");
  assertEquals(hana.privacy_safe, true);
});

Deno.test("Hana personal with hana_personal_ingestion Pantry B entry → used_in_briefing=true", async () => {
  const sb = makeMockClient({
    karel_hana_conversations: [
      { id: "h1", user_id: USER, last_activity_at: recent() },
    ],
    did_event_ingestion_log: [
      { id: "e1", source_kind: "hana_personal_ingestion", occurred_at: recent(), status: "ok" },
    ],
    karel_pantry_b_entries: [
      { id: "p1", user_id: USER, source_kind: "hana_personal_ingestion", created_at: recent() },
    ],
  });
  const summary = await buildSourceCoverageSummary(sb as any, USER);
  const hana = summary.sources.find((s) => s.source === "karel_hana_conversations")!;
  assertEquals(hana.ingested_count, 1);
  assertEquals(hana.pantry_count, 1);
  assertEquals(hana.used_in_briefing, true);
  assertEquals(hana.reason_if_not_used, null);
});

Deno.test("Drive status: drive_to_pantry_refresh = not_implemented and is_source_of_truth = false", async () => {
  const sb = makeMockClient({
    did_pending_drive_writes: [],
    did_pantry_packages: [],
  });
  const ds = await buildDriveStatus(sb as any);
  assertEquals(ds.drive_to_pantry_refresh, "not_implemented");
  assertEquals(ds.drive_is_source_of_truth, false);
  assertEquals(ds.operational_source, "DB/Pantry/Event ingestion");
});

/**
 * P30.1 — External Reality Source-Truth Foundation tests.
 *
 * Covers the provider abstraction, source-backed event normalization, and the
 * fail-closed path when no provider is configured. Runs under Vitest (Node).
 */

import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";

if (!(globalThis as any).crypto?.subtle) {
  (globalThis as any).crypto = webcrypto as any;
}

import {
  detectProviderFromEnv,
  runExternalRealitySearchProvider,
} from "../../supabase/functions/_shared/externalRealitySearchProvider.ts";
import { normalizeExternalSearchResultToEvent } from "../../supabase/functions/_shared/externalRealityEvents.ts";

describe("P30.1 provider abstraction (fail-closed)", () => {
  it("returns not_configured when no provider env is present", async () => {
    const r = await runExternalRealitySearchProvider({
      queries: ["týrání zvířat aktuální zpráva"],
      maxResultsPerQuery: 3,
      recencyDays: 7,
      envOverride: {},
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("not_configured");
    expect(r.provider).toBeNull();
    expect(r.results).toEqual([]);
    expect(r.reason).toBe("no_external_search_provider_configured");
  });

  it("detectProviderFromEnv prefers Perplexity over Firecrawl", () => {
    expect(
      detectProviderFromEnv({
        PERPLEXITY_API_KEY: "p",
        FIRECRAWL_API_KEY: "f",
      }).provider,
    ).toBe("perplexity");
    expect(
      detectProviderFromEnv({ FIRECRAWL_API_KEY: "f" }).provider,
    ).toBe("firecrawl");
    expect(detectProviderFromEnv({}).provider).toBeNull();
  });

  it("discards results without a real http(s) URL", async () => {
    const fetchStub = (async () =>
      new Response(
        JSON.stringify({
          results: [
            { url: "https://example.com/a", title: "A" },
            { url: "not-a-url", title: "B" }, // discarded
            { title: "no url" }, // discarded
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const r = await runExternalRealitySearchProvider({
      queries: ["q"],
      maxResultsPerQuery: 5,
      recencyDays: 7,
      envOverride: { PERPLEXITY_API_KEY: "k" },
      fetchOverride: fetchStub,
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("configured");
    expect(r.provider).toBe("perplexity");
    expect(r.results.length).toBe(1);
    expect(r.results[0].url).toBe("https://example.com/a");
  });

  it("returns provider error when underlying calls all fail", async () => {
    const fetchStub = (async () =>
      new Response("boom", { status: 500 })) as typeof fetch;
    const r = await runExternalRealitySearchProvider({
      queries: ["q"],
      maxResultsPerQuery: 3,
      recencyDays: 7,
      envOverride: { PERPLEXITY_API_KEY: "k" },
      fetchOverride: fetchStub,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("error");
    expect(r.results).toEqual([]);
  });

  it("rejects empty query arrays", async () => {
    const r = await runExternalRealitySearchProvider({
      queries: [],
      maxResultsPerQuery: 3,
      recencyDays: 7,
      envOverride: { PERPLEXITY_API_KEY: "k" },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("error");
    expect(r.reason).toBe("no_queries_provided");
  });
});

describe("P30.1 event normalization", () => {
  const baseResult = {
    title: "Velryba uvízla v Severním moři",
    url: "https://example.com/velryba-2026",
    snippet: "Záchranáři pracují na vyproštění velryby.",
    published_at: "2026-05-06",
    source_name: "example.com",
    provider: "perplexity",
    query: "velryba aktuální zpráva",
    fetched_at: new Date().toISOString(),
  };

  it("requires a real URL to normalize", async () => {
    await expect(
      normalizeExternalSearchResultToEvent(
        { ...baseResult, url: "not-a-url" },
        { partName: "Tundrupek", sensitivityKind: "animal_suffering" },
      ),
    ).rejects.toThrow(/normalize_requires_real_url/);
  });

  it("never auto-marks events as manual_verified or verified_multi_source", async () => {
    const ev = await normalizeExternalSearchResultToEvent(baseResult, {
      partName: "Tundrupek",
      sensitivityId: "sens-1",
      sensitivityKind: "animal_suffering",
      inferredEventType: "animal_suffering",
      aiSummarized: false,
    });
    expect(ev.verification_status).toBe("source_backed_unverified");
    expect(["manual_verified", "verified_multi_source", "verified"]).not.toContain(
      ev.verification_status,
    );
  });

  it("marks AI-summarized normalization as ai_unverified", async () => {
    const ev = await normalizeExternalSearchResultToEvent(baseResult, {
      partName: "Tundrupek",
      sensitivityKind: "animal_suffering",
      aiSummarized: true,
    });
    expect(ev.verification_status).toBe("ai_unverified");
  });

  it("dedupe_key is stable for same (provider, url, part, sensitivity)", async () => {
    const a = await normalizeExternalSearchResultToEvent(baseResult, {
      partName: "Tundrupek",
      sensitivityKind: "animal_suffering",
    });
    const b = await normalizeExternalSearchResultToEvent(baseResult, {
      partName: "Tundrupek",
      sensitivityKind: "animal_suffering",
    });
    expect(a.dedupe_key).toBe(b.dedupe_key);
    expect(a.dedupe_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("semantic_dedupe_key is stable across small title variations", async () => {
    const a = await normalizeExternalSearchResultToEvent(
      { ...baseResult, title: "Velryba uvízla v Severním moři!" },
      { partName: "Tundrupek", sensitivityKind: "animal_suffering" },
    );
    const b = await normalizeExternalSearchResultToEvent(
      { ...baseResult, title: "  Velryba uvízla v Severním moři  " },
      { partName: "Tundrupek", sensitivityKind: "animal_suffering" },
    );
    expect(a.semantic_dedupe_key).toBe(b.semantic_dedupe_key);
  });

  it("preserves source_url, provider, search_query, fetched_at", async () => {
    const ev = await normalizeExternalSearchResultToEvent(baseResult, {
      partName: "Tundrupek",
      sensitivityKind: "animal_suffering",
    });
    expect(ev.source_url).toBe(baseResult.url);
    expect(ev.provider).toBe(baseResult.provider);
    expect(ev.search_query).toBe(baseResult.query);
    expect(ev.fetched_at).toBe(baseResult.fetched_at);
  });
});

describe("P30.1 source-truth invariants (no fake events)", () => {
  it("provider not_configured → zero results, zero events would be created", async () => {
    const r = await runExternalRealitySearchProvider({
      queries: ["x"],
      maxResultsPerQuery: 3,
      recencyDays: 7,
      envOverride: {},
    });
    expect(r.results).toHaveLength(0);
    // The sentinel must not call normalize() at all in this branch — if it did
    // ever try, normalize would still refuse without a real URL.
    await expect(
      normalizeExternalSearchResultToEvent(
        {
          title: "fake",
          url: "",
          provider: "none",
          query: "x",
          fetched_at: new Date().toISOString(),
        },
        { partName: null },
      ),
    ).rejects.toThrow();
  });
});

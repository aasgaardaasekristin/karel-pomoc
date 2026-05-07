/**
 * P30.1 — External Reality Search Provider abstraction (fail-closed).
 *
 * This module is the ONLY supported entrypoint for "internet watch" search
 * requests originating from the karel-external-reality-sentinel pipeline.
 *
 * HARD RULES:
 *   - Never invent a URL.
 *   - Every returned ExternalSearchResult MUST carry a real `url` (http/https).
 *   - If no provider is configured, return ok=false / status="not_configured".
 *   - If a provider call fails, return ok=false / status="error".
 *   - LLMs may NEVER fabricate "current news" — only summarize source-backed
 *     snippets, and even then the consumer must mark them as ai_unverified.
 */

export type ExternalSearchProviderStatus =
  | "configured"
  | "not_configured"
  | "disabled"
  | "error";

export interface ExternalSearchResult {
  title: string;
  url: string;
  snippet?: string;
  published_at?: string | null;
  source_name?: string | null;
  provider: string;
  query: string;
  fetched_at: string;
}

export interface ExternalSearchProviderResponse {
  ok: boolean;
  status: ExternalSearchProviderStatus;
  provider: string | null;
  reason?: string;
  queries: string[];
  results: ExternalSearchResult[];
  raw_error?: string;
}

export interface RunExternalSearchInput {
  queries: string[];
  maxResultsPerQuery: number;
  recencyDays: number;
  /** Test seam: override env lookup. */
  envOverride?: Record<string, string | undefined>;
  /** Test seam: stub fetch. */
  fetchOverride?: typeof fetch;
}

function getEnv(name: string, override?: Record<string, string | undefined>) {
  if (override) return override[name];
  try {
    // deno-lint-ignore no-explicit-any
    return (globalThis as any).Deno?.env?.get?.(name) ?? undefined;
  } catch {
    return undefined;
  }
}

export function detectProviderFromEnv(
  override?: Record<string, string | undefined>,
): { provider: "perplexity" | "firecrawl" | null; key: string | null } {
  const perp = getEnv("PERPLEXITY_API_KEY", override);
  if (perp) return { provider: "perplexity", key: perp };
  const fc = getEnv("FIRECRAWL_API_KEY", override);
  if (fc) return { provider: "firecrawl", key: fc };
  return { provider: null, key: null };
}

function recencyFilter(days: number): string {
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  if (days <= 31) return "month";
  return "year";
}

function isRealUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\/[^\s]+$/i.test(value);
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

export async function runExternalRealitySearchProvider(
  input: RunExternalSearchInput,
): Promise<ExternalSearchProviderResponse> {
  const queries = (input.queries ?? [])
    .map((q) => String(q ?? "").trim())
    .filter((q) => q.length > 0);
  const fetchedAt = new Date().toISOString();
  const fetcher = input.fetchOverride ?? fetch;

  if (queries.length === 0) {
    return {
      ok: false,
      status: "error",
      provider: null,
      reason: "no_queries_provided",
      queries: [],
      results: [],
    };
  }

  const detected = detectProviderFromEnv(input.envOverride);
  if (!detected.provider || !detected.key) {
    return {
      ok: false,
      status: "not_configured",
      provider: null,
      reason: "no_external_search_provider_configured",
      queries,
      results: [],
    };
  }

  const out: ExternalSearchResult[] = [];
  const errors: string[] = [];
  const recency = recencyFilter(input.recencyDays);
  const limit = Math.max(1, Math.min(10, input.maxResultsPerQuery | 0 || 3));

  for (const query of queries) {
    try {
      if (detected.provider === "perplexity") {
        const resp = await fetcher("https://api.perplexity.ai/search", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${detected.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query, max_results: limit, recency }),
        });
        if (!resp.ok) {
          // Perplexity /search may not be enabled on every tier — fall back to
          // chat/completions with citations.
          const fb = await fetcher(
            "https://api.perplexity.ai/chat/completions",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${detected.key}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: "sonar",
                messages: [
                  {
                    role: "system",
                    content:
                      "Return only short factual web search results that you can back with a real URL citation. Never invent URLs.",
                  },
                  {
                    role: "user",
                    content:
                      `Web search query: ${query}. Return the top ${limit} most recent results from the last ${input.recencyDays} days. For each, give title and one-sentence snippet. Do not fabricate URLs.`,
                  },
                ],
                search_recency_filter: recency,
                max_tokens: 800,
              }),
            },
          );
          if (!fb.ok) {
            const txt = await fb.text();
            errors.push(`perplexity_${fb.status}:${txt.slice(0, 120)}`);
            continue;
          }
          const data = await fb.json();
          const citations: string[] = Array.isArray(data?.citations)
            ? data.citations
            : [];
          const content: string = String(
            data?.choices?.[0]?.message?.content ?? "",
          );
          // Map citations into structured results; titles/snippets best-effort
          // from the AI text, but URL is authoritative.
          const lines = content.split(/\n+/).filter((l) => l.trim().length > 0);
          for (let i = 0; i < citations.length && i < limit; i++) {
            const url = citations[i];
            if (!isRealUrl(url)) continue;
            const titleLine = lines[i] ?? "";
            const cleaned = titleLine.replace(/^[-*\d.\s]+/, "").trim();
            out.push({
              title: cleaned.split(/[.:—-]/)[0].slice(0, 160) ||
                safeHostname(url) || url,
              url,
              snippet: cleaned.slice(0, 280) || undefined,
              published_at: null,
              source_name: safeHostname(url),
              provider: "perplexity",
              query,
              fetched_at: fetchedAt,
            });
          }
        } else {
          const data = await resp.json();
          const items: any[] = Array.isArray(data?.results)
            ? data.results
            : Array.isArray(data?.data)
            ? data.data
            : [];
          for (const it of items.slice(0, limit)) {
            const url = it?.url ?? it?.link;
            if (!isRealUrl(url)) continue;
            out.push({
              title: String(it?.title ?? safeHostname(url) ?? url).slice(
                0,
                240,
              ),
              url,
              snippet: it?.snippet ?? it?.description ?? undefined,
              published_at: it?.published_at ?? it?.date ?? null,
              source_name: safeHostname(url),
              provider: "perplexity",
              query,
              fetched_at: fetchedAt,
            });
          }
        }
      } else if (detected.provider === "firecrawl") {
        const resp = await fetcher("https://api.firecrawl.dev/v2/search", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${detected.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query, limit, tbs: `qdr:${recency[0]}` }),
        });
        if (!resp.ok) {
          const txt = await resp.text();
          errors.push(`firecrawl_${resp.status}:${txt.slice(0, 120)}`);
          continue;
        }
        const data = await resp.json();
        const items: any[] = Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.web?.results)
          ? data.web.results
          : [];
        for (const it of items.slice(0, limit)) {
          const url = it?.url;
          if (!isRealUrl(url)) continue;
          out.push({
            title: String(it?.title ?? safeHostname(url) ?? url).slice(0, 240),
            url,
            snippet: it?.description ?? it?.snippet ?? undefined,
            published_at: it?.publishedDate ?? null,
            source_name: safeHostname(url),
            provider: "firecrawl",
            query,
            fetched_at: fetchedAt,
          });
        }
      }
    } catch (e) {
      errors.push(`exception:${(e as Error).message?.slice(0, 120)}`);
    }
  }

  // Final URL invariant: every result must have a real http(s) url.
  const cleaned = out.filter((r) => isRealUrl(r.url));

  if (errors.length > 0 && cleaned.length === 0) {
    return {
      ok: false,
      status: "error",
      provider: detected.provider,
      reason: "provider_error",
      queries,
      results: [],
      raw_error: errors.join(" | ").slice(0, 500),
    };
  }

  return {
    ok: true,
    status: "configured",
    provider: detected.provider,
    queries,
    results: cleaned,
    ...(errors.length > 0
      ? { raw_error: errors.join(" | ").slice(0, 500) }
      : {}),
  };
}

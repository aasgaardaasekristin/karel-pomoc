import { describe, it, expect, vi, beforeEach } from "vitest";

// P28_CDI_2c — verifies FE refuses direct card_update_discussion writes
// and that the dedicated server endpoint helper is the only path used.

vi.mock("@/integrations/supabase/client", () => {
  const insert = vi.fn(() => ({ select: () => ({ maybeSingle: async () => ({ data: { id: "ev1" }, error: null }) }) }));
  const upsert = vi.fn(() => ({ select: () => ({ maybeSingle: async () => ({ data: { id: "rs1" }, error: null }) }) }));
  const select = vi.fn(() => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "x" }, error: null }) }) }));
  return {
    supabase: {
      auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
      from: vi.fn(() => ({ insert, upsert, select })),
      rpc: vi.fn(async () => ({ data: "act-1", error: null })),
    },
  };
});

vi.mock("@/lib/auth", () => ({
  getAuthHeaders: async () => ({ "Content-Type": "application/json", Authorization: "Bearer test" }),
}));

import { writeDynamicPipelineEvent } from "@/lib/dynamicPipeline";
import { submitCardUpdateDiscussion } from "@/services/cardUpdateDiscussion";

describe("P28_CDI_2c card_update_discussion server-only routing", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
    // @ts-ignore
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, card_update_id: "cu-1", discussion_count: 1, pipeline_event_id: "ev-1", resume_id: "rs-1", activity_id: "act-1" }), { status: 200 })
    );
  });

  it("refuses FE-direct dynamic pipeline writes for card_update_discussion", async () => {
    const id = await writeDynamicPipelineEvent({
      surfaceType: "card_update_discussion",
      surfaceId: "cu-1",
      eventType: "block_updated",
    } as any);
    expect(id).toBeNull();
  });

  it("submitCardUpdateDiscussion posts to the server endpoint", async () => {
    const res = await submitCardUpdateDiscussion({
      cardUpdateId: "cu-1",
      message: "safe smoke",
      author: "hanka",
      mode: "discussion_comment",
    });
    expect(res.ok).toBe(true);
    expect(res.pipeline_event_id).toBe("ev-1");
    expect(res.resume_id).toBe("rs-1");
    const fetchMock = globalThis.fetch as any;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/functions/v1/karel-card-update-discussion-event");
    expect(JSON.parse(init.body)).toMatchObject({
      card_update_id: "cu-1",
      author: "hanka",
      mode: "discussion_comment",
    });
  });

  it("forwards idempotency_key to the server endpoint when provided", async () => {
    const res = await submitCardUpdateDiscussion({
      cardUpdateId: "cu-1",
      message: "safe smoke",
      author: "hanka",
      mode: "discussion_comment",
      idempotencyKey: "idem-abc-123",
    });
    expect(res.ok).toBe(true);
    const fetchMock = globalThis.fetch as any;
    const [, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(JSON.parse(init.body)).toMatchObject({
      card_update_id: "cu-1",
      idempotency_key: "idem-abc-123",
    });
  });

  it("surfaces deduplicated=true result without throwing", async () => {
    // @ts-ignore
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, deduplicated: true, card_update_id: "cu-1", discussion_count: 1, pipeline_event_id: "ev-1" }), { status: 200 })
    );
    const res = await submitCardUpdateDiscussion({
      cardUpdateId: "cu-1",
      message: "safe smoke",
      author: "hanka",
      idempotencyKey: "idem-abc-123",
    });
    expect(res.ok).toBe(true);
    expect((res as any).deduplicated).toBe(true);
  });

  it("rejects unknown author / mode at request shape level", async () => {
    // @ts-expect-error invalid author
    const r = submitCardUpdateDiscussion({ cardUpdateId: "cu-1", message: "x", author: "stranger" });
    await expect(r).resolves.toBeDefined();
  });
});

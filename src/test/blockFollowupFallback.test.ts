/**
 * Client fallback contract test
 * -----------------------------
 * Verifies that when karel-block-followup returns the documented
 * `fallback: true` envelope, downstream consumers must:
 *   - NOT throw
 *   - call toast.warning (not toast.error)
 *   - keep `done = false` and not advance the block
 *   - not produce a closeMsg
 *
 * We test the contract by mirroring the consumer logic in
 * BlockDiagnosticChat.tsx (handleFollowup, lines 240-291) against a
 * mocked invoke result. This is a compile-time bound contract: if the
 * client component diverges from this logic, the test must be updated
 * jointly.
 */
import { describe, it, expect, vi } from "vitest";

type FollowupResponse = {
  data: any;
  error: { message: string } | null;
};

type FakeToast = {
  warning: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

interface ConsumerState {
  turnsAppended: Array<{ from: string; text: string }>;
  done: boolean;
  closeMsg: string | null;
  protocolPatchApplied: any;
  threwOverlay: boolean;
}

function consumeFollowup(resp: FollowupResponse, toast: FakeToast): ConsumerState {
  const state: ConsumerState = {
    turnsAppended: [],
    done: false,
    closeMsg: null,
    protocolPatchApplied: null,
    threwOverlay: false,
  };
  try {
    const { data, error } = resp;
    if (error) throw new Error(error.message || "invoke failed");
    const isFallback = !!(data as any)?.fallback;
    if ((data as any)?.error && !isFallback) throw new Error(String((data as any).error));
    const karelText = String((data as any)?.karel_text ?? "").trim();
    if (!karelText) throw new Error("Karel nevrátil žádný text.");
    state.turnsAppended.push({ from: "karel", text: karelText });
    if ((data as any)?.state_patch) state.protocolPatchApplied = (data as any).state_patch;
    state.done = !!(data as any)?.done;
    if (state.done) {
      const cm = (data as any)?.suggested_close_message;
      state.closeMsg = typeof cm === "string" && cm.trim() ? cm.trim() : "Karel má dost dat.";
    }
    if (isFallback) {
      const reason = String((data as any)?.fallback_reason ?? "");
      toast.warning(`Karel teď použil bezpečnou náhradní odpověď (${reason || "AI nevrátila výsledek"}).`);
    }
  } catch (e: any) {
    state.threwOverlay = true;
    toast.error(`Karel teď nezvládl reagovat: ${e?.message ?? String(e)}`);
  }
  return state;
}

describe("karel-block-followup client fallback contract", () => {
  it("AI_EMPTY_RESPONSE fallback envelope: warning, no overlay, no advance", () => {
    const toast: FakeToast = { warning: vi.fn(), error: vi.fn() };
    const out = consumeFollowup({
      data: {
        fallback: true,
        fallback_reason: "ai_response_empty",
        karel_text: "Hani, AI teď nevrátila odpověď. Jsme stále v bloku „Integrace a měkké ukončení\".",
        phase: "closure",
        state_patch: { phase: "closure", preserve_current_block: true },
        done: false,
        missing_artifacts: [],
      },
      error: null,
    }, toast);
    expect(out.threwOverlay).toBe(false);
    expect(toast.warning).toHaveBeenCalledOnce();
    expect(toast.error).not.toHaveBeenCalled();
    expect(out.turnsAppended).toHaveLength(1);
    expect(out.turnsAppended[0].from).toBe("karel");
    expect(out.done).toBe(false);
    expect(out.closeMsg).toBeNull();
    expect(out.protocolPatchApplied).toMatchObject({ preserve_current_block: true });
  });

  it("AI_INVALID_JSON fallback envelope: same contract", () => {
    const toast: FakeToast = { warning: vi.fn(), error: vi.fn() };
    const out = consumeFollowup({
      data: {
        fallback: true,
        fallback_reason: "ai_response_not_json",
        karel_text: "Bezpečná fallback odpověď.",
        phase: "closure",
        state_patch: { phase: "closure" },
        done: false,
      },
      error: null,
    }, toast);
    expect(out.threwOverlay).toBe(false);
    expect(toast.warning).toHaveBeenCalledOnce();
    expect(toast.error).not.toHaveBeenCalled();
    expect(out.done).toBe(false);
    expect(out.closeMsg).toBeNull();
  });

  it("normal AI response: no toast, advances state normally", () => {
    const toast: FakeToast = { warning: vi.fn(), error: vi.fn() };
    const out = consumeFollowup({
      data: {
        karel_text: "Pokračuji podle plánu.",
        phase: "running",
        state_patch: { phase: "running" },
        done: false,
      },
      error: null,
    }, toast);
    expect(out.threwOverlay).toBe(false);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(out.turnsAppended).toHaveLength(1);
  });

  it("hard error (no fallback flag) does throw to overlay path", () => {
    const toast: FakeToast = { warning: vi.fn(), error: vi.fn() };
    const out = consumeFollowup({
      data: { error: "some_unrecoverable_error" },
      error: null,
    }, toast);
    expect(out.threwOverlay).toBe(true);
    expect(toast.error).toHaveBeenCalledOnce();
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

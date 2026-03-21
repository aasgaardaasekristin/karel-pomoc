import { describe, it, expect } from "vitest";
import {
  saveMessages,
  loadMessages,
  clearMessages,
  handleApiError,
  getRandomCastGreeting,
  parseSSEStream,
  WELCOME_MESSAGES,
  STORAGE_KEY_PREFIX,
  ACTIVE_MODE_KEY,
  DID_DOCS_LOADED_KEY,
  DID_SESSION_ID_KEY,
  HANA_PIN_KEY,
} from "@/lib/chatHelpers";

describe("chatHelpers", () => {
  describe("saveMessages / loadMessages / clearMessages", () => {
    it("round-trips messages correctly", () => {
      const msgs = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ];
      saveMessages("test-mode", msgs);
      const loaded = loadMessages("test-mode");
      expect(loaded).toEqual(msgs);

      clearMessages("test-mode");
      expect(loadMessages("test-mode")).toBeNull();
    });

    it("returns null for wrong mode tag", () => {
      saveMessages("modeA", [{ role: "user", content: "x" }]);
      // Manually corrupt
      localStorage.setItem(
        `${STORAGE_KEY_PREFIX}modeB`,
        JSON.stringify({ _mode: "modeA", messages: [{ role: "user", content: "x" }] })
      );
      expect(loadMessages("modeB")).toBeNull();
      clearMessages("modeA");
    });

    it("returns null for empty storage", () => {
      expect(loadMessages("nonexistent")).toBeNull();
    });
  });

  describe("handleApiError", () => {
    it("throws rate limit error for 429", () => {
      expect(() => handleApiError({ status: 429 } as Response)).toThrow("přetížený");
    });

    it("throws credits error for 402", () => {
      expect(() => handleApiError({ status: 402 } as Response)).toThrow("kredity");
    });

    it("throws generic error for other statuses", () => {
      expect(() => handleApiError({ status: 500 } as Response)).toThrow("Něco se pokazilo");
    });
  });

  describe("getRandomCastGreeting", () => {
    it("returns a non-empty string", () => {
      const greeting = getRandomCastGreeting();
      expect(typeof greeting).toBe("string");
      expect(greeting.length).toBeGreaterThan(5);
    });

    it("avoids repeating last greeting", () => {
      // Run several times — at least one should differ
      const results = new Set<string>();
      for (let i = 0; i < 20; i++) {
        results.add(getRandomCastGreeting());
      }
      expect(results.size).toBeGreaterThan(1);
    });
  });

  describe("parseSSEStream", () => {
    it("parses SSE chunks and returns full content", async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        "data: [DONE]\n\n",
      ];

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });

      const updates: string[] = [];
      const result = await parseSSEStream(stream, (content) => {
        updates.push(content);
      });

      expect(result).toBe("Hello world");
      expect(updates).toEqual(["Hello", "Hello world"]);
    });

    it("handles empty stream", async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });

      const result = await parseSSEStream(stream, () => {});
      expect(result).toBe("");
    });

    it("ignores comment lines and empty lines", async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(": comment\n\n"));
          controller.enqueue(encoder.encode("\n"));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      const result = await parseSSEStream(stream, () => {});
      expect(result).toBe("ok");
    });
  });

  describe("WELCOME_MESSAGES", () => {
    it("has entries for all modes", () => {
      expect(WELCOME_MESSAGES.debrief).toBeTruthy();
      expect(WELCOME_MESSAGES.supervision).toBeTruthy();
      expect(WELCOME_MESSAGES.safety).toBeTruthy();
      expect(WELCOME_MESSAGES.research).toBeTruthy();
      expect(WELCOME_MESSAGES.childcare).toBe("");
    });
  });

  describe("exported constants", () => {
    it("exports expected constant values", () => {
      expect(STORAGE_KEY_PREFIX).toBe("karel_chat_");
      expect(ACTIVE_MODE_KEY).toBe("karel_active_mode");
      expect(DID_DOCS_LOADED_KEY).toBe("karel_did_docs_loaded");
      expect(DID_SESSION_ID_KEY).toBe("karel_did_session_id");
      expect(HANA_PIN_KEY).toBe("karel_hana_pin_verified");
    });
  });
});

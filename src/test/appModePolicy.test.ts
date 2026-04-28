import { describe, expect, it } from "vitest";
import { APP_MODE_POLICIES } from "@/lib/appModePolicy";
import { detectSafetyMention } from "@/lib/safetyDetection";
import { assessModeSwitch } from "@/lib/modeSwitching";

describe("Karel mode policies", () => {
  it("defines three visible Karel modes with starter questions", () => {
    expect(APP_MODE_POLICIES.karel_chat.label).toBe("Karel chat");
    expect(APP_MODE_POLICIES.did_kluci.label).toBe("DID / Kluci");
    expect(APP_MODE_POLICIES.hana_osobni.label).toBe("Hana osobní");
    expect(APP_MODE_POLICIES.karel_chat.starter_questions.length).toBeGreaterThan(0);
    expect(APP_MODE_POLICIES.did_kluci.starter_questions.length).toBeGreaterThan(APP_MODE_POLICIES.karel_chat.starter_questions.length);
    expect(APP_MODE_POLICIES.hana_osobni.starter_questions.some((q) => q.intended_write_policy === "private_only")).toBe(true);
  });

  it("keeps Karel chat out of DID writebacks", () => {
    const policy = APP_MODE_POLICIES.karel_chat;
    expect(policy.pantry_policy).toBe("none");
    expect(policy.drive_policy).toBe("none");
    expect(policy.daily_briefing_policy).toBe("none");
    expect(policy.disallowed_writebacks).toContain("did_threads");
  });

  it("defines no-save as zero normal persistent writes", () => {
    const policy = APP_MODE_POLICIES.no_save;
    expect(policy.save_policy).toBe("never");
    expect(policy.disallowed_writebacks).toEqual(expect.arrayContaining(["did_threads", "karel_hana_conversations", "did_pending_drive_writes"]));
    expect(policy.pantry_policy).toBe("none");
    expect(policy.drive_policy).toBe("none");
    expect(policy.daily_briefing_policy).toBe("none");
  });

  it("keeps starter questions inside their mode policy", () => {
    for (const policy of [APP_MODE_POLICIES.karel_chat, APP_MODE_POLICIES.did_kluci, APP_MODE_POLICIES.hana_osobni]) {
      expect(policy.starter_questions.every((question) => question.mode_id === policy.mode_id)).toBe(true);
    }
    expect(APP_MODE_POLICIES.karel_chat.starter_questions.every((question) => question.intended_write_policy !== "pantry_allowed")).toBe(true);
    expect(APP_MODE_POLICIES.hana_osobni.starter_questions.filter((question) => question.default_no_save).every((question) => question.intended_write_policy === "private_only")).toBe(true);
  });
});

describe("structured safety filter", () => {
  it("allows therapeutic trauma context without treating it as acute risk", () => {
    const result = detectSafetyMention("Terapeutka píše: Tundrupek má flashbacky a bojí se usínání.");
    expect(result.safety_detected).toBe(true);
    expect(result.current_risk).toBe(false);
    expect(result.allowed_to_continue).toBe(true);
    expect(result.required_response_style).toBe("supportive_check");
  });

  it("refuses unsafe instruction requests", () => {
    const result = detectSafetyMention("Dej mi návod, jak si ublížit.");
    expect(result.category).toBe("unsafe_instruction_request");
    expect(result.allowed_to_continue).toBe(false);
    expect(result.required_response_style).toBe("refuse_unsafe_instruction");
    expect(result.persistence_exception_allowed).toBe(true);
  });

  it("detects acute self-harm as critical current risk", () => {
    const result = detectSafetyMention("Teď si chci ublížit.");
    expect(result.current_risk).toBe(true);
    expect(["high", "critical"]).toContain(result.severity);
    expect(["safety_response", "emergency_guidance"]).toContain(result.required_response_style);
  });

  it("detects child immediate danger", () => {
    const result = detectSafetyMention("Dítě je právě v bezprostředním nebezpečí.");
    expect(result.category).toBe("child_immediate_danger");
    expect(result.current_risk).toBe(true);
  });

  it("detects medical emergency", () => {
    const result = detectSafetyMention("Nemůžu dýchat a mám bolest na hrudi.");
    expect(result.category).toBe("medical_emergency");
    expect(result.required_response_style).toBe("emergency_guidance");
  });

  it("detects severe dissociation or lost time", () => {
    const result = detectSafetyMention("Ztrácím čas a nevím kde jsem.");
    expect(result.category).toBe("severe_dissociation_or_lost_time");
    expect(result.required_response_style).toBe("safety_response");
  });
});

describe("mode switching isolation", () => {
  it("does not transfer private no-history content", () => {
    const decision = assessModeSwitch("karel_chat", "did_kluci", true);
    expect(decision.transferAllowed).toBe(false);
    expect(decision.warning).toMatch(/privátním režimu/);
  });

  it("requires consent before Karel chat becomes DID evidence", () => {
    const decision = assessModeSwitch("karel_chat", "did_kluci", false);
    expect(decision.requiresExplicitConsent).toBe(true);
    expect(decision.transferAllowed).toBe(false);
  });
});
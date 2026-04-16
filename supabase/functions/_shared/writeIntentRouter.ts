/**
 * writeIntentRouter.ts — Phase 3
 *
 * Determines where each piece of information should be written,
 * based on its type, sensitivity, and target entity.
 *
 * EXTENDS (not replaces) informationClassifier.ts resolveTarget().
 * This layer adds Phase 3 rules:
 * - sensitivity-based routing
 * - dormant vs active child card distinction
 * - therapist private profiling docs
 * - structured summary enforcement
 *
 * RULES:
 * - Every write must have a rationale
 * - Every write must be a structured summary, NEVER raw transcript
 * - Private therapist info → only profiling docs or Karel memory
 * - Secret Karel-only → only Karel private memory
 * - Dormant child facts → dormant child card, not active
 */

import type {
  WriteIntent,
  WriteDestination,
  InformationSensitivity,
  ObservationType,
  EntityActivityStatus,
} from "./phase3Types.ts";

// ── Core Router ──

export interface WriteRoutingInput {
  observationType: ObservationType;
  sensitivity: InformationSensitivity;
  entityName?: string;
  entityActivityStatus?: EntityActivityStatus;
  therapist?: "hanka" | "kata";
  fact: string;
  rationale: string;
}

/**
 * Route a classified observation to its correct write destination.
 */
export function routeWriteIntent(input: WriteRoutingInput): WriteIntent {
  const { observationType, sensitivity, entityName, entityActivityStatus, therapist } = input;

  // ── Secret Karel-only: never goes anywhere public ──
  if (sensitivity === "secret_karel_only") {
    return {
      destination: "karel_private_memory",
      subject: entityName || therapist,
      content: input.fact,
      rationale: input.rationale,
      sensitivity,
      isStructuredSummary: true,
    };
  }

  // ── Therapist private: only profiling docs ──
  if (sensitivity === "therapist_private") {
    const dest: WriteDestination = therapist === "kata"
      ? "therapist_profile_kata"
      : "therapist_profile_hanka";
    return {
      destination: dest,
      subject: therapist,
      content: input.fact,
      rationale: input.rationale,
      sensitivity,
      isStructuredSummary: true,
    };
  }

  // ── DID child observations ──
  if (observationType === "direct_activity" && entityName) {
    return {
      destination: "child_card",
      subject: entityName,
      content: input.fact,
      rationale: input.rationale,
      sensitivity,
      isStructuredSummary: true,
    };
  }

  if (observationType === "dormant_profile_fact" && entityName) {
    return {
      destination: "dormant_child_card",
      subject: entityName,
      content: input.fact,
      rationale: input.rationale,
      sensitivity,
      isStructuredSummary: true,
    };
  }

  if (observationType === "historical_fact" && entityName) {
    const dest: WriteDestination = entityActivityStatus === "dormant"
      ? "dormant_child_card"
      : "child_card";
    return {
      destination: dest,
      subject: entityName,
      content: input.fact,
      rationale: input.rationale,
      sensitivity,
      isStructuredSummary: true,
    };
  }

  if (observationType === "therapist_mention" && entityName) {
    // Therapist mentioned a child → write to child card but mark as mention
    const dest: WriteDestination = entityActivityStatus === "dormant"
      ? "dormant_child_card"
      : "child_card";
    return {
      destination: dest,
      subject: entityName,
      content: `Zmínka terapeutkou: ${input.fact}`,
      rationale: input.rationale,
      sensitivity,
      isStructuredSummary: true,
    };
  }

  // ── Operational constraints → planning docs ──
  if (observationType === "operational_constraint") {
    return {
      destination: "plan_05A",
      subject: entityName || therapist,
      content: input.fact,
      rationale: input.rationale,
      sensitivity,
      isStructuredSummary: true,
    };
  }

  // ── Private therapist signal ──
  if (observationType === "private_therapist_signal") {
    const dest: WriteDestination = therapist === "kata"
      ? "therapist_profile_kata"
      : therapist === "hanka"
        ? "therapist_profile_hanka"
        : "karel_private_memory";
    return {
      destination: dest,
      subject: therapist,
      content: input.fact,
      rationale: input.rationale,
      sensitivity: "therapist_private",
      isStructuredSummary: true,
    };
  }

  // ── Activation candidate → strategic plan ──
  if (observationType === "activation_candidate") {
    return {
      destination: "plan_05B",
      subject: entityName,
      content: input.fact,
      rationale: input.rationale,
      sensitivity,
      isStructuredSummary: true,
    };
  }

  // ── Unknown / needs verification → Karel private for now ──
  if (observationType === "unknown_needs_verification") {
    return {
      destination: "karel_private_memory",
      subject: entityName || therapist,
      content: input.fact,
      rationale: `Neověřená informace: ${input.rationale}`,
      sensitivity: "secret_karel_only",
      isStructuredSummary: true,
    };
  }

  // Fallback
  return {
    destination: "plan_05A",
    subject: entityName,
    content: input.fact,
    rationale: input.rationale,
    sensitivity: sensitivity || "team_operational",
    isStructuredSummary: true,
  };
}

/**
 * Validate that a write intent doesn't violate sensitivity rules.
 * Returns error message if invalid, null if OK.
 */
export function validateWriteIntent(intent: WriteIntent): string | null {
  // Private content must only go to private destinations
  if (intent.sensitivity === "secret_karel_only" && intent.destination !== "karel_private_memory") {
    return `Secret Karel-only content cannot go to ${intent.destination}`;
  }

  if (intent.sensitivity === "therapist_private") {
    const allowedDests: WriteDestination[] = [
      "therapist_profile_hanka",
      "therapist_profile_kata",
      "karel_private_memory",
    ];
    if (!allowedDests.includes(intent.destination)) {
      return `Therapist private content cannot go to ${intent.destination}`;
    }
  }

  // Must be structured summary
  if (!intent.isStructuredSummary) {
    return "Write intent must be a structured summary, not raw transcript";
  }

  return null;
}

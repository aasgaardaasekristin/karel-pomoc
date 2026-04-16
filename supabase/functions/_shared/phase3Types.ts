/**
 * phase3Types.ts — Phase 3 Data Contracts
 *
 * Shared type definitions for the daily orchestration pipeline:
 * entity resolution, observation classification, activity guards,
 * task feasibility, write routing, and session planning.
 *
 * These types EXTEND (not replace) existing infrastructure:
 * - entityResolution.ts (entity kinds)
 * - informationClassifier.ts (privacy, routing)
 * - observations.ts (evidence levels)
 */

// ── Entity Activity Status ──

export type EntityActivityStatus =
  | "active_in_body"         // dítě je "dole v těle", přímo komunikuje
  | "active_inner_world"     // dítě je aktivní "nahoře", ale ne v těle
  | "mentioned_by_therapist" // terapeutka o dítěti mluvila, ale dítě nebylo přítomno
  | "dormant"                // spící, dlouhodobě neaktivní
  | "unknown";               // nedostatek dat pro klasifikaci

export interface EntityActivityAssessment {
  entityName: string;
  entityKind: "did_child" | "therapist" | "biological_person" | "animal" | "other";
  activityStatus: EntityActivityStatus;
  lastDirectActivity: string | null;  // ISO date of last sub_mode="cast" thread
  lastMentionedAt: string | null;     // ISO date of last therapist mention
  daysSinceDirectContact: number | null;
  evidenceSources: string[];          // thread IDs, session IDs backing this assessment
  canReceiveDirectTask: boolean;
  canReceiveMonitoringTask: boolean;
  canReceiveCampaignPlan: boolean;
  reasons: string[];
}

// ── Observation Classification (extends existing ObservationParams) ──

export type ObservationType =
  | "direct_activity"            // dítě přímo mluvilo (sub_mode=cast)
  | "therapist_mention"          // terapeutka o dítěti hovořila
  | "historical_fact"            // historický údaj, ne aktuální stav
  | "dormant_profile_fact"       // informace o spícím dítěti
  | "operational_constraint"     // omezení ovlivňující plánování
  | "private_therapist_signal"   // intimní/soukromé téma terapeutky
  | "activation_candidate"       // signál možného probuzení spícího dítěte
  | "unknown_needs_verification"; // nedostatek kontextu pro klasifikaci

export interface ClassifiedObservation {
  sourceThread: string;
  sourceMode: string;
  sourceAt: string;
  speaker: string;
  aboutEntities: string[];      // entity names
  observationType: ObservationType;
  fact: string;
  confidence: number;
  sensitivity: InformationSensitivity;
}

// ── Information Sensitivity ──

export type InformationSensitivity =
  | "team_operational"      // může jít do týmových výstupů, dashboardu, úkolů
  | "child_card_relevant"   // patří do karty dítěte
  | "therapist_private"     // jen do profilace terapeutky, ne do veřejných výstupů
  | "secret_karel_only";    // jen Karlova tajná paměť

// ── Write Intent ──

export type WriteDestination =
  | "child_card"
  | "dormant_child_card"
  | "plan_05A"
  | "plan_05B"
  | "therapist_profile_hanka"
  | "therapist_profile_kata"
  | "karel_private_memory"
  | "no_write";

export interface WriteIntent {
  destination: WriteDestination;
  subject?: string;
  content: string;
  rationale: string;
  sensitivity: InformationSensitivity;
  /** Must NEVER be a raw chat transcript */
  isStructuredSummary: boolean;
}

// ── Task Feasibility ──

export type TaskFeasibilityVerdict =
  | "allowed"                  // úkol je proveditelný
  | "blocked_dormant"          // dítě je spící, přímý úkol zakázán
  | "blocked_no_evidence"      // chybí důkaz přímé aktivity
  | "blocked_therapist_load"   // terapeutka je přetížená
  | "downgraded_to_monitoring" // přímý úkol nahrazen monitoringem
  | "downgraded_to_campaign";  // přímý úkol nahrazen plánovanou kampaní

export interface TaskFeasibilityResult {
  originalTask: string;
  assignedTo: string;
  targetEntity?: string;
  verdict: TaskFeasibilityVerdict;
  alternativeTask?: string;
  reasons: string[];
}

// ── Session Planning ──

export type SessionCandidateType = "today_required" | "planned_campaign";

export interface SessionCandidate {
  id: string;
  type: SessionCandidateType;
  subject: string;
  goal: string;
  therapist: "hanka" | "kata" | "both";
  channel: "in_person" | "video" | "chat" | "voice_message";
  allowedOnlyIf: string[];
  blockedIf: string[];
  questionsForTherapists: string[];
  rationale: string[];
  status: "draft" | "awaiting_input" | "agreed" | "scheduled";
}

// ── Therapist Circumstance ──

export interface TherapistCircumstance {
  therapist: "hanka" | "kata";
  detectedAt: string;
  circumstanceType:
    | "child_illness"        // nemoc biologického dítěte
    | "personal_fatigue"     // únava, přetížení
    | "family_stress"        // rodinná zátěž
    | "reduced_availability" // omezená dostupnost
    | "work_overload"        // pracovní tlak
    | "emotional_burden"     // emoční zátěž
    | "positive_energy";     // dobrá nálada, energie
  summary: string;
  operationalImpact: string;
  sensitivity: "therapist_private" | "team_operational";
  /** Source evidence (thread IDs, NOT raw content) */
  sources: string[];
}

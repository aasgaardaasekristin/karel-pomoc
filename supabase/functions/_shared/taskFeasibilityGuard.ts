/**
 * taskFeasibilityGuard.ts — Phase 3
 *
 * Validates that proposed tasks are actually feasible before
 * they are stored or displayed.
 *
 * RULES:
 * 1. A task targeting a dormant/inactive DID child MUST be downgraded:
 *    - "observe X's behavior" → blocked if X has no direct activity
 *    - Alternative: monitoring signals, card update, activation campaign
 *
 * 2. A task targeting an overloaded therapist should be flagged
 *    (not blocked, but sensitivity-tagged).
 *
 * 3. A task must never assume physical presence of Káťa with children.
 *
 * 4. A task must never verbalize private therapist information.
 *
 * Single responsibility: feasibility check + downgrade suggestions.
 */

import type {
  EntityActivityAssessment,
  TaskFeasibilityResult,
  TaskFeasibilityVerdict,
  TherapistCircumstance,
} from "./phase3Types.ts";

// ── Patterns indicating direct contact assumption ──

const DIRECT_CONTACT_PATTERNS = [
  /\bsle?duj\s+(projevy|chov[aá]n[ií]|reakce)\b/i,
  /\bpracuj\s+(s\s+n[ií]m|s\s+n[ií]|přímo)\b/i,
  /\bmluv\s+(s\s+n[ií]m|s\s+n[ií]|dnes)\b/i,
  /\bpozoruj\s+(jej[ií]|jeho|projevy)\b/i,
  /\bse?z?ení\s+s\s+/i,
  /\bzkus\s+(kontakt|rozhovor|sezení)\b/i,
];

// ── Patterns indicating Káťa physical presence assumption ──

const KATA_PHYSICAL_PATTERNS = [
  /\bsedni\s+si/i,
  /\bbuď\s+přítomn[aá]/i,
  /\bnech\s+(jim|mu|jí)\s+vzkaz\s+pod/i,
  /\bfyzick/i,
];

// ── Core Guard ──

export interface TaskProposal {
  taskText: string;
  assignedTo: string;
  targetEntity?: string;
}

/**
 * Check if a proposed task is feasible given the activity status
 * of its target entity and therapist circumstances.
 */
export function checkTaskFeasibility(
  proposal: TaskProposal,
  entityAssessment: EntityActivityAssessment | null,
  therapistCircumstances: TherapistCircumstance[],
): TaskFeasibilityResult {
  const reasons: string[] = [];

  // 1. Check if task assumes direct contact with inactive entity
  if (entityAssessment && entityAssessment.entityKind === "did_child") {
    const assumesDirectContact = DIRECT_CONTACT_PATTERNS.some(p => p.test(proposal.taskText));

    if (assumesDirectContact && !entityAssessment.canReceiveDirectTask) {
      if (entityAssessment.activityStatus === "dormant") {
        return {
          originalTask: proposal.taskText,
          assignedTo: proposal.assignedTo,
          targetEntity: proposal.targetEntity,
          verdict: "blocked_dormant",
          alternativeTask: suggestAlternative(proposal, entityAssessment),
          reasons: [
            `${entityAssessment.entityName} je spící/dormantní (${entityAssessment.daysSinceDirectContact ?? "?"} dní bez přímého kontaktu)`,
            "Přímý úkol nahrazen alternativou",
          ],
        };
      }

      if (entityAssessment.activityStatus === "mentioned_by_therapist") {
        return {
          originalTask: proposal.taskText,
          assignedTo: proposal.assignedTo,
          targetEntity: proposal.targetEntity,
          verdict: "blocked_no_evidence",
          alternativeTask: suggestAlternative(proposal, entityAssessment),
          reasons: [
            `${entityAssessment.entityName} — pouze zmínka terapeutkou, žádná přímá aktivita`,
            "Nelze předpokládat přítomnost",
          ],
        };
      }

      if (!entityAssessment.canReceiveDirectTask) {
        return {
          originalTask: proposal.taskText,
          assignedTo: proposal.assignedTo,
          targetEntity: proposal.targetEntity,
          verdict: "downgraded_to_monitoring",
          alternativeTask: `Sleduj signály přítomnosti ${entityAssessment.entityName}. Pokud se objeví přímý projev, napiš Karlovi.`,
          reasons: [
            `${entityAssessment.entityName} nemá potvrzenou přímou aktivitu`,
            "Úkol přeformulován na monitoring",
          ],
        };
      }
    }

    // Dormant entity → campaign only
    if (entityAssessment.canReceiveCampaignPlan && assumesDirectContact) {
      return {
        originalTask: proposal.taskText,
        assignedTo: proposal.assignedTo,
        targetEntity: proposal.targetEntity,
        verdict: "downgraded_to_campaign",
        alternativeTask: `Připrav aktivační strategii pro ${entityAssessment.entityName}: 1) doplň kartu, 2) formuluj hypotézu, 3) navrhni přípravné kroky pro poradu.`,
        reasons: [
          `${entityAssessment.entityName} je kandidát na aktivizaci, ne na přímý dnešní úkol`,
        ],
      };
    }
  }

  // 2. Check Káťa physical presence assumption
  if (proposal.assignedTo === "kata") {
    const assumesPhysical = KATA_PHYSICAL_PATTERNS.some(p => p.test(proposal.taskText));
    if (assumesPhysical) {
      return {
        originalTask: proposal.taskText,
        assignedTo: proposal.assignedTo,
        targetEntity: proposal.targetEntity,
        verdict: "blocked_therapist_load",
        alternativeTask: `Vzdáleně (chat/video/nahrávka): ${proposal.taskText.replace(/sedni si|buď přítomn|fyzick/gi, "vzdáleně")}`,
        reasons: [
          "Úkol předpokládá fyzickou přítomnost Káti — Káťa je 100 km daleko",
          "Přeformulováno na vzdálený kanál",
        ],
      };
    }
  }

  // 3. Check therapist load — overload CHANGES the verdict, not just reasons
  const relevantCircumstances = therapistCircumstances.filter(
    c => c.therapist === proposal.assignedTo
  );

  const hasHeavyLoad = relevantCircumstances.some(
    c => c.circumstanceType === "child_illness" ||
         c.circumstanceType === "work_overload" ||
         c.circumstanceType === "reduced_availability"
  );
  const hasMediumLoad = relevantCircumstances.some(
    c => c.circumstanceType === "personal_fatigue" ||
         c.circumstanceType === "family_stress"
  );

  if (hasHeavyLoad) {
    const otherTherapist = proposal.assignedTo === "hanka" ? "kata" : "hanka";
    return {
      originalTask: proposal.taskText,
      assignedTo: proposal.assignedTo,
      targetEntity: proposal.targetEntity,
      verdict: "blocked_therapist_load",
      alternativeTask: `Přeřadit na ${otherTherapist} nebo odložit: ${proposal.taskText}`,
      reasons: [
        `${proposal.assignedTo} má aktuálně vysokou zátěž (${relevantCircumstances.map(c => c.circumstanceType).join(", ")})`,
        "Úkol musí být přeřazen nebo odložen",
      ],
    };
  }

  if (hasMediumLoad) {
    // Downgrade scope but don't fully block
    reasons.push(`${proposal.assignedTo} má zvýšenou zátěž — úkol zjednodušen na minimum`);
    return {
      originalTask: proposal.taskText,
      assignedTo: proposal.assignedTo,
      targetEntity: proposal.targetEntity,
      verdict: "blocked_therapist_load",
      alternativeTask: `Zjednodušená verze: ${proposal.taskText} (jen nejnutnější část, bez časového tlaku)`,
      reasons,
    };
  }

  return {
    originalTask: proposal.taskText,
    assignedTo: proposal.assignedTo,
    targetEntity: proposal.targetEntity,
    verdict: "allowed",
    reasons: reasons.length > 0 ? reasons : ["Úkol je proveditelný"],
  };
}

// ── Alternative Suggestions ──

function suggestAlternative(
  proposal: TaskProposal,
  assessment: EntityActivityAssessment,
): string {
  const name = assessment.entityName;

  if (assessment.activityStatus === "dormant") {
    return `Doplň kartu ${name} o dostupné informace. Připrav aktivační hypotézu pro poradu.`;
  }

  if (assessment.activityStatus === "mentioned_by_therapist") {
    return `Sleduj signály přítomnosti ${name}. Zapiš zmínku terapeutky do karty. Pokud se ${name} přímo ozve, informuj Karla.`;
  }

  return `Monitoruj signály aktivity ${name}. Nepředpokládej přímý kontakt bez potvrzení.`;
}

/**
 * Batch-check an array of task proposals.
 * Returns only tasks that passed or were downgraded (with alternatives).
 */
export function filterFeasibleTasks(
  proposals: TaskProposal[],
  entityAssessments: Map<string, EntityActivityAssessment>,
  therapistCircumstances: TherapistCircumstance[],
): TaskFeasibilityResult[] {
  return proposals.map(proposal => {
    const assessment = proposal.targetEntity
      ? entityAssessments.get(proposal.targetEntity) ?? null
      : null;
    return checkTaskFeasibility(proposal, assessment, therapistCircumstances);
  });
}

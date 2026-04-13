/**
 * Information Classifier — FÁZE 2
 *
 * Centrální klasifikační model pro denní třídění informací.
 * Každý nový poznatek je klasifikován PŘED zápisem kamkoli.
 *
 * ZDROJE → CLASSIFIER → ROUTING → GOVERNANCE → DRIVE
 *
 * Classifier rozlišuje:
 *   1. KAM informace patří (destination)
 *   2. JAKÁ je její povaha (info_class)
 *   3. JAKÉ AKCE z ní plynou (generated_actions)
 *   4. Zda je citlivá (privacy_level) — a pokud ano, abstrahuje ji
 */

// ── Source Types ──

export type InformationSource =
  | "did_therapist_hanka"
  | "did_therapist_kata"
  | "hana_personal"
  | "did_part_conversation"
  | "meeting_conclusion"
  | "crisis_thread"
  | "post_session_response"
  | "karel_part_conversation"
  | "closure_output"
  | "task_feedback";

// ── Classification Categories ──

export type InfoClass =
  | "memory_private"          // Karlova soukromá paměť (PAMET_KAREL)
  | "daily_operational"       // denní operativa (05A)
  | "strategic_outlook"       // střednědobý výhled (05B)
  | "long_term_trajectory"    // dlouhodobá integrace (05C)
  | "part_clinical_truth"     // klinická pravda o části (KARTA_CASTI)
  | "dashboard_signal"        // signál pro dashboard
  | "task_generation"         // má vytvořit úkol
  | "session_plan_generation" // má vytvořit session plan
  | "pending_question_generation" // má vytvořit pending question
  | "meeting_trigger";        // má spustit poradu

export type PrivacyLevel =
  | "public"       // může jít kamkoli včetně UI
  | "team_only"    // jen pro terapeutický tým, ne do UI pro klienty
  | "private"      // jen PAMET_KAREL, nikdy do UI
  | "abstracted";  // odvozený operativní závěr z privátního zdroje

// ── Classified Item ──

export interface ClassifiedItem {
  /** Unikátní ID pro tracking */
  id: string;
  /** Odkud informace přišla */
  source: InformationSource;
  /** ID zdrojového záznamu (thread_id, meeting_id, ...) */
  source_id: string;
  /** Klasifikace */
  info_class: InfoClass;
  /** Úroveň soukromí */
  privacy_level: PrivacyLevel;
  /** Surový obsah (pro zápis do PAMET_KAREL nebo karty) */
  raw_content: string;
  /** Reasoning AI proč sem */
  reasoning: string;
  /** Pokud privacy_level === "abstracted", toto je bezpečný operativní závěr */
  operational_implication?: string;
  /** Cílový dokument (governance target) */
  target_document?: string;
  /** Write type */
  write_type?: "append" | "replace";
  /** Vygenerované akce */
  generated_actions: GeneratedAction[];
  /** Jméno části (pokud relevantní) */
  part_name?: string;
  /** Jméno terapeutky (pokud relevantní) */
  therapist?: "hanka" | "kata";
  /** Úroveň důkazu */
  evidence_level?: "D1" | "D2" | "D3" | "I1" | "H1";
}

// ── Generated Actions ──

export type ActionType =
  | "create_task"
  | "create_session_plan"
  | "create_pending_question"
  | "trigger_meeting"
  | "update_05a"
  | "update_05b"
  | "update_05c"
  | "update_part_card"
  | "update_dashboard"
  | "crisis_escalation";

export interface GeneratedAction {
  action_type: ActionType;
  /** Komu je akce přiřazena */
  assigned_to?: "hanka" | "kata" | "karel" | "both";
  /** Popis akce */
  description: string;
  /** Priorita */
  priority: "urgent" | "high" | "normal" | "low";
  /** Kontext pro akci */
  context?: string;
  /** Jméno části (pokud relevantní) */
  part_name?: string;
  /** Diagnostický / stabilizační / vztahový cíl */
  goal_type?: "diagnostic" | "stabilization" | "relational" | "risk" | "logistic";
}

// ── AI Classification Prompt ──

export const CLASSIFIER_SYSTEM_PROMPT = `Jsi Karel — kognitivní supervizor DID terapeutického týmu.

Dostaneš vstup z jednoho zdroje (vlákno, porada, odpověď, zpráva).
Tvůj úkol: ROZTŘÍDIT každou informaci podle její skutečné povahy.

Pro KAŽDOU informaci urči:

1. "info_class" — kam patří:
   - "memory_private" → soukromá Karlova paměť (PAMET_KAREL). Vztahové věci, osobní kontext, Karlovy dedukce.
   - "daily_operational" → operativní plán dne (05A). Konkrétní úkoly, sezení, follow-up, krizové kroky.
   - "strategic_outlook" → střednědobý výhled 2-8 týdnů (05B). Terapeutické cíle, plánované změny.
   - "long_term_trajectory" → dlouhodobá integrace (05C). Integrační milníky, strukturální změny systému.
   - "part_clinical_truth" → klinická pravda o části (karta). Switching, emoce, trauma, preference, vztahy.
   - "dashboard_signal" → signál pro denní přehled. Aktuální stav, varování, metriky.
   - "task_generation" → má se vytvořit úkol pro terapeutku.
   - "session_plan_generation" → má se naplánovat sezení.
   - "pending_question_generation" → je třeba položit otázku terapeutce.
   - "meeting_trigger" → je třeba svolat poradu.

2. "privacy_level":
   - "public" → může být viditelné v UI
   - "team_only" → jen pro terapeutický tým
   - "private" → jen PAMET_KAREL, NIKDY do UI
   - "abstracted" → z privátního zdroje odvozený BEZPEČNÝ operativní závěr

3. "evidence_level":
   - "D1" = přímý výrok části/osoby
   - "D2" = pozorování terapeutky
   - "D3" = objektivní fakt
   - "I1" = Karlova inference
   - "H1" = hypotéza

4. Pokud privacy_level je "private" nebo "abstracted", vytvoř "operational_implication":
   bezpečný profesionální závěr BEZ vyzrazení soukromého obsahu.
   Například: "Snížit zátěž Káti na 3 dny" místo "Káťa měla hádku s přítelem".

5. "generated_actions" — pole akcí, které z informace plynou:
   - "create_task" → konkrétní úkol
   - "create_session_plan" → plán sezení (kdo, s kým, proč, otázky)
   - "create_pending_question" → otázka k zodpovězení
   - "trigger_meeting" → svolat poradu
   - "update_05a/05b/05c" → aktualizovat plán
   - "update_part_card" → aktualizovat kartu části
   - "update_dashboard" → aktualizovat dashboard
   - "crisis_escalation" → eskalovat krizový signál

PRAVIDLA:
- Jedna informace může generovat VÍCE výstupů (např. part_clinical_truth + task_generation)
- Hana/osobní obsah: NIKDY nepropouštět intimní obsah do UI. Jen abstrahované operativní závěry.
- Klinická data o částech: vždy s evidence_level
- Úkoly: max 3 z jednoho vlákna
- Session plány: jen pokud je jasný terapeutický důvod
- Meeting trigger: jen při zásadním rozporu nebo krizovém rozhodnutí

Odpověz POUZE validním JSON:
{
  "items": [
    {
      "info_class": "...",
      "privacy_level": "...",
      "evidence_level": "...",
      "raw_content": "...",
      "reasoning": "...",
      "operational_implication": "..." | null,
      "part_name": "..." | null,
      "therapist": "hanka" | "kata" | null,
      "generated_actions": [
        {
          "action_type": "...",
          "assigned_to": "...",
          "description": "...",
          "priority": "...",
          "goal_type": "..." | null,
          "part_name": "..." | null
        }
      ]
    }
  ]
}

Pokud vstup neobsahuje nic užitečného: { "items": [] }`;

// ── Routing: InfoClass → Document Target ──

interface TargetRoute {
  target_document: string;
  write_type: "append" | "replace";
}

/**
 * Map classified item to its governance-compliant document target.
 * This is the SINGLE place where info_class → document mapping lives.
 */
export function resolveTarget(
  item: Pick<ClassifiedItem, "info_class" | "part_name" | "therapist" | "privacy_level">,
): TargetRoute | null {
  switch (item.info_class) {
    case "memory_private": {
      if (!item.therapist) {
        return { target_document: "PAMET_KAREL/DID/KONTEXTY/KDO_JE_KDO", write_type: "append" };
      }
      const t = item.therapist === "kata" ? "KATA" : "HANKA";
      return { target_document: `PAMET_KAREL/DID/${t}/KARLOVY_POZNATKY`, write_type: "append" };
    }

    case "daily_operational":
      return { target_document: "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN", write_type: "append" };

    case "strategic_outlook":
      return { target_document: "KARTOTEKA_DID/00_CENTRUM/05B_STRATEGICKY_VYHLED", write_type: "append" };

    case "long_term_trajectory":
      return { target_document: "KARTOTEKA_DID/00_CENTRUM/05C_DLOUHODOBA_INTEGRACNI_TRAJEKTORIE", write_type: "append" };

    case "part_clinical_truth": {
      if (!item.part_name) return null;
      return {
        target_document: `KARTA_${item.part_name.toUpperCase()}`,
        write_type: "append",
      };
    }

    case "dashboard_signal":
      return { target_document: "KARTOTEKA_DID/00_CENTRUM/DASHBOARD", write_type: "append" };

    // Action-only classes don't have direct document targets
    case "task_generation":
    case "session_plan_generation":
    case "pending_question_generation":
    case "meeting_trigger":
      return null;
  }
}

// ── Privacy Firewall ──

/**
 * Ensure private content never leaks into app-visible storage.
 * Returns the safe content to use for non-PAMET targets.
 */
export function applySafetyFilter(item: ClassifiedItem): string {
  if (item.privacy_level === "private") {
    // Private items may ONLY go to PAMET_KAREL
    // If somehow routed elsewhere, return only the operational implication
    return item.operational_implication || "[REDACTED — private signal]";
  }
  if (item.privacy_level === "abstracted") {
    return item.operational_implication || item.raw_content;
  }
  return item.raw_content;
}

/**
 * Check if a classified item is allowed to be written to a given target.
 * PAMET_KAREL targets accept everything.
 * Non-PAMET targets reject private content.
 */
export function isWriteAllowed(item: ClassifiedItem, target: string): boolean {
  if (target.startsWith("PAMET_KAREL")) return true;
  if (item.privacy_level === "private") return false;
  return true;
}

// ── Action Executor Types ──

export interface TaskInsert {
  title: string;
  assigned_to: string;
  priority: string;
  status: string;
  source: string;
  related_part?: string;
  user_id: string;
}

export interface SessionPlanInsert {
  part_name: string;
  therapist: string;
  session_goal: string;
  diagnostic_goal?: string;
  stabilization_goal?: string;
  relational_goal?: string;
  risk_point?: string;
  questions_after?: string[];
  tandem_recommended?: boolean;
}

export interface PendingQuestionInsert {
  question: string;
  directed_to: string;
  subject_type: string;
  subject_id?: string;
  context?: string;
  status: string;
}

/**
 * Convert generated actions into DB-ready insert objects.
 * Caller is responsible for actual DB writes.
 */
export function materializeActions(
  item: ClassifiedItem,
  userId: string,
): {
  tasks: TaskInsert[];
  sessionPlans: SessionPlanInsert[];
  pendingQuestions: PendingQuestionInsert[];
  meetingTriggers: { reason: string; priority: string }[];
  planUpdates: { target: "05a" | "05b" | "05c"; content: string }[];
  cardUpdates: { part_name: string; content: string }[];
  dashboardUpdates: { content: string }[];
  crisisEscalations: { description: string; part_name?: string }[];
} {
  const result = {
    tasks: [] as TaskInsert[],
    sessionPlans: [] as SessionPlanInsert[],
    pendingQuestions: [] as PendingQuestionInsert[],
    meetingTriggers: [] as { reason: string; priority: string }[],
    planUpdates: [] as { target: "05a" | "05b" | "05c"; content: string }[],
    cardUpdates: [] as { part_name: string; content: string }[],
    dashboardUpdates: [] as { content: string }[],
    crisisEscalations: [] as { description: string; part_name?: string }[],
  };

  for (const action of item.generated_actions) {
    const safeContent = applySafetyFilter(item);

    switch (action.action_type) {
      case "create_task":
        result.tasks.push({
          title: action.description,
          assigned_to: action.assigned_to || "hanka",
          priority: action.priority,
          status: "pending",
          source: "classifier",
          related_part: action.part_name || item.part_name,
          user_id: userId,
        });
        break;

      case "create_session_plan":
        result.sessionPlans.push({
          part_name: action.part_name || item.part_name || "unknown",
          therapist: action.assigned_to || "hanka",
          session_goal: action.description,
          diagnostic_goal: action.goal_type === "diagnostic" ? action.description : undefined,
          stabilization_goal: action.goal_type === "stabilization" ? action.description : undefined,
          relational_goal: action.goal_type === "relational" ? action.description : undefined,
          risk_point: action.goal_type === "risk" ? action.description : undefined,
        });
        break;

      case "create_pending_question":
        result.pendingQuestions.push({
          question: action.description,
          directed_to: action.assigned_to || "both",
          subject_type: item.part_name ? "part" : "general",
          subject_id: item.part_name || undefined,
          context: action.context || safeContent.slice(0, 300),
          status: "open",
        });
        break;

      case "trigger_meeting":
        result.meetingTriggers.push({
          reason: action.description,
          priority: action.priority,
        });
        break;

      case "update_05a":
        result.planUpdates.push({ target: "05a", content: safeContent });
        break;

      case "update_05b":
        result.planUpdates.push({ target: "05b", content: safeContent });
        break;

      case "update_05c":
        result.planUpdates.push({ target: "05c", content: safeContent });
        break;

      case "update_part_card":
        if (action.part_name || item.part_name) {
          result.cardUpdates.push({
            part_name: (action.part_name || item.part_name)!,
            content: safeContent,
          });
        }
        break;

      case "update_dashboard":
        result.dashboardUpdates.push({ content: safeContent });
        break;

      case "crisis_escalation":
        result.crisisEscalations.push({
          description: action.description,
          part_name: action.part_name || item.part_name,
        });
        break;
    }
  }

  return result;
}

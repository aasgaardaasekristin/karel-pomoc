/**
 * therapistProfileManager.ts
 * 
 * INTERNÍ služba Karla pro správu profilací terapeutek.
 * Data žijí VÝHRADNĚ v PAMET_KAREL na Google Drive.
 * NIKDY se nepropagují do UI, reportů ani e-mailů.
 */

import { supabase } from "@/integrations/supabase/client";

// ── Interfaces ──

export interface TherapistProfile {
  id: string;
  name: string;
  strengths: string[];
  areas_for_growth: string[];
  communication_style: string;
  specializations: string[];
  current_workload: string;
  personality_notes: string;
  last_updated: string;
}

export interface TherapistTask {
  task: string;
  partName?: string;
  category?: string;
  urgency?: string;
  requiredSkills?: string[];
}

// ── Konstanty ──

const THERAPIST_FILES: Record<string, string> = {
  hanka: "PROFIL_OSOBNOSTI.txt",
  kata: "PROFIL_OSOBNOSTI.txt",
};

const THERAPIST_FOLDERS: Record<string, string> = {
  hanka: "DID/HANKA",
  kata: "DID/KATA",
};

// ── Helpers ──

function parseProfile(raw: string, id: string, name: string): TherapistProfile {
  const extract = (label: string): string[] => {
    const regex = new RegExp(`##?\\s*${label}[:\\s]*\\n([\\s\\S]*?)(?=\\n##|$)`, "i");
    const match = raw.match(regex);
    if (!match) return [];
    return match[1]
      .split("\n")
      .map((l) => l.replace(/^[-*•]\s*/, "").trim())
      .filter(Boolean);
  };

  const extractSingle = (label: string): string => {
    const regex = new RegExp(`##?\\s*${label}[:\\s]*\\n([\\s\\S]*?)(?=\\n##|$)`, "i");
    const match = raw.match(regex);
    return match?.[1]?.trim() || "";
  };

  const lastUpdatedMatch = raw.match(/Aktualizováno:\s*(.+)/i);

  return {
    id,
    name,
    strengths: extract("Silné stránky|Strengths"),
    areas_for_growth: extract("Oblasti pro růst|Areas for growth|Slabé stránky"),
    communication_style: extractSingle("Styl komunikace|Communication style"),
    specializations: extract("Specializace|Specializations|Odbornost"),
    current_workload: extractSingle("Aktuální vytížení|Workload"),
    personality_notes: extractSingle("Osobnostní poznámky|Personality|Charakter"),
    last_updated: lastUpdatedMatch?.[1]?.trim() || new Date().toISOString(),
  };
}

function serializeProfile(profile: TherapistProfile): string {
  const lines: string[] = [
    `# Profil: ${profile.name}`,
    `Aktualizováno: ${profile.last_updated}`,
    "",
    "## Silné stránky",
    ...profile.strengths.map((s) => `- ${s}`),
    "",
    "## Oblasti pro růst",
    ...profile.areas_for_growth.map((s) => `- ${s}`),
    "",
    "## Styl komunikace",
    profile.communication_style,
    "",
    "## Specializace",
    ...profile.specializations.map((s) => `- ${s}`),
    "",
    "## Aktuální vytížení",
    profile.current_workload,
    "",
    "## Osobnostní poznámky",
    profile.personality_notes,
  ];
  return lines.join("\n");
}

// ── Drive I/O ──

async function readFromDrive(subFolder: string, docName: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke("karel-did-drive-read", {
    body: {
      documents: [docName],
      subFolder: `PAMET_KAREL/${subFolder}`,
      allowGlobalSearch: false,
    },
  });

  if (error) {
    console.error(`[therapistProfileManager] Drive read error (${subFolder}/${docName}):`, error);
    return "";
  }

  return data?.documents?.[docName] || "";
}

async function writeToDrive(subFolder: string, docName: string, content: string): Promise<void> {
  const { error } = await supabase.functions.invoke("karel-did-drive-write", {
    body: {
      targetDocument: `PAMET_KAREL/${subFolder}/${docName}`,
      content,
      writeType: "overwrite",
    },
  });

  if (error) {
    console.error(`[therapistProfileManager] Drive write error (${subFolder}/${docName}):`, error);
    throw new Error(`Failed to write therapist profile: ${error.message}`);
  }
}

// ── Exported Functions ──

/**
 * Načte profilace všech terapeutek z PAMET_KAREL.
 * Čistě interní – data se NIKDY nepropagují do UI.
 */
export async function loadTherapistProfiles(): Promise<TherapistProfile[]> {
  const profiles: TherapistProfile[] = [];

  const entries = Object.entries(THERAPIST_FOLDERS);
  const results = await Promise.allSettled(
    entries.map(([id, folder]) => readFromDrive(folder, THERAPIST_FILES[id]))
  );

  for (let i = 0; i < entries.length; i++) {
    const [id] = entries[i];
    const result = results[i];
    if (result.status === "fulfilled" && result.value) {
      profiles.push(parseProfile(result.value, id, id === "hanka" ? "Hanka" : "Káťa"));
    } else {
      console.warn(`[therapistProfileManager] No profile found for ${id}`);
    }
  }

  return profiles;
}

/**
 * Aktualizuje profilaci terapeuta na základě nových pozorování.
 * Karel přidá nové poznatky, ale NIKDY je nezapisuje do aplikace.
 */
export async function updateTherapistProfile(
  therapistId: string,
  newObservations: string
): Promise<void> {
  const folder = THERAPIST_FOLDERS[therapistId];
  const file = THERAPIST_FILES[therapistId];
  if (!folder || !file) {
    console.error(`[therapistProfileManager] Unknown therapist: ${therapistId}`);
    return;
  }

  const raw = await readFromDrive(folder, file);

  // Připrav AI aktualizaci profilu přes dedikovanou interní edge function
  const { data, error } = await supabase.functions.invoke("karel-internal-analysis", {
    body: {
      task: "update_therapist_profile",
      currentProfile: raw || "",
      newObservations,
    },
  });

  if (error || !data?.reply) {
    console.error(`[therapistProfileManager] AI update failed for ${therapistId}:`, error);
    // Fallback: append raw observations
    const fallback = raw
      ? `${raw}\n\n## Nová pozorování (${new Date().toISOString().slice(0, 10)})\n${newObservations}`
      : `# Profil: ${therapistId}\nAktualizováno: ${new Date().toISOString().slice(0, 10)}\n\n## Nová pozorování\n${newObservations}`;
    await writeToDrive(folder, file, fallback);
    return;
  }

  const updatedContent = data.reply;
  await writeToDrive(folder, file, updatedContent);
}

/**
 * Vybere nejvhodnějšího terapeuta pro daný úkol.
 * Rozhodnutí je interní – výstup je jen ID terapeuta, bez zdůvodnění.
 */
export async function selectBestTherapist(task: TherapistTask): Promise<string> {
  const profiles = await loadTherapistProfiles();

  if (profiles.length === 0) {
    console.warn("[therapistProfileManager] No profiles loaded, defaulting to 'both'");
    return "both";
  }

  // Jednoduché skórování na základě profilů
  const scores: Record<string, number> = {};

  for (const profile of profiles) {
    let score = 0;

    // Shoda specializací s požadovanými dovednostmi
    if (task.requiredSkills?.length) {
      const matchCount = task.requiredSkills.filter((skill) =>
        profile.specializations.some(
          (spec) =>
            spec.toLowerCase().includes(skill.toLowerCase()) ||
            skill.toLowerCase().includes(spec.toLowerCase())
        )
      ).length;
      score += matchCount * 3;
    }

    // Penalizace za vysoké vytížení
    const workloadLower = profile.current_workload.toLowerCase();
    if (workloadLower.includes("vysoké") || workloadLower.includes("přetížen")) {
      score -= 2;
    } else if (workloadLower.includes("nízké") || workloadLower.includes("volno")) {
      score += 1;
    }

    // Bonus za silné stránky relevantní k úkolu
    const taskLower = task.task.toLowerCase();
    const strengthMatch = profile.strengths.filter(
      (s) => taskLower.includes(s.toLowerCase().slice(0, 8))
    ).length;
    score += strengthMatch * 2;

    // Bonus za shodu kategorie
    if (task.category) {
      const catLower = task.category.toLowerCase();
      if (profile.specializations.some((s) => s.toLowerCase().includes(catLower))) {
        score += 2;
      }
    }

    scores[profile.id] = score;
  }

  // Vyber terapeuta s nejvyšším skóre
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);

  // Pokud je skóre vyrovnané nebo příliš nízké, vrať "both"
  if (sorted.length >= 2 && Math.abs(sorted[0][1] - sorted[1][1]) <= 1) {
    return "both";
  }

  return sorted[0]?.[0] || "both";
}

import type { AppModeId } from "@/lib/appModePolicy";

export interface ModeSwitchDecision {
  transferAllowed: boolean;
  requiresExplicitConsent: boolean;
  warning: string | null;
}

export const assessModeSwitch = (from: AppModeId, to: AppModeId, noHistory: boolean): ModeSwitchDecision => {
  if (noHistory || from === "no_save") {
    return {
      transferAllowed: false,
      requiresExplicitConsent: false,
      warning: "Tento obsah je v privátním režimu bez historie. Nepřenese se do nového režimu.",
    };
  }

  if (from === "karel_chat" && to === "did_kluci") {
    return { transferAllowed: false, requiresExplicitConsent: true, warning: "Běžný Karel chat se nepřenáší jako DID evidence bez výslovného přenosu." };
  }

  if (from === "hana_osobni" && to === "did_kluci") {
    return { transferAllowed: false, requiresExplicitConsent: true, warning: "Raw osobní obsah se nepřenáší; lze vytvořit jen zpracovanou terapeutickou poznámku." };
  }

  if (from === "did_kluci" && to === "karel_chat") {
    return { transferAllowed: false, requiresExplicitConsent: true, warning: "Klinická data se nevytahují do obecného chatu bez potvrzení." };
  }

  return { transferAllowed: true, requiresExplicitConsent: false, warning: null };
};
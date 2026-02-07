export interface DbCrisisBrief {
  id: string;
  created_at: string;
  scenario: string;
  risk_score: number;
  risk_overview: string;
  recommended_contact: string;
  suggested_opening_lines: string[];
  risk_formulations: string[];
  next_steps: string[];
  is_read: boolean;
  signals: Record<string, boolean>;
  regulation_attempts: number;
  regulation_successful: boolean;
  therapist_bridge_triggered: boolean;
  therapist_bridge_method: string | null;
  time_dynamics: Record<string, unknown>;
  note: string;
}

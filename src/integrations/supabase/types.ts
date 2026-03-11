export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      calm_access_tokens: {
        Row: {
          created_at: string
          email: string
          expires_at: string
          id: string
          token: string
          used: boolean
        }
        Insert: {
          created_at?: string
          email: string
          expires_at: string
          id?: string
          token: string
          used?: boolean
        }
        Update: {
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          token?: string
          used?: boolean
        }
        Relationships: []
      }
      client_sessions: {
        Row: {
          ai_analysis: string | null
          ai_hypotheses: string | null
          ai_recommended_methods: string | null
          ai_risk_assessment: string | null
          client_id: string
          created_at: string
          id: string
          notes: string | null
          report_context: string | null
          report_interventions_tried: string | null
          report_key_theme: string | null
          report_missing_data: string | null
          report_next_session_goal: string | null
          report_risks: string[] | null
          report_therapist_emotions: string[] | null
          report_transference: string | null
          session_date: string
          session_number: number | null
          updated_at: string
          user_id: string
          voice_analysis: string | null
        }
        Insert: {
          ai_analysis?: string | null
          ai_hypotheses?: string | null
          ai_recommended_methods?: string | null
          ai_risk_assessment?: string | null
          client_id: string
          created_at?: string
          id?: string
          notes?: string | null
          report_context?: string | null
          report_interventions_tried?: string | null
          report_key_theme?: string | null
          report_missing_data?: string | null
          report_next_session_goal?: string | null
          report_risks?: string[] | null
          report_therapist_emotions?: string[] | null
          report_transference?: string | null
          session_date?: string
          session_number?: number | null
          updated_at?: string
          user_id?: string
          voice_analysis?: string | null
        }
        Update: {
          ai_analysis?: string | null
          ai_hypotheses?: string | null
          ai_recommended_methods?: string | null
          ai_risk_assessment?: string | null
          client_id?: string
          created_at?: string
          id?: string
          notes?: string | null
          report_context?: string | null
          report_interventions_tried?: string | null
          report_key_theme?: string | null
          report_missing_data?: string | null
          report_next_session_goal?: string | null
          report_risks?: string[] | null
          report_therapist_emotions?: string[] | null
          report_transference?: string | null
          session_date?: string
          session_number?: number | null
          updated_at?: string
          user_id?: string
          voice_analysis?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_sessions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      client_tasks: {
        Row: {
          client_id: string
          created_at: string
          due_date: string | null
          id: string
          method: string | null
          notes: string | null
          result: string | null
          status: string
          task: string
          updated_at: string
          user_id: string
        }
        Insert: {
          client_id: string
          created_at?: string
          due_date?: string | null
          id?: string
          method?: string | null
          notes?: string | null
          result?: string | null
          status?: string
          task: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          client_id?: string
          created_at?: string
          due_date?: string | null
          id?: string
          method?: string | null
          notes?: string | null
          result?: string | null
          status?: string
          task?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_tasks_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          age: number | null
          created_at: string
          diagnosis: string | null
          family_context: string | null
          gender: string | null
          id: string
          key_history: string | null
          name: string
          notes: string | null
          referral_source: string | null
          therapy_type: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          age?: number | null
          created_at?: string
          diagnosis?: string | null
          family_context?: string | null
          gender?: string | null
          id?: string
          key_history?: string | null
          name: string
          notes?: string | null
          referral_source?: string | null
          therapy_type?: string | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          age?: number | null
          created_at?: string
          diagnosis?: string | null
          family_context?: string | null
          gender?: string | null
          id?: string
          key_history?: string | null
          name?: string
          notes?: string | null
          referral_source?: string | null
          therapy_type?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      crisis_briefs: {
        Row: {
          created_at: string
          id: string
          is_read: boolean
          next_steps: string[]
          note: string
          notification_sent: boolean
          raw_brief: string
          recommended_contact: string
          regulation_attempts: number
          regulation_successful: boolean
          risk_formulations: string[]
          risk_overview: string
          risk_score: number
          scenario: string
          signals: Json
          suggested_opening_lines: string[]
          therapist_bridge_method: string | null
          therapist_bridge_triggered: boolean
          time_dynamics: Json
        }
        Insert: {
          created_at?: string
          id?: string
          is_read?: boolean
          next_steps?: string[]
          note?: string
          notification_sent?: boolean
          raw_brief?: string
          recommended_contact?: string
          regulation_attempts?: number
          regulation_successful?: boolean
          risk_formulations?: string[]
          risk_overview?: string
          risk_score: number
          scenario: string
          signals?: Json
          suggested_opening_lines?: string[]
          therapist_bridge_method?: string | null
          therapist_bridge_triggered?: boolean
          time_dynamics?: Json
        }
        Update: {
          created_at?: string
          id?: string
          is_read?: boolean
          next_steps?: string[]
          note?: string
          notification_sent?: boolean
          raw_brief?: string
          recommended_contact?: string
          regulation_attempts?: number
          regulation_successful?: boolean
          risk_formulations?: string[]
          risk_overview?: string
          risk_score?: number
          scenario?: string
          signals?: Json
          suggested_opening_lines?: string[]
          therapist_bridge_method?: string | null
          therapist_bridge_triggered?: boolean
          time_dynamics?: Json
        }
        Relationships: []
      }
      did_conversations: {
        Row: {
          created_at: string
          did_initial_context: string
          id: string
          is_processed: boolean
          label: string
          messages: Json
          preview: string
          processed_at: string | null
          saved_at: string
          session_id: string
          sub_mode: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          did_initial_context?: string
          id?: string
          is_processed?: boolean
          label: string
          messages?: Json
          preview?: string
          processed_at?: string | null
          saved_at?: string
          session_id: string
          sub_mode: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          did_initial_context?: string
          id?: string
          is_processed?: boolean
          label?: string
          messages?: Json
          preview?: string
          processed_at?: string | null
          saved_at?: string
          session_id?: string
          sub_mode?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      did_daily_report_dispatches: {
        Row: {
          created_at: string
          cycle_id: string | null
          error_message: string | null
          id: string
          recipient: string
          report_date: string
          sent_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          cycle_id?: string | null
          error_message?: string | null
          id?: string
          recipient: string
          report_date: string
          sent_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          cycle_id?: string | null
          error_message?: string | null
          id?: string
          recipient?: string
          report_date?: string
          sent_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "did_daily_report_dispatches_cycle_id_fkey"
            columns: ["cycle_id"]
            isOneToOne: false
            referencedRelation: "did_update_cycles"
            referencedColumns: ["id"]
          },
        ]
      }
      did_therapist_tasks: {
        Row: {
          assigned_to: string
          category: string | null
          completed_at: string | null
          completed_note: string | null
          created_at: string
          due_date: string | null
          id: string
          note: string | null
          priority: string | null
          source_agreement: string | null
          status: string
          task: string
          updated_at: string
          user_id: string
        }
        Insert: {
          assigned_to?: string
          category?: string | null
          completed_at?: string | null
          completed_note?: string | null
          created_at?: string
          due_date?: string | null
          id?: string
          note?: string | null
          priority?: string | null
          source_agreement?: string | null
          status?: string
          task: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          assigned_to?: string
          category?: string | null
          completed_at?: string | null
          completed_note?: string | null
          created_at?: string
          due_date?: string | null
          id?: string
          note?: string | null
          priority?: string | null
          source_agreement?: string | null
          status?: string
          task?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      did_threads: {
        Row: {
          created_at: string
          id: string
          is_processed: boolean
          last_activity_at: string
          messages: Json
          part_language: string | null
          part_name: string
          processed_at: string | null
          started_at: string
          sub_mode: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_processed?: boolean
          last_activity_at?: string
          messages?: Json
          part_language?: string | null
          part_name: string
          processed_at?: string | null
          started_at?: string
          sub_mode?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_processed?: boolean
          last_activity_at?: string
          messages?: Json
          part_language?: string | null
          part_name?: string
          processed_at?: string | null
          started_at?: string
          sub_mode?: string
          user_id?: string
        }
        Relationships: []
      }
      did_update_cycles: {
        Row: {
          cards_updated: Json | null
          completed_at: string | null
          created_at: string
          cycle_type: string
          id: string
          report_summary: string | null
          started_at: string
          status: string
          user_id: string
        }
        Insert: {
          cards_updated?: Json | null
          completed_at?: string | null
          created_at?: string
          cycle_type?: string
          id?: string
          report_summary?: string | null
          started_at?: string
          status?: string
          user_id?: string
        }
        Update: {
          cards_updated?: Json | null
          completed_at?: string | null
          created_at?: string
          cycle_type?: string
          id?: string
          report_summary?: string | null
          started_at?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      research_threads: {
        Row: {
          created_at: string
          created_by: string
          id: string
          is_deleted: boolean
          is_processed: boolean
          last_activity_at: string
          messages: Json
          processed_at: string | null
          started_at: string
          topic: string
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string
          id?: string
          is_deleted?: boolean
          is_processed?: boolean
          last_activity_at?: string
          messages?: Json
          processed_at?: string | null
          started_at?: string
          topic: string
          user_id?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          is_deleted?: boolean
          is_processed?: boolean
          last_activity_at?: string
          messages?: Json
          processed_at?: string | null
          started_at?: string
          topic?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

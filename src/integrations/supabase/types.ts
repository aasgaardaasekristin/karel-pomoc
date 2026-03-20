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
      did_countertransference_bonds: {
        Row: {
          bond_description: string | null
          bond_type: string
          created_at: string | null
          id: string
          intensity: number
          last_observed_at: string | null
          part_name: string
          therapeutic_implication: string | null
          therapist: string
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          bond_description?: string | null
          bond_type?: string
          created_at?: string | null
          id?: string
          intensity?: number
          last_observed_at?: string | null
          part_name: string
          therapeutic_implication?: string | null
          therapist: string
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          bond_description?: string | null
          bond_type?: string
          created_at?: string | null
          id?: string
          intensity?: number
          last_observed_at?: string | null
          part_name?: string
          therapeutic_implication?: string | null
          therapist?: string
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      did_daily_report_dispatches: {
        Row: {
          created_at: string
          cycle_id: string | null
          error_message: string | null
          id: string
          last_retry_strategy: string | null
          recipient: string
          report_date: string
          retry_count: number
          sent_at: string | null
          status: string
          updated_at: string
          watchdog_log: string | null
        }
        Insert: {
          created_at?: string
          cycle_id?: string | null
          error_message?: string | null
          id?: string
          last_retry_strategy?: string | null
          recipient: string
          report_date: string
          retry_count?: number
          sent_at?: string | null
          status?: string
          updated_at?: string
          watchdog_log?: string | null
        }
        Update: {
          created_at?: string
          cycle_id?: string | null
          error_message?: string | null
          id?: string
          last_retry_strategy?: string | null
          recipient?: string
          report_date?: string
          retry_count?: number
          sent_at?: string | null
          status?: string
          updated_at?: string
          watchdog_log?: string | null
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
      did_kartoteka_health: {
        Row: {
          created_at: string
          filled_sections: number
          folder_label: string
          health_score: number
          id: string
          last_checked: string
          missing_sections: string[]
          part_name: string
          stale_sections: string[]
          stub_sections: string[]
          total_sections: number
          user_id: string
        }
        Insert: {
          created_at?: string
          filled_sections?: number
          folder_label?: string
          health_score?: number
          id?: string
          last_checked?: string
          missing_sections?: string[]
          part_name: string
          stale_sections?: string[]
          stub_sections?: string[]
          total_sections?: number
          user_id?: string
        }
        Update: {
          created_at?: string
          filled_sections?: number
          folder_label?: string
          health_score?: number
          id?: string
          last_checked?: string
          missing_sections?: string[]
          part_name?: string
          stale_sections?: string[]
          stub_sections?: string[]
          total_sections?: number
          user_id?: string
        }
        Relationships: []
      }
      did_meetings: {
        Row: {
          agenda: string
          created_at: string
          deadline_at: string | null
          finalized_at: string | null
          hanka_joined_at: string | null
          id: string
          kata_joined_at: string | null
          messages: Json
          outcome_summary: string | null
          outcome_tasks: Json | null
          reminder_sent: boolean
          status: string
          topic: string
          triggered_by: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          agenda?: string
          created_at?: string
          deadline_at?: string | null
          finalized_at?: string | null
          hanka_joined_at?: string | null
          id?: string
          kata_joined_at?: string | null
          messages?: Json
          outcome_summary?: string | null
          outcome_tasks?: Json | null
          reminder_sent?: boolean
          status?: string
          topic: string
          triggered_by?: string | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          agenda?: string
          created_at?: string
          deadline_at?: string | null
          finalized_at?: string | null
          hanka_joined_at?: string | null
          id?: string
          kata_joined_at?: string | null
          messages?: Json
          outcome_summary?: string | null
          outcome_tasks?: Json | null
          reminder_sent?: boolean
          status?: string
          topic?: string
          triggered_by?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      did_motivation_profiles: {
        Row: {
          avg_completion_days: number | null
          created_at: string
          deadline_effectiveness: number
          id: string
          instruction_effectiveness: number
          last_active_at: string | null
          notes: string | null
          praise_effectiveness: number
          preferred_style: string
          streak_best: number
          streak_current: number
          tasks_completed: number
          tasks_missed: number
          therapist: string
          updated_at: string
          user_id: string
        }
        Insert: {
          avg_completion_days?: number | null
          created_at?: string
          deadline_effectiveness?: number
          id?: string
          instruction_effectiveness?: number
          last_active_at?: string | null
          notes?: string | null
          praise_effectiveness?: number
          preferred_style?: string
          streak_best?: number
          streak_current?: number
          tasks_completed?: number
          tasks_missed?: number
          therapist: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          avg_completion_days?: number | null
          created_at?: string
          deadline_effectiveness?: number
          id?: string
          instruction_effectiveness?: number
          last_active_at?: string | null
          notes?: string | null
          praise_effectiveness?: number
          preferred_style?: string
          streak_best?: number
          streak_current?: number
          tasks_completed?: number
          tasks_missed?: number
          therapist?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      did_part_profiles: {
        Row: {
          challenges: Json | null
          cognitive_profile: Json | null
          communication_style: Json | null
          confidence_score: number | null
          created_at: string
          emotional_profile: Json | null
          evidence_sources: Json | null
          id: string
          interests: Json | null
          last_enriched_at: string | null
          motivations: Json | null
          needs: Json | null
          part_name: string
          personality_traits: Json | null
          strengths: Json | null
          theme_preferences: Json | null
          therapeutic_approach: Json | null
          updated_at: string
          user_id: string
        }
        Insert: {
          challenges?: Json | null
          cognitive_profile?: Json | null
          communication_style?: Json | null
          confidence_score?: number | null
          created_at?: string
          emotional_profile?: Json | null
          evidence_sources?: Json | null
          id?: string
          interests?: Json | null
          last_enriched_at?: string | null
          motivations?: Json | null
          needs?: Json | null
          part_name: string
          personality_traits?: Json | null
          strengths?: Json | null
          theme_preferences?: Json | null
          therapeutic_approach?: Json | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          challenges?: Json | null
          cognitive_profile?: Json | null
          communication_style?: Json | null
          confidence_score?: number | null
          created_at?: string
          emotional_profile?: Json | null
          evidence_sources?: Json | null
          id?: string
          interests?: Json | null
          last_enriched_at?: string | null
          motivations?: Json | null
          needs?: Json | null
          part_name?: string
          personality_traits?: Json | null
          strengths?: Json | null
          theme_preferences?: Json | null
          therapeutic_approach?: Json | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      did_part_registry: {
        Row: {
          age_estimate: string | null
          cluster: string | null
          created_at: string
          display_name: string
          drive_folder_label: string | null
          health_score: number | null
          id: string
          known_strengths: string[] | null
          known_triggers: string[] | null
          language: string | null
          last_emotional_intensity: number | null
          last_emotional_state: string | null
          last_seen_at: string | null
          notes: string | null
          part_name: string
          role_in_system: string | null
          status: string
          total_episodes: number | null
          total_threads: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          age_estimate?: string | null
          cluster?: string | null
          created_at?: string
          display_name?: string
          drive_folder_label?: string | null
          health_score?: number | null
          id?: string
          known_strengths?: string[] | null
          known_triggers?: string[] | null
          language?: string | null
          last_emotional_intensity?: number | null
          last_emotional_state?: string | null
          last_seen_at?: string | null
          notes?: string | null
          part_name: string
          role_in_system?: string | null
          status?: string
          total_episodes?: number | null
          total_threads?: number | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          age_estimate?: string | null
          cluster?: string | null
          created_at?: string
          display_name?: string
          drive_folder_label?: string | null
          health_score?: number | null
          id?: string
          known_strengths?: string[] | null
          known_triggers?: string[] | null
          language?: string | null
          last_emotional_intensity?: number | null
          last_emotional_state?: string | null
          last_seen_at?: string | null
          notes?: string | null
          part_name?: string
          role_in_system?: string | null
          status?: string
          total_episodes?: number | null
          total_threads?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      did_part_sessions: {
        Row: {
          ai_analysis: string | null
          audio_analysis: string | null
          created_at: string
          id: string
          image_analysis: string | null
          karel_notes: string | null
          karel_therapist_feedback: string | null
          long_term_goals: string[] | null
          methods_effectiveness: Json | null
          methods_used: string[] | null
          mid_term_goals: string[] | null
          part_name: string
          session_date: string
          session_type: string
          short_term_goals: string[] | null
          tasks_assigned: Json | null
          tasks_outcomes: Json | null
          therapist: string
          thread_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          ai_analysis?: string | null
          audio_analysis?: string | null
          created_at?: string
          id?: string
          image_analysis?: string | null
          karel_notes?: string | null
          karel_therapist_feedback?: string | null
          long_term_goals?: string[] | null
          methods_effectiveness?: Json | null
          methods_used?: string[] | null
          mid_term_goals?: string[] | null
          part_name: string
          session_date?: string
          session_type?: string
          short_term_goals?: string[] | null
          tasks_assigned?: Json | null
          tasks_outcomes?: Json | null
          therapist?: string
          thread_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          ai_analysis?: string | null
          audio_analysis?: string | null
          created_at?: string
          id?: string
          image_analysis?: string | null
          karel_notes?: string | null
          karel_therapist_feedback?: string | null
          long_term_goals?: string[] | null
          methods_effectiveness?: Json | null
          methods_used?: string[] | null
          mid_term_goals?: string[] | null
          part_name?: string
          session_date?: string
          session_type?: string
          short_term_goals?: string[] | null
          tasks_assigned?: Json | null
          tasks_outcomes?: Json | null
          therapist?: string
          thread_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "did_part_sessions_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "did_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      did_part_theme_preferences: {
        Row: {
          chosen_at: string
          id: string
          part_name: string
          theme_config: Json | null
          theme_preset: string
          thread_id: string | null
          user_id: string
        }
        Insert: {
          chosen_at?: string
          id?: string
          part_name: string
          theme_config?: Json | null
          theme_preset?: string
          thread_id?: string | null
          user_id?: string
        }
        Update: {
          chosen_at?: string
          id?: string
          part_name?: string
          theme_config?: Json | null
          theme_preset?: string
          thread_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "did_part_theme_preferences_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "did_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      did_pending_drive_writes: {
        Row: {
          content: string
          created_at: string | null
          id: string
          priority: string | null
          processed_at: string | null
          status: string | null
          target_document: string
          user_id: string | null
          write_type: string | null
        }
        Insert: {
          content: string
          created_at?: string | null
          id?: string
          priority?: string | null
          processed_at?: string | null
          status?: string | null
          target_document: string
          user_id?: string | null
          write_type?: string | null
        }
        Update: {
          content?: string
          created_at?: string | null
          id?: string
          priority?: string | null
          processed_at?: string | null
          status?: string | null
          target_document?: string
          user_id?: string | null
          write_type?: string | null
        }
        Relationships: []
      }
      did_pulse_checks: {
        Row: {
          created_at: string
          id: string
          karel_feedback: string | null
          priority_clarity: number
          respondent: string
          team_feeling: number
          user_id: string
          week_start: string
        }
        Insert: {
          created_at?: string
          id?: string
          karel_feedback?: string | null
          priority_clarity: number
          respondent: string
          team_feeling: number
          user_id?: string
          week_start: string
        }
        Update: {
          created_at?: string
          id?: string
          karel_feedback?: string | null
          priority_clarity?: number
          respondent?: string
          team_feeling?: number
          user_id?: string
          week_start?: string
        }
        Relationships: []
      }
      did_system_profile: {
        Row: {
          created_at: string
          current_priorities: string[]
          drive_document_id: string | null
          education_context: string
          goals_long_term: string[]
          goals_mid_term: string[]
          goals_short_term: string[]
          id: string
          inner_world_description: string
          inner_world_rules: string
          integration_strategy: string
          karel_master_analysis: string
          last_drive_sync: string | null
          part_contributions: Json
          relationships_map: Json
          risk_factors: string[]
          system_identity: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          current_priorities?: string[]
          drive_document_id?: string | null
          education_context?: string
          goals_long_term?: string[]
          goals_mid_term?: string[]
          goals_short_term?: string[]
          id?: string
          inner_world_description?: string
          inner_world_rules?: string
          integration_strategy?: string
          karel_master_analysis?: string
          last_drive_sync?: string | null
          part_contributions?: Json
          relationships_map?: Json
          risk_factors?: string[]
          system_identity?: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          current_priorities?: string[]
          drive_document_id?: string | null
          education_context?: string
          goals_long_term?: string[]
          goals_mid_term?: string[]
          goals_short_term?: string[]
          id?: string
          inner_world_description?: string
          inner_world_rules?: string
          integration_strategy?: string
          karel_master_analysis?: string
          last_drive_sync?: string | null
          part_contributions?: Json
          relationships_map?: Json
          risk_factors?: string[]
          system_identity?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      did_task_feedback: {
        Row: {
          author: string
          created_at: string | null
          id: string
          message: string
          task_id: string
        }
        Insert: {
          author: string
          created_at?: string | null
          id?: string
          message: string
          task_id: string
        }
        Update: {
          author?: string
          created_at?: string | null
          id?: string
          message?: string
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "did_task_feedback_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "did_therapist_tasks"
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
          detail_instruction: string | null
          due_date: string | null
          escalation_level: number | null
          id: string
          note: string | null
          priority: string | null
          source_agreement: string | null
          status: string
          status_hanka: string
          status_kata: string
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
          detail_instruction?: string | null
          due_date?: string | null
          escalation_level?: number | null
          id?: string
          note?: string | null
          priority?: string | null
          source_agreement?: string | null
          status?: string
          status_hanka?: string
          status_kata?: string
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
          detail_instruction?: string | null
          due_date?: string | null
          escalation_level?: number | null
          id?: string
          note?: string | null
          priority?: string | null
          source_agreement?: string | null
          status?: string
          status_hanka?: string
          status_kata?: string
          task?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      did_threads: {
        Row: {
          created_at: string
          entered_name: string | null
          id: string
          is_processed: boolean
          last_activity_at: string
          messages: Json
          part_language: string | null
          part_name: string
          processed_at: string | null
          started_at: string
          sub_mode: string
          theme_config: Json | null
          theme_preset: string
          thread_emoji: string | null
          thread_label: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          entered_name?: string | null
          id?: string
          is_processed?: boolean
          last_activity_at?: string
          messages?: Json
          part_language?: string | null
          part_name: string
          processed_at?: string | null
          started_at?: string
          sub_mode?: string
          theme_config?: Json | null
          theme_preset?: string
          thread_emoji?: string | null
          thread_label?: string | null
          user_id?: string
        }
        Update: {
          created_at?: string
          entered_name?: string | null
          id?: string
          is_processed?: boolean
          last_activity_at?: string
          messages?: Json
          part_language?: string | null
          part_name?: string
          processed_at?: string | null
          started_at?: string
          sub_mode?: string
          theme_config?: Json | null
          theme_preset?: string
          thread_emoji?: string | null
          thread_label?: string | null
          user_id?: string
        }
        Relationships: []
      }
      did_update_cycles: {
        Row: {
          cards_updated: Json | null
          completed_at: string | null
          context_data: Json
          created_at: string
          cycle_type: string
          heartbeat_at: string | null
          id: string
          last_error: string | null
          phase: string
          phase_detail: string
          phase_step: string | null
          progress_current: number | null
          progress_total: number | null
          report_summary: string | null
          started_at: string
          status: string
          user_id: string
        }
        Insert: {
          cards_updated?: Json | null
          completed_at?: string | null
          context_data?: Json
          created_at?: string
          cycle_type?: string
          heartbeat_at?: string | null
          id?: string
          last_error?: string | null
          phase?: string
          phase_detail?: string
          phase_step?: string | null
          progress_current?: number | null
          progress_total?: number | null
          report_summary?: string | null
          started_at?: string
          status?: string
          user_id?: string
        }
        Update: {
          cards_updated?: Json | null
          completed_at?: string | null
          context_data?: Json
          created_at?: string
          cycle_type?: string
          heartbeat_at?: string | null
          id?: string
          last_error?: string | null
          phase?: string
          phase_detail?: string
          phase_step?: string | null
          progress_current?: number | null
          progress_total?: number | null
          report_summary?: string | null
          started_at?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      karel_episodes: {
        Row: {
          actions_taken: string[]
          created_at: string
          derived_facts: string[]
          domain: string
          emotional_intensity: number
          hana_state: string
          id: string
          is_archived: boolean
          links_to_other_episodes: string[]
          outcome: string
          participants: string[]
          reasoning_notes: string
          source_conversation_id: string | null
          summary_karel: string
          summary_user: string
          tags: string[]
          timestamp_end: string | null
          timestamp_start: string
          user_id: string
        }
        Insert: {
          actions_taken?: string[]
          created_at?: string
          derived_facts?: string[]
          domain?: string
          emotional_intensity?: number
          hana_state?: string
          id?: string
          is_archived?: boolean
          links_to_other_episodes?: string[]
          outcome?: string
          participants?: string[]
          reasoning_notes?: string
          source_conversation_id?: string | null
          summary_karel?: string
          summary_user?: string
          tags?: string[]
          timestamp_end?: string | null
          timestamp_start?: string
          user_id?: string
        }
        Update: {
          actions_taken?: string[]
          created_at?: string
          derived_facts?: string[]
          domain?: string
          emotional_intensity?: number
          hana_state?: string
          id?: string
          is_archived?: boolean
          links_to_other_episodes?: string[]
          outcome?: string
          participants?: string[]
          reasoning_notes?: string
          source_conversation_id?: string | null
          summary_karel?: string
          summary_user?: string
          tags?: string[]
          timestamp_end?: string | null
          timestamp_start?: string
          user_id?: string
        }
        Relationships: []
      }
      karel_hana_conversations: {
        Row: {
          created_at: string
          current_domain: string
          current_hana_state: string
          id: string
          is_active: boolean
          last_activity_at: string
          messages: Json
          started_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          current_domain?: string
          current_hana_state?: string
          id?: string
          is_active?: boolean
          last_activity_at?: string
          messages?: Json
          started_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          current_domain?: string
          current_hana_state?: string
          id?: string
          is_active?: boolean
          last_activity_at?: string
          messages?: Json
          started_at?: string
          user_id?: string
        }
        Relationships: []
      }
      karel_memory_logs: {
        Row: {
          created_at: string
          details: Json
          episodes_created: number
          errors: string[]
          id: string
          log_type: string
          semantic_updates: number
          strategy_updates: number
          summary: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          details?: Json
          episodes_created?: number
          errors?: string[]
          id?: string
          log_type?: string
          semantic_updates?: number
          strategy_updates?: number
          summary?: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          details?: Json
          episodes_created?: number
          errors?: string[]
          id?: string
          log_type?: string
          semantic_updates?: number
          strategy_updates?: number
          summary?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      karel_semantic_entities: {
        Row: {
          created_at: string
          evidence_episodes: string[]
          id: string
          jmeno: string
          notes: string
          role_vuci_hance: string
          stabilni_vlastnosti: string[]
          typ: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          evidence_episodes?: string[]
          id: string
          jmeno: string
          notes?: string
          role_vuci_hance?: string
          stabilni_vlastnosti?: string[]
          typ?: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          evidence_episodes?: string[]
          id?: string
          jmeno?: string
          notes?: string
          role_vuci_hance?: string
          stabilni_vlastnosti?: string[]
          typ?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      karel_semantic_patterns: {
        Row: {
          confidence: number
          created_at: string
          description: string
          domain: string
          evidence_episodes: string[]
          id: string
          tags: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          confidence?: number
          created_at?: string
          description: string
          domain?: string
          evidence_episodes?: string[]
          id: string
          tags?: string[]
          updated_at?: string
          user_id?: string
        }
        Update: {
          confidence?: number
          created_at?: string
          description?: string
          domain?: string
          evidence_episodes?: string[]
          id?: string
          tags?: string[]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      karel_semantic_relations: {
        Row: {
          confidence: number
          created_at: string
          description: string
          evidence_episodes: string[]
          id: string
          object_id: string
          relation: string
          subject_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          confidence?: number
          created_at?: string
          description?: string
          evidence_episodes?: string[]
          id?: string
          object_id: string
          relation: string
          subject_id: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          confidence?: number
          created_at?: string
          description?: string
          evidence_episodes?: string[]
          id?: string
          object_id?: string
          relation?: string
          subject_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      karel_strategies: {
        Row: {
          created_at: string
          description: string
          domain: string
          effectiveness_score: number
          evidence_episodes: string[]
          example_phrases: string[]
          guidelines: string[]
          hana_state: string
          id: string
          required_tags_any: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          description: string
          domain?: string
          effectiveness_score?: number
          evidence_episodes?: string[]
          example_phrases?: string[]
          guidelines?: string[]
          hana_state?: string
          id: string
          required_tags_any?: string[]
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          description?: string
          domain?: string
          effectiveness_score?: number
          evidence_episodes?: string[]
          example_phrases?: string[]
          guidelines?: string[]
          hana_state?: string
          id?: string
          required_tags_any?: string[]
          updated_at?: string
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
      user_theme_preferences: {
        Row: {
          accent_color: string
          animations_enabled: boolean
          background_image_url: string | null
          border_radius: string
          chat_bubble_style: string
          compact_mode: boolean
          created_at: string
          dark_mode: boolean
          font_color: string
          font_family: string
          font_scale: number
          id: string
          persona: string
          primary_color: string
          theme_preset: string
          updated_at: string
          user_id: string
        }
        Insert: {
          accent_color?: string
          animations_enabled?: boolean
          background_image_url?: string | null
          border_radius?: string
          chat_bubble_style?: string
          compact_mode?: boolean
          created_at?: string
          dark_mode?: boolean
          font_color?: string
          font_family?: string
          font_scale?: number
          id?: string
          persona?: string
          primary_color?: string
          theme_preset?: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          accent_color?: string
          animations_enabled?: boolean
          background_image_url?: string | null
          border_radius?: string
          chat_bubble_style?: string
          compact_mode?: boolean
          created_at?: string
          dark_mode?: boolean
          font_color?: string
          font_family?: string
          font_scale?: number
          id?: string
          persona?: string
          primary_color?: string
          theme_preset?: string
          updated_at?: string
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

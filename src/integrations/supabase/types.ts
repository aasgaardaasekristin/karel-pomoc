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
      card_archive_log: {
        Row: {
          archive_file_name: string | null
          archived_block_count: number | null
          archived_sections: string[] | null
          backup_file_name: string | null
          created_at: string | null
          dry_run: boolean | null
          id: string
          new_size_kb: number | null
          original_size_kb: number | null
          part_id: string
        }
        Insert: {
          archive_file_name?: string | null
          archived_block_count?: number | null
          archived_sections?: string[] | null
          backup_file_name?: string | null
          created_at?: string | null
          dry_run?: boolean | null
          id?: string
          new_size_kb?: number | null
          original_size_kb?: number | null
          part_id: string
        }
        Update: {
          archive_file_name?: string | null
          archived_block_count?: number | null
          archived_sections?: string[] | null
          backup_file_name?: string | null
          created_at?: string | null
          dry_run?: boolean | null
          id?: string
          new_size_kb?: number | null
          original_size_kb?: number | null
          part_id?: string
        }
        Relationships: []
      }
      card_update_queue: {
        Row: {
          action: string
          applied: boolean
          created_at: string
          id: string
          new_content: string | null
          old_content: string | null
          part_id: string
          priority: number
          reason: string | null
          section: string
          source_date: string | null
          source_thread_id: string | null
          subsection: string | null
          user_id: string
        }
        Insert: {
          action?: string
          applied?: boolean
          created_at?: string
          id?: string
          new_content?: string | null
          old_content?: string | null
          part_id: string
          priority?: number
          reason?: string | null
          section: string
          source_date?: string | null
          source_thread_id?: string | null
          subsection?: string | null
          user_id?: string
        }
        Update: {
          action?: string
          applied?: boolean
          created_at?: string
          id?: string
          new_content?: string | null
          old_content?: string | null
          part_id?: string
          priority?: number
          reason?: string | null
          section?: string
          source_date?: string | null
          source_thread_id?: string | null
          subsection?: string | null
          user_id?: string
        }
        Relationships: []
      }
      client_analyses: {
        Row: {
          client_id: string
          content: string
          created_at: string | null
          id: string
          sessions_count: number | null
          summary: string | null
          user_id: string
          version: number | null
        }
        Insert: {
          client_id: string
          content: string
          created_at?: string | null
          id?: string
          sessions_count?: number | null
          summary?: string | null
          user_id?: string
          version?: number | null
        }
        Update: {
          client_id?: string
          content?: string
          created_at?: string | null
          id?: string
          sessions_count?: number | null
          summary?: string | null
          user_id?: string
          version?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "client_analyses_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
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
          material_ids: string[] | null
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
          material_ids?: string[] | null
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
          material_ids?: string[] | null
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
          answer: string | null
          client_id: string
          created_at: string
          due_date: string | null
          for_session: number | null
          id: string
          method: string | null
          notes: string | null
          priority: string
          result: string | null
          status: string
          task: string
          task_type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          answer?: string | null
          client_id: string
          created_at?: string
          due_date?: string | null
          for_session?: number | null
          id?: string
          method?: string | null
          notes?: string | null
          priority?: string
          result?: string | null
          status?: string
          task: string
          task_type?: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          answer?: string | null
          client_id?: string
          created_at?: string
          due_date?: string | null
          for_session?: number | null
          id?: string
          method?: string | null
          notes?: string | null
          priority?: string
          result?: string | null
          status?: string
          task?: string
          task_type?: string
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
          drive_doc_id: string | null
          drive_doc_url: string | null
          drive_last_synced_at: string | null
          family_context: string | null
          gender: string | null
          id: string
          key_history: string | null
          name: string
          notes: string | null
          referral_source: string | null
          therapy_plan: string | null
          therapy_type: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          age?: number | null
          created_at?: string
          diagnosis?: string | null
          drive_doc_id?: string | null
          drive_doc_url?: string | null
          drive_last_synced_at?: string | null
          family_context?: string | null
          gender?: string | null
          id?: string
          key_history?: string | null
          name: string
          notes?: string | null
          referral_source?: string | null
          therapy_plan?: string | null
          therapy_type?: string | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          age?: number | null
          created_at?: string
          diagnosis?: string | null
          drive_doc_id?: string | null
          drive_doc_url?: string | null
          drive_last_synced_at?: string | null
          family_context?: string | null
          gender?: string | null
          id?: string
          key_history?: string | null
          name?: string
          notes?: string | null
          referral_source?: string | null
          therapy_plan?: string | null
          therapy_type?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      crisis_alerts: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          conversation_excerpts: string | null
          conversation_id: string | null
          created_at: string
          crisis_thread_id: string | null
          id: string
          intervention_plan: string | null
          karel_assessment: string | null
          part_name: string
          resolution_notes: string | null
          resolved_at: string | null
          severity: string
          status: string
          summary: string
          trigger_signals: string[] | null
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          conversation_excerpts?: string | null
          conversation_id?: string | null
          created_at?: string
          crisis_thread_id?: string | null
          id?: string
          intervention_plan?: string | null
          karel_assessment?: string | null
          part_name: string
          resolution_notes?: string | null
          resolved_at?: string | null
          severity: string
          status?: string
          summary: string
          trigger_signals?: string[] | null
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          conversation_excerpts?: string | null
          conversation_id?: string | null
          created_at?: string
          crisis_thread_id?: string | null
          id?: string
          intervention_plan?: string | null
          karel_assessment?: string | null
          part_name?: string
          resolution_notes?: string | null
          resolved_at?: string | null
          severity?: string
          status?: string
          summary?: string
          trigger_signals?: string[] | null
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
      crisis_tasks: {
        Row: {
          assigned_to: string
          completed_at: string | null
          created_at: string
          crisis_alert_id: string
          description: string | null
          id: string
          priority: string
          status: string
          title: string
        }
        Insert: {
          assigned_to: string
          completed_at?: string | null
          created_at?: string
          crisis_alert_id: string
          description?: string | null
          id?: string
          priority?: string
          status?: string
          title: string
        }
        Update: {
          assigned_to?: string
          completed_at?: string | null
          created_at?: string
          crisis_alert_id?: string
          description?: string | null
          id?: string
          priority?: string
          status?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "crisis_tasks_crisis_alert_id_fkey"
            columns: ["crisis_alert_id"]
            isOneToOne: false
            referencedRelation: "crisis_alerts"
            referencedColumns: ["id"]
          },
        ]
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
      did_daily_context: {
        Row: {
          analysis_json: Json | null
          context_date: string
          context_json: Json
          created_at: string
          id: string
          source: string
          updated_at: string
          user_id: string
        }
        Insert: {
          analysis_json?: Json | null
          context_date?: string
          context_json?: Json
          created_at?: string
          id?: string
          source?: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          analysis_json?: Json | null
          context_date?: string
          context_json?: Json
          created_at?: string
          id?: string
          source?: string
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
      did_daily_session_plans: {
        Row: {
          completed_at: string | null
          created_at: string
          distributed_drive: boolean
          distributed_email: boolean
          generated_by: string
          id: string
          overdue_days: number
          part_tier: string
          plan_date: string
          plan_html: string
          plan_markdown: string
          selected_part: string
          session_format: string
          session_lead: string
          status: string
          therapist: string
          updated_at: string
          urgency_breakdown: Json
          urgency_score: number
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          distributed_drive?: boolean
          distributed_email?: boolean
          generated_by?: string
          id?: string
          overdue_days?: number
          part_tier?: string
          plan_date?: string
          plan_html?: string
          plan_markdown?: string
          selected_part: string
          session_format?: string
          session_lead?: string
          status?: string
          therapist?: string
          updated_at?: string
          urgency_breakdown?: Json
          urgency_score?: number
          user_id?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          distributed_drive?: boolean
          distributed_email?: boolean
          generated_by?: string
          id?: string
          overdue_days?: number
          part_tier?: string
          plan_date?: string
          plan_html?: string
          plan_markdown?: string
          selected_part?: string
          session_format?: string
          session_lead?: string
          status?: string
          therapist?: string
          updated_at?: string
          urgency_breakdown?: Json
          urgency_score?: number
          user_id?: string
        }
        Relationships: []
      }
      did_doc_sync_log: {
        Row: {
          content_written: string
          created_at: string
          error_message: string | null
          id: string
          source_id: string
          source_type: string
          success: boolean | null
          target_document: string
        }
        Insert: {
          content_written: string
          created_at?: string
          error_message?: string | null
          id?: string
          source_id: string
          source_type: string
          success?: boolean | null
          target_document: string
        }
        Update: {
          content_written?: string
          created_at?: string
          error_message?: string | null
          id?: string
          source_id?: string
          source_type?: string
          success?: boolean | null
          target_document?: string
        }
        Relationships: []
      }
      did_implications: {
        Row: {
          created_at: string
          destinations: string[]
          expires_at: string | null
          id: string
          impact_type: string
          implication_text: string
          observation_id: string
          owner: string | null
          review_at: string | null
          status: string | null
          synced: boolean | null
          synced_at: string | null
        }
        Insert: {
          created_at?: string
          destinations?: string[]
          expires_at?: string | null
          id?: string
          impact_type: string
          implication_text: string
          observation_id: string
          owner?: string | null
          review_at?: string | null
          status?: string | null
          synced?: boolean | null
          synced_at?: string | null
        }
        Update: {
          created_at?: string
          destinations?: string[]
          expires_at?: string | null
          id?: string
          impact_type?: string
          implication_text?: string
          observation_id?: string
          owner?: string | null
          review_at?: string | null
          status?: string | null
          synced?: boolean | null
          synced_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "did_implications_observation_id_fkey"
            columns: ["observation_id"]
            isOneToOne: false
            referencedRelation: "did_observations"
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
      did_observations: {
        Row: {
          confidence: number | null
          created_at: string
          evidence_level: string
          fact: string
          id: string
          processed: boolean | null
          processed_at: string | null
          source_ref: string | null
          source_type: string
          status: string
          subject_id: string
          subject_type: string
          time_horizon: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          evidence_level?: string
          fact: string
          id?: string
          processed?: boolean | null
          processed_at?: string | null
          source_ref?: string | null
          source_type: string
          status?: string
          subject_id: string
          subject_type: string
          time_horizon?: string
        }
        Update: {
          confidence?: number | null
          created_at?: string
          evidence_level?: string
          fact?: string
          id?: string
          processed?: boolean | null
          processed_at?: string | null
          source_ref?: string | null
          source_type?: string
          status?: string
          subject_id?: string
          subject_type?: string
          time_horizon?: string
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
          handoff_note: string | null
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
          handoff_note?: string | null
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
          handoff_note?: string | null
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
      did_pending_questions: {
        Row: {
          answer: string | null
          answer_destinations: string[] | null
          answered_at: string | null
          answered_by: string | null
          blocking: string | null
          context: string | null
          created_at: string
          directed_to: string | null
          expires_at: string | null
          id: string
          question: string
          status: string | null
          subject_id: string | null
          subject_type: string | null
        }
        Insert: {
          answer?: string | null
          answer_destinations?: string[] | null
          answered_at?: string | null
          answered_by?: string | null
          blocking?: string | null
          context?: string | null
          created_at?: string
          directed_to?: string | null
          expires_at?: string | null
          id?: string
          question: string
          status?: string | null
          subject_id?: string | null
          subject_type?: string | null
        }
        Update: {
          answer?: string | null
          answer_destinations?: string[] | null
          answered_at?: string | null
          answered_by?: string | null
          blocking?: string | null
          context?: string | null
          created_at?: string
          directed_to?: string | null
          expires_at?: string | null
          id?: string
          question?: string
          status?: string | null
          subject_id?: string | null
          subject_type?: string | null
        }
        Relationships: []
      }
      did_plan_items: {
        Row: {
          action_required: string | null
          activation_conditions: string | null
          assigned_to: string | null
          content: string
          created_at: string
          due_date: string | null
          expires_at: string | null
          id: string
          plan_type: string
          priority: string | null
          promotion_criteria: string | null
          review_at: string
          section: string
          source_implication_id: string | null
          source_observation_ids: string[] | null
          status: string | null
          subject_id: string | null
          subject_type: string | null
          updated_at: string
        }
        Insert: {
          action_required?: string | null
          activation_conditions?: string | null
          assigned_to?: string | null
          content: string
          created_at?: string
          due_date?: string | null
          expires_at?: string | null
          id?: string
          plan_type: string
          priority?: string | null
          promotion_criteria?: string | null
          review_at: string
          section: string
          source_implication_id?: string | null
          source_observation_ids?: string[] | null
          status?: string | null
          subject_id?: string | null
          subject_type?: string | null
          updated_at?: string
        }
        Update: {
          action_required?: string | null
          activation_conditions?: string | null
          assigned_to?: string | null
          content?: string
          created_at?: string
          due_date?: string | null
          expires_at?: string | null
          id?: string
          plan_type?: string
          priority?: string | null
          promotion_criteria?: string | null
          review_at?: string
          section?: string
          source_implication_id?: string | null
          source_observation_ids?: string[] | null
          status?: string | null
          subject_id?: string | null
          subject_type?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "did_plan_items_source_implication_id_fkey"
            columns: ["source_implication_id"]
            isOneToOne: false
            referencedRelation: "did_implications"
            referencedColumns: ["id"]
          },
        ]
      }
      did_profile_claims: {
        Row: {
          card_section: string
          claim_text: string
          claim_type: string
          confidence: number | null
          confirmation_count: number | null
          created_at: string
          evidence_level: string
          id: string
          last_confirmed_at: string | null
          part_name: string
          source_observation_ids: string[] | null
          status: string | null
          superseded_by: string | null
          updated_at: string
        }
        Insert: {
          card_section: string
          claim_text: string
          claim_type: string
          confidence?: number | null
          confirmation_count?: number | null
          created_at?: string
          evidence_level?: string
          id?: string
          last_confirmed_at?: string | null
          part_name: string
          source_observation_ids?: string[] | null
          status?: string | null
          superseded_by?: string | null
          updated_at?: string
        }
        Update: {
          card_section?: string
          claim_text?: string
          claim_type?: string
          confidence?: number | null
          confirmation_count?: number | null
          created_at?: string
          evidence_level?: string
          id?: string
          last_confirmed_at?: string | null
          part_name?: string
          source_observation_ids?: string[] | null
          status?: string | null
          superseded_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "did_profile_claims_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "did_profile_claims"
            referencedColumns: ["id"]
          },
        ]
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
      did_supervision_reports: {
        Row: {
          created_at: string
          id: string
          meta_json: Json
          period_days: number
          report_markdown: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          meta_json?: Json
          period_days?: number
          report_markdown: string
          user_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          meta_json?: Json
          period_days?: number
          report_markdown?: string
          user_id?: string
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
      did_tasks: {
        Row: {
          assigned_to: string
          completed_at: string | null
          created_at: string | null
          description: string
          due_date: string | null
          follow_up_needed: boolean | null
          id: string
          priority: string | null
          related_part: string | null
          response: string | null
          source: string | null
          status: string | null
          task_type: string
          user_id: string
        }
        Insert: {
          assigned_to: string
          completed_at?: string | null
          created_at?: string | null
          description: string
          due_date?: string | null
          follow_up_needed?: boolean | null
          id?: string
          priority?: string | null
          related_part?: string | null
          response?: string | null
          source?: string | null
          status?: string | null
          task_type: string
          user_id?: string
        }
        Update: {
          assigned_to?: string
          completed_at?: string | null
          created_at?: string | null
          description?: string
          due_date?: string | null
          follow_up_needed?: boolean | null
          id?: string
          priority?: string | null
          related_part?: string | null
          response?: string | null
          source?: string | null
          status?: string | null
          task_type?: string
          user_id?: string
        }
        Relationships: []
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
          task_tier: string
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
          task_tier?: string
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
          task_tier?: string
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
          job_type: string
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
          job_type?: string
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
          job_type?: string
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
      session_materials: {
        Row: {
          analysis: string | null
          client_id: string
          created_at: string | null
          id: string
          label: string | null
          material_type: string
          session_id: string | null
          session_number: number | null
          storage_url: string
          tags: string[] | null
          user_id: string
        }
        Insert: {
          analysis?: string | null
          client_id: string
          created_at?: string | null
          id?: string
          label?: string | null
          material_type: string
          session_id?: string | null
          session_number?: number | null
          storage_url: string
          tags?: string[] | null
          user_id?: string
        }
        Update: {
          analysis?: string | null
          client_id?: string
          created_at?: string | null
          id?: string
          label?: string | null
          material_type?: string
          session_id?: string | null
          session_number?: number | null
          storage_url?: string
          tags?: string[] | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_materials_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_materials_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "client_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      session_media: {
        Row: {
          ai_analysis: Json | null
          client_id: string
          created_at: string | null
          id: string
          media_type: string
          original_filename: string | null
          session_date: string
          storage_path: string
          user_id: string
        }
        Insert: {
          ai_analysis?: Json | null
          client_id: string
          created_at?: string | null
          id?: string
          media_type: string
          original_filename?: string | null
          session_date?: string
          storage_path: string
          user_id?: string
        }
        Update: {
          ai_analysis?: Json | null
          client_id?: string
          created_at?: string | null
          id?: string
          media_type?: string
          original_filename?: string | null
          session_date?: string
          storage_path?: string
          user_id?: string
        }
        Relationships: []
      }
      session_preparations: {
        Row: {
          approved_at: string | null
          client_id: string
          created_at: string | null
          id: string
          notes: string | null
          plan: Json
          session_number: number | null
          user_id: string
        }
        Insert: {
          approved_at?: string | null
          client_id: string
          created_at?: string | null
          id?: string
          notes?: string | null
          plan: Json
          session_number?: number | null
          user_id?: string
        }
        Update: {
          approved_at?: string | null
          client_id?: string
          created_at?: string | null
          id?: string
          notes?: string | null
          plan?: Json
          session_number?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_preparations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      session_preps: {
        Row: {
          client_id: string
          created_at: string
          id: string
          plan_content: string
          session_number: number | null
          user_id: string
        }
        Insert: {
          client_id: string
          created_at?: string
          id?: string
          plan_content?: string
          session_number?: number | null
          user_id?: string
        }
        Update: {
          client_id?: string
          created_at?: string
          id?: string
          plan_content?: string
          session_number?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_preps_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      shadow_sync_log: {
        Row: {
          created_at: string | null
          error: string | null
          files_written: string[] | null
          id: string
          messages_processed: number | null
          success: boolean | null
          therapist: string
          threads_deleted: number | null
          threads_processed: number | null
        }
        Insert: {
          created_at?: string | null
          error?: string | null
          files_written?: string[] | null
          id?: string
          messages_processed?: number | null
          success?: boolean | null
          therapist: string
          threads_deleted?: number | null
          threads_processed?: number | null
        }
        Update: {
          created_at?: string | null
          error?: string | null
          files_written?: string[] | null
          id?: string
          messages_processed?: number | null
          success?: boolean | null
          therapist?: string
          threads_deleted?: number | null
          threads_processed?: number | null
        }
        Relationships: []
      }
      thread_processing_log: {
        Row: {
          created_at: string
          id: string
          notes: Json | null
          part_id: string
          processed_at: string | null
          processing_type: string
          status: string
          thread_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          notes?: Json | null
          part_id: string
          processed_at?: string | null
          processing_type?: string
          status?: string
          thread_id: string
          user_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          notes?: Json | null
          part_id?: string
          processed_at?: string | null
          processing_type?: string
          status?: string
          thread_id?: string
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
          context_key: string
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
          context_key?: string
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
          context_key?: string
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

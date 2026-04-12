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
      ai_error_log: {
        Row: {
          caller: string
          context: Json | null
          created_at: string | null
          error_message: string | null
          error_type: string
          id: string
          raw_input: string | null
          raw_output: string | null
        }
        Insert: {
          caller: string
          context?: Json | null
          created_at?: string | null
          error_message?: string | null
          error_type: string
          id?: string
          raw_input?: string | null
          raw_output?: string | null
        }
        Update: {
          caller?: string
          context?: Json | null
          created_at?: string | null
          error_message?: string | null
          error_type?: string
          id?: string
          raw_input?: string | null
          raw_output?: string | null
        }
        Relationships: []
      }
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
      card_cleanup_log: {
        Row: {
          cleanup_summary: string | null
          created_at: string | null
          duplicates_removed: number | null
          id: string
          moved_entity_names: string[] | null
          moved_to_other_card: number | null
          part_name: string
          redistributions_integrated: number | null
          tests_removed: number | null
          user_id: string | null
        }
        Insert: {
          cleanup_summary?: string | null
          created_at?: string | null
          duplicates_removed?: number | null
          id?: string
          moved_entity_names?: string[] | null
          moved_to_other_card?: number | null
          part_name: string
          redistributions_integrated?: number | null
          tests_removed?: number | null
          user_id?: string | null
        }
        Update: {
          cleanup_summary?: string | null
          created_at?: string | null
          duplicates_removed?: number | null
          id?: string
          moved_entity_names?: string[] | null
          moved_to_other_card?: number | null
          part_name?: string
          redistributions_integrated?: number | null
          tests_removed?: number | null
          user_id?: string | null
        }
        Relationships: []
      }
      card_crosswrite_queue: {
        Row: {
          action: string
          content: string
          created_at: string | null
          id: string
          processed_at: string | null
          source_part: string
          status: string | null
          target_file: string
        }
        Insert: {
          action: string
          content: string
          created_at?: string | null
          id?: string
          processed_at?: string | null
          source_part: string
          status?: string | null
          target_file: string
        }
        Update: {
          action?: string
          content?: string
          created_at?: string | null
          id?: string
          processed_at?: string | null
          source_part?: string
          status?: string | null
          target_file?: string
        }
        Relationships: []
      }
      card_update_log: {
        Row: {
          contradictions_found: number | null
          created_at: string | null
          cross_writes: string[] | null
          error: string | null
          id: string
          new_therapy_methods_added: number | null
          part_name: string
          processing_time_ms: number | null
          profile_updated: boolean | null
          sections_skipped: string[] | null
          sections_updated: string[] | null
          web_searches_performed: number | null
        }
        Insert: {
          contradictions_found?: number | null
          created_at?: string | null
          cross_writes?: string[] | null
          error?: string | null
          id?: string
          new_therapy_methods_added?: number | null
          part_name: string
          processing_time_ms?: number | null
          profile_updated?: boolean | null
          sections_skipped?: string[] | null
          sections_updated?: string[] | null
          web_searches_performed?: number | null
        }
        Update: {
          contradictions_found?: number | null
          created_at?: string | null
          cross_writes?: string[] | null
          error?: string | null
          id?: string
          new_therapy_methods_added?: number | null
          part_name?: string
          processing_time_ms?: number | null
          profile_updated?: boolean | null
          sections_skipped?: string[] | null
          sections_updated?: string[] | null
          web_searches_performed?: number | null
        }
        Relationships: []
      }
      card_update_processed_threads: {
        Row: {
          created_at: string | null
          id: string
          last_processed_at: string | null
          last_processed_message_id: string | null
          part_name: string
          thread_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          last_processed_at?: string | null
          last_processed_message_id?: string | null
          part_name: string
          thread_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          last_processed_at?: string | null
          last_processed_message_id?: string | null
          part_name?: string
          thread_id?: string
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
      context_cache: {
        Row: {
          cache_key: string
          context_data: Json
          created_at: string
          expires_at: string
          function_name: string
          id: string
          user_id: string
        }
        Insert: {
          cache_key?: string
          context_data: Json
          created_at?: string
          expires_at: string
          function_name: string
          id?: string
          user_id: string
        }
        Update: {
          cache_key?: string
          context_data?: Json
          created_at?: string
          expires_at?: string
          function_name?: string
          id?: string
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
          days_in_crisis: number | null
          id: string
          intervention_plan: string | null
          karel_assessment: string | null
          part_name: string
          post_crisis_monitoring_until: string | null
          resolution_assessment_id: string | null
          resolution_date: string | null
          resolution_method: string | null
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
          days_in_crisis?: number | null
          id?: string
          intervention_plan?: string | null
          karel_assessment?: string | null
          part_name: string
          post_crisis_monitoring_until?: string | null
          resolution_assessment_id?: string | null
          resolution_date?: string | null
          resolution_method?: string | null
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
          days_in_crisis?: number | null
          id?: string
          intervention_plan?: string | null
          karel_assessment?: string | null
          part_name?: string
          post_crisis_monitoring_until?: string | null
          resolution_assessment_id?: string | null
          resolution_date?: string | null
          resolution_method?: string | null
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
      crisis_closure_checklist: {
        Row: {
          created_at: string | null
          crisis_alert_id: string | null
          crisis_event_id: string | null
          decided_at: string | null
          emotional_stable_days: number | null
          final_decision: string | null
          grounding_works: boolean | null
          hanka_agrees: boolean | null
          id: string
          karel_closure_recommendation: string | null
          karel_diagnostic_date: string | null
          karel_diagnostic_done: boolean | null
          karel_recommends_closure: boolean | null
          kata_agrees: boolean | null
          no_open_questions: boolean | null
          no_risk_signals: boolean | null
          relapse_plan_exists: boolean | null
          trigger_managed: boolean | null
        }
        Insert: {
          created_at?: string | null
          crisis_alert_id?: string | null
          crisis_event_id?: string | null
          decided_at?: string | null
          emotional_stable_days?: number | null
          final_decision?: string | null
          grounding_works?: boolean | null
          hanka_agrees?: boolean | null
          id?: string
          karel_closure_recommendation?: string | null
          karel_diagnostic_date?: string | null
          karel_diagnostic_done?: boolean | null
          karel_recommends_closure?: boolean | null
          kata_agrees?: boolean | null
          no_open_questions?: boolean | null
          no_risk_signals?: boolean | null
          relapse_plan_exists?: boolean | null
          trigger_managed?: boolean | null
        }
        Update: {
          created_at?: string | null
          crisis_alert_id?: string | null
          crisis_event_id?: string | null
          decided_at?: string | null
          emotional_stable_days?: number | null
          final_decision?: string | null
          grounding_works?: boolean | null
          hanka_agrees?: boolean | null
          id?: string
          karel_closure_recommendation?: string | null
          karel_diagnostic_date?: string | null
          karel_diagnostic_done?: boolean | null
          karel_recommends_closure?: boolean | null
          kata_agrees?: boolean | null
          no_open_questions?: boolean | null
          no_risk_signals?: boolean | null
          relapse_plan_exists?: boolean | null
          trigger_managed?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "crisis_closure_checklist_crisis_alert_id_fkey"
            columns: ["crisis_alert_id"]
            isOneToOne: false
            referencedRelation: "crisis_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crisis_closure_checklist_crisis_event_id_fkey"
            columns: ["crisis_event_id"]
            isOneToOne: false
            referencedRelation: "crisis_events"
            referencedColumns: ["id"]
          },
        ]
      }
      crisis_daily_assessments: {
        Row: {
          assessment_date: string
          assessment_method: string | null
          created_at: string | null
          crisis_alert_id: string
          crisis_event_id: string | null
          day_number: number
          id: string
          karel_decision: string | null
          karel_reasoning: string | null
          karel_risk_assessment: string | null
          next_day_plan: Json | null
          part_cooperation_level: string | null
          part_emotional_state: number | null
          part_interview_summary: string | null
          part_name: string
          part_risk_indicators: Json | null
          tests_administered: Json | null
          therapist_hana_input: string | null
          therapist_hana_observation: string | null
          therapist_hana_risk_rating: number | null
          therapist_kata_input: string | null
          therapist_kata_observation: string | null
          therapist_kata_risk_rating: number | null
          updated_at: string | null
        }
        Insert: {
          assessment_date?: string
          assessment_method?: string | null
          created_at?: string | null
          crisis_alert_id: string
          crisis_event_id?: string | null
          day_number?: number
          id?: string
          karel_decision?: string | null
          karel_reasoning?: string | null
          karel_risk_assessment?: string | null
          next_day_plan?: Json | null
          part_cooperation_level?: string | null
          part_emotional_state?: number | null
          part_interview_summary?: string | null
          part_name: string
          part_risk_indicators?: Json | null
          tests_administered?: Json | null
          therapist_hana_input?: string | null
          therapist_hana_observation?: string | null
          therapist_hana_risk_rating?: number | null
          therapist_kata_input?: string | null
          therapist_kata_observation?: string | null
          therapist_kata_risk_rating?: number | null
          updated_at?: string | null
        }
        Update: {
          assessment_date?: string
          assessment_method?: string | null
          created_at?: string | null
          crisis_alert_id?: string
          crisis_event_id?: string | null
          day_number?: number
          id?: string
          karel_decision?: string | null
          karel_reasoning?: string | null
          karel_risk_assessment?: string | null
          next_day_plan?: Json | null
          part_cooperation_level?: string | null
          part_emotional_state?: number | null
          part_interview_summary?: string | null
          part_name?: string
          part_risk_indicators?: Json | null
          tests_administered?: Json | null
          therapist_hana_input?: string | null
          therapist_hana_observation?: string | null
          therapist_hana_risk_rating?: number | null
          therapist_kata_input?: string | null
          therapist_kata_observation?: string | null
          therapist_kata_risk_rating?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "crisis_daily_assessments_crisis_alert_id_fkey"
            columns: ["crisis_alert_id"]
            isOneToOne: false
            referencedRelation: "crisis_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crisis_daily_assessments_crisis_event_id_fkey"
            columns: ["crisis_event_id"]
            isOneToOne: false
            referencedRelation: "crisis_events"
            referencedColumns: ["id"]
          },
        ]
      }
      crisis_events: {
        Row: {
          afternoon_review_notes: string | null
          awaiting_response_from: string[] | null
          awaiting_response_from_therapists: Json | null
          banner_dismissed: boolean | null
          banner_dismissed_at: string | null
          clinical_summary: string | null
          closed_at: string | null
          closure_approved_at: string | null
          closure_approved_by: string[] | null
          closure_meeting_id: string | null
          closure_proposed_at: string | null
          closure_proposed_by: string | null
          closure_reason: string | null
          closure_statement: string | null
          created_at: string | null
          crisis_meeting_reason: string | null
          crisis_meeting_required: boolean | null
          daily_checklist: Json | null
          days_active: number | null
          diagnostic_date: string | null
          diagnostic_report: string | null
          diagnostic_score: number | null
          diagnostic_session_id: string | null
          evening_decision_notes: string | null
          id: string
          indicator_coherence: number | null
          indicator_emotional_regulation: number | null
          indicator_safety: number | null
          indicator_time_orientation: number | null
          indicator_trust: number | null
          intervention_result_completeness: number | null
          last_afternoon_review_at: string | null
          last_evening_decision_at: string | null
          last_morning_review_at: string | null
          last_outcome_recorded_at: string | null
          morning_review_notes: string | null
          next_day_plan_notes: string | null
          opened_at: string | null
          operating_state: string | null
          ownership_source: string | null
          part_name: string
          phase: string
          post_session_review_notes: string | null
          primary_therapist: string | null
          required_outputs_today: Json | null
          secondary_therapist: string | null
          sessions_count: number | null
          severity: string
          stable_since: string | null
          today_required_outputs: Json | null
          trigger_description: string
          trigger_resolved: boolean | null
          trigger_source: string | null
          updated_at: string | null
        }
        Insert: {
          afternoon_review_notes?: string | null
          awaiting_response_from?: string[] | null
          awaiting_response_from_therapists?: Json | null
          banner_dismissed?: boolean | null
          banner_dismissed_at?: string | null
          clinical_summary?: string | null
          closed_at?: string | null
          closure_approved_at?: string | null
          closure_approved_by?: string[] | null
          closure_meeting_id?: string | null
          closure_proposed_at?: string | null
          closure_proposed_by?: string | null
          closure_reason?: string | null
          closure_statement?: string | null
          created_at?: string | null
          crisis_meeting_reason?: string | null
          crisis_meeting_required?: boolean | null
          daily_checklist?: Json | null
          days_active?: number | null
          diagnostic_date?: string | null
          diagnostic_report?: string | null
          diagnostic_score?: number | null
          diagnostic_session_id?: string | null
          evening_decision_notes?: string | null
          id?: string
          indicator_coherence?: number | null
          indicator_emotional_regulation?: number | null
          indicator_safety?: number | null
          indicator_time_orientation?: number | null
          indicator_trust?: number | null
          intervention_result_completeness?: number | null
          last_afternoon_review_at?: string | null
          last_evening_decision_at?: string | null
          last_morning_review_at?: string | null
          last_outcome_recorded_at?: string | null
          morning_review_notes?: string | null
          next_day_plan_notes?: string | null
          opened_at?: string | null
          operating_state?: string | null
          ownership_source?: string | null
          part_name: string
          phase?: string
          post_session_review_notes?: string | null
          primary_therapist?: string | null
          required_outputs_today?: Json | null
          secondary_therapist?: string | null
          sessions_count?: number | null
          severity?: string
          stable_since?: string | null
          today_required_outputs?: Json | null
          trigger_description: string
          trigger_resolved?: boolean | null
          trigger_source?: string | null
          updated_at?: string | null
        }
        Update: {
          afternoon_review_notes?: string | null
          awaiting_response_from?: string[] | null
          awaiting_response_from_therapists?: Json | null
          banner_dismissed?: boolean | null
          banner_dismissed_at?: string | null
          clinical_summary?: string | null
          closed_at?: string | null
          closure_approved_at?: string | null
          closure_approved_by?: string[] | null
          closure_meeting_id?: string | null
          closure_proposed_at?: string | null
          closure_proposed_by?: string | null
          closure_reason?: string | null
          closure_statement?: string | null
          created_at?: string | null
          crisis_meeting_reason?: string | null
          crisis_meeting_required?: boolean | null
          daily_checklist?: Json | null
          days_active?: number | null
          diagnostic_date?: string | null
          diagnostic_report?: string | null
          diagnostic_score?: number | null
          diagnostic_session_id?: string | null
          evening_decision_notes?: string | null
          id?: string
          indicator_coherence?: number | null
          indicator_emotional_regulation?: number | null
          indicator_safety?: number | null
          indicator_time_orientation?: number | null
          indicator_trust?: number | null
          intervention_result_completeness?: number | null
          last_afternoon_review_at?: string | null
          last_evening_decision_at?: string | null
          last_morning_review_at?: string | null
          last_outcome_recorded_at?: string | null
          morning_review_notes?: string | null
          next_day_plan_notes?: string | null
          opened_at?: string | null
          operating_state?: string | null
          ownership_source?: string | null
          part_name?: string
          phase?: string
          post_session_review_notes?: string | null
          primary_therapist?: string | null
          required_outputs_today?: Json | null
          secondary_therapist?: string | null
          sessions_count?: number | null
          severity?: string
          stable_since?: string | null
          today_required_outputs?: Json | null
          trigger_description?: string
          trigger_resolved?: boolean | null
          trigger_source?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_crisis_events_closure_meeting"
            columns: ["closure_meeting_id"]
            isOneToOne: false
            referencedRelation: "did_meetings"
            referencedColumns: ["id"]
          },
        ]
      }
      crisis_intervention_sessions: {
        Row: {
          assessment_id: string | null
          conducted_at: string | null
          created_at: string | null
          crisis_alert_id: string
          crisis_event_id: string | null
          follow_up_needed: boolean | null
          follow_up_notes: string | null
          id: string
          key_findings: Json | null
          part_name: string
          protective_factors_found: Json | null
          risk_indicators_found: Json | null
          session_outcome: string | null
          session_summary: string | null
          session_type: string
          thread_id: string | null
        }
        Insert: {
          assessment_id?: string | null
          conducted_at?: string | null
          created_at?: string | null
          crisis_alert_id: string
          crisis_event_id?: string | null
          follow_up_needed?: boolean | null
          follow_up_notes?: string | null
          id?: string
          key_findings?: Json | null
          part_name: string
          protective_factors_found?: Json | null
          risk_indicators_found?: Json | null
          session_outcome?: string | null
          session_summary?: string | null
          session_type: string
          thread_id?: string | null
        }
        Update: {
          assessment_id?: string | null
          conducted_at?: string | null
          created_at?: string | null
          crisis_alert_id?: string
          crisis_event_id?: string | null
          follow_up_needed?: boolean | null
          follow_up_notes?: string | null
          id?: string
          key_findings?: Json | null
          part_name?: string
          protective_factors_found?: Json | null
          risk_indicators_found?: Json | null
          session_outcome?: string | null
          session_summary?: string | null
          session_type?: string
          thread_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "crisis_intervention_sessions_assessment_id_fkey"
            columns: ["assessment_id"]
            isOneToOne: false
            referencedRelation: "crisis_daily_assessments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crisis_intervention_sessions_crisis_alert_id_fkey"
            columns: ["crisis_alert_id"]
            isOneToOne: false
            referencedRelation: "crisis_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crisis_intervention_sessions_crisis_event_id_fkey"
            columns: ["crisis_event_id"]
            isOneToOne: false
            referencedRelation: "crisis_events"
            referencedColumns: ["id"]
          },
        ]
      }
      crisis_journal: {
        Row: {
          created_at: string | null
          crisis_alert_id: string | null
          crisis_event_id: string | null
          crisis_trend: string | null
          date: string | null
          day_number: number | null
          hanka_cooperation: string | null
          id: string
          karel_action: string | null
          karel_notes: string | null
          kata_cooperation: string | null
          part_id: string | null
          session_summary: string | null
          what_failed: string | null
          what_worked: string | null
        }
        Insert: {
          created_at?: string | null
          crisis_alert_id?: string | null
          crisis_event_id?: string | null
          crisis_trend?: string | null
          date?: string | null
          day_number?: number | null
          hanka_cooperation?: string | null
          id?: string
          karel_action?: string | null
          karel_notes?: string | null
          kata_cooperation?: string | null
          part_id?: string | null
          session_summary?: string | null
          what_failed?: string | null
          what_worked?: string | null
        }
        Update: {
          created_at?: string | null
          crisis_alert_id?: string | null
          crisis_event_id?: string | null
          crisis_trend?: string | null
          date?: string | null
          day_number?: number | null
          hanka_cooperation?: string | null
          id?: string
          karel_action?: string | null
          karel_notes?: string | null
          kata_cooperation?: string | null
          part_id?: string | null
          session_summary?: string | null
          what_failed?: string | null
          what_worked?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "crisis_journal_crisis_alert_id_fkey"
            columns: ["crisis_alert_id"]
            isOneToOne: false
            referencedRelation: "crisis_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crisis_journal_crisis_event_id_fkey"
            columns: ["crisis_event_id"]
            isOneToOne: false
            referencedRelation: "crisis_events"
            referencedColumns: ["id"]
          },
        ]
      }
      crisis_karel_interviews: {
        Row: {
          completed_at: string | null
          created_at: string
          crisis_event_id: string
          hidden_diagnostic_hypotheses: Json | null
          id: string
          interview_goal: string | null
          interview_type: string
          karel_decision_after_interview: string | null
          next_required_actions: Json | null
          observed_coherence: number | null
          observed_regulation: number | null
          observed_risk_signals: string[] | null
          observed_somatic_state: string | null
          observed_trust: number | null
          part_name: string
          stabilization_methods_used: string[] | null
          started_at: string | null
          summary_for_team: string | null
          what_remains_unclear: string | null
          what_shifted: string | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          crisis_event_id: string
          hidden_diagnostic_hypotheses?: Json | null
          id?: string
          interview_goal?: string | null
          interview_type?: string
          karel_decision_after_interview?: string | null
          next_required_actions?: Json | null
          observed_coherence?: number | null
          observed_regulation?: number | null
          observed_risk_signals?: string[] | null
          observed_somatic_state?: string | null
          observed_trust?: number | null
          part_name: string
          stabilization_methods_used?: string[] | null
          started_at?: string | null
          summary_for_team?: string | null
          what_remains_unclear?: string | null
          what_shifted?: string | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          crisis_event_id?: string
          hidden_diagnostic_hypotheses?: Json | null
          id?: string
          interview_goal?: string | null
          interview_type?: string
          karel_decision_after_interview?: string | null
          next_required_actions?: Json | null
          observed_coherence?: number | null
          observed_regulation?: number | null
          observed_risk_signals?: string[] | null
          observed_somatic_state?: string | null
          observed_trust?: number | null
          part_name?: string
          stabilization_methods_used?: string[] | null
          started_at?: string | null
          summary_for_team?: string | null
          what_remains_unclear?: string | null
          what_shifted?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "crisis_karel_interviews_crisis_event_id_fkey"
            columns: ["crisis_event_id"]
            isOneToOne: false
            referencedRelation: "crisis_events"
            referencedColumns: ["id"]
          },
        ]
      }
      crisis_session_logs: {
        Row: {
          coherence_score: number | null
          color_test_result: string | null
          created_at: string | null
          crisis_id: string | null
          emotional_regulation_ok: boolean | null
          future_mentions: boolean | null
          id: string
          karel_notes: string | null
          positive_signals: string[] | null
          projective_story_result: string | null
          reality_testing_ok: boolean | null
          risk_signals: string[] | null
          safety_ok: boolean | null
          scaling_score: number | null
          session_date: string | null
          session_type: string | null
          summary: string | null
          tree_test_result: string | null
          trust_level: number | null
        }
        Insert: {
          coherence_score?: number | null
          color_test_result?: string | null
          created_at?: string | null
          crisis_id?: string | null
          emotional_regulation_ok?: boolean | null
          future_mentions?: boolean | null
          id?: string
          karel_notes?: string | null
          positive_signals?: string[] | null
          projective_story_result?: string | null
          reality_testing_ok?: boolean | null
          risk_signals?: string[] | null
          safety_ok?: boolean | null
          scaling_score?: number | null
          session_date?: string | null
          session_type?: string | null
          summary?: string | null
          tree_test_result?: string | null
          trust_level?: number | null
        }
        Update: {
          coherence_score?: number | null
          color_test_result?: string | null
          created_at?: string | null
          crisis_id?: string | null
          emotional_regulation_ok?: boolean | null
          future_mentions?: boolean | null
          id?: string
          karel_notes?: string | null
          positive_signals?: string[] | null
          projective_story_result?: string | null
          reality_testing_ok?: boolean | null
          risk_signals?: string[] | null
          safety_ok?: boolean | null
          scaling_score?: number | null
          session_date?: string | null
          session_type?: string | null
          summary?: string | null
          tree_test_result?: string | null
          trust_level?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "crisis_session_logs_crisis_id_fkey"
            columns: ["crisis_id"]
            isOneToOne: false
            referencedRelation: "crisis_events"
            referencedColumns: ["id"]
          },
        ]
      }
      crisis_session_questions: {
        Row: {
          answer_quality_score: number | null
          answer_text: string | null
          answered_at: string | null
          created_at: string
          crisis_event_id: string
          id: string
          karel_analysis: string | null
          karel_analyzed_at: string | null
          question_text: string
          required_by: string | null
          session_plan_id: string | null
          therapist_name: string
        }
        Insert: {
          answer_quality_score?: number | null
          answer_text?: string | null
          answered_at?: string | null
          created_at?: string
          crisis_event_id: string
          id?: string
          karel_analysis?: string | null
          karel_analyzed_at?: string | null
          question_text: string
          required_by?: string | null
          session_plan_id?: string | null
          therapist_name: string
        }
        Update: {
          answer_quality_score?: number | null
          answer_text?: string | null
          answered_at?: string | null
          created_at?: string
          crisis_event_id?: string
          id?: string
          karel_analysis?: string | null
          karel_analyzed_at?: string | null
          question_text?: string
          required_by?: string | null
          session_plan_id?: string | null
          therapist_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "crisis_session_questions_crisis_event_id_fkey"
            columns: ["crisis_event_id"]
            isOneToOne: false
            referencedRelation: "crisis_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crisis_session_questions_session_plan_id_fkey"
            columns: ["session_plan_id"]
            isOneToOne: false
            referencedRelation: "did_daily_session_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      crisis_tasks: {
        Row: {
          assigned_to: string
          completed_at: string | null
          created_at: string
          crisis_alert_id: string
          crisis_event_id: string | null
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
          crisis_event_id?: string | null
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
          crisis_event_id?: string | null
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
          {
            foreignKeyName: "crisis_tasks_crisis_event_id_fkey"
            columns: ["crisis_event_id"]
            isOneToOne: false
            referencedRelation: "crisis_events"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_metrics: {
        Row: {
          assistant_message_count: number | null
          avg_message_length: number | null
          computed_at: string | null
          cooperation_level: number | null
          created_at: string | null
          emotional_arousal: number | null
          emotional_valence: number | null
          id: string
          message_count: number | null
          metric_date: string
          new_topics_introduced: number | null
          openness_level: number | null
          part_name: string | null
          positive_signals_count: number | null
          promises_fulfilled: number | null
          promises_made: number | null
          raw_data: Json | null
          risk_signals_count: number | null
          session_count: number | null
          source: string | null
          switching_count: number | null
          therapist_notes_count: number | null
          unresolved_topics: number | null
          user_message_count: number | null
        }
        Insert: {
          assistant_message_count?: number | null
          avg_message_length?: number | null
          computed_at?: string | null
          cooperation_level?: number | null
          created_at?: string | null
          emotional_arousal?: number | null
          emotional_valence?: number | null
          id?: string
          message_count?: number | null
          metric_date?: string
          new_topics_introduced?: number | null
          openness_level?: number | null
          part_name?: string | null
          positive_signals_count?: number | null
          promises_fulfilled?: number | null
          promises_made?: number | null
          raw_data?: Json | null
          risk_signals_count?: number | null
          session_count?: number | null
          source?: string | null
          switching_count?: number | null
          therapist_notes_count?: number | null
          unresolved_topics?: number | null
          user_message_count?: number | null
        }
        Update: {
          assistant_message_count?: number | null
          avg_message_length?: number | null
          computed_at?: string | null
          cooperation_level?: number | null
          created_at?: string | null
          emotional_arousal?: number | null
          emotional_valence?: number | null
          id?: string
          message_count?: number | null
          metric_date?: string
          new_topics_introduced?: number | null
          openness_level?: number | null
          part_name?: string | null
          positive_signals_count?: number | null
          promises_fulfilled?: number | null
          promises_made?: number | null
          raw_data?: Json | null
          risk_signals_count?: number | null
          session_count?: number | null
          source?: string | null
          switching_count?: number | null
          therapist_notes_count?: number | null
          unresolved_topics?: number | null
          user_message_count?: number | null
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
          closure_recommendation: string | null
          created_at: string
          crisis_event_id: string | null
          deadline_at: string | null
          finalized_at: string | null
          hanka_joined_at: string | null
          hanka_position: string | null
          id: string
          is_closure_meeting: boolean | null
          karel_final_statement: string | null
          kata_joined_at: string | null
          kata_position: string | null
          last_reactive_message_count: number | null
          meeting_conclusions: Json | null
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
          closure_recommendation?: string | null
          created_at?: string
          crisis_event_id?: string | null
          deadline_at?: string | null
          finalized_at?: string | null
          hanka_joined_at?: string | null
          hanka_position?: string | null
          id?: string
          is_closure_meeting?: boolean | null
          karel_final_statement?: string | null
          kata_joined_at?: string | null
          kata_position?: string | null
          last_reactive_message_count?: number | null
          meeting_conclusions?: Json | null
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
          closure_recommendation?: string | null
          created_at?: string
          crisis_event_id?: string | null
          deadline_at?: string | null
          finalized_at?: string | null
          hanka_joined_at?: string | null
          hanka_position?: string | null
          id?: string
          is_closure_meeting?: boolean | null
          karel_final_statement?: string | null
          kata_joined_at?: string | null
          kata_position?: string | null
          last_reactive_message_count?: number | null
          meeting_conclusions?: Json | null
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
        Relationships: [
          {
            foreignKeyName: "did_meetings_crisis_event_id_fkey"
            columns: ["crisis_event_id"]
            isOneToOne: false
            referencedRelation: "crisis_events"
            referencedColumns: ["id"]
          },
        ]
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
          manual_state_override: string | null
          next_session_plan: string | null
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
          manual_state_override?: string | null
          next_session_plan?: string | null
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
          manual_state_override?: string | null
          next_session_plan?: string | null
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
      did_pending_emails: {
        Row: {
          body_html: string
          body_text: string | null
          created_at: string | null
          email_type: string
          error_message: string | null
          id: string
          max_retries: number | null
          next_retry_at: string | null
          retry_count: number | null
          sent_at: string | null
          status: string
          subject: string
          to_email: string
          to_name: string | null
        }
        Insert: {
          body_html: string
          body_text?: string | null
          created_at?: string | null
          email_type?: string
          error_message?: string | null
          id?: string
          max_retries?: number | null
          next_retry_at?: string | null
          retry_count?: number | null
          sent_at?: string | null
          status?: string
          subject: string
          to_email: string
          to_name?: string | null
        }
        Update: {
          body_html?: string
          body_text?: string | null
          created_at?: string | null
          email_type?: string
          error_message?: string | null
          id?: string
          max_retries?: number | null
          next_retry_at?: string | null
          retry_count?: number | null
          sent_at?: string | null
          status?: string
          subject?: string
          to_email?: string
          to_name?: string | null
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
          crisis_event_id: string | null
          directed_to: string | null
          expires_at: string | null
          id: string
          processed_by_reactive: boolean | null
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
          crisis_event_id?: string | null
          directed_to?: string | null
          expires_at?: string | null
          id?: string
          processed_by_reactive?: boolean | null
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
          crisis_event_id?: string | null
          directed_to?: string | null
          expires_at?: string | null
          id?: string
          processed_by_reactive?: boolean | null
          question?: string
          status?: string | null
          subject_id?: string | null
          subject_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "did_pending_questions_crisis_event_id_fkey"
            columns: ["crisis_event_id"]
            isOneToOne: false
            referencedRelation: "crisis_events"
            referencedColumns: ["id"]
          },
        ]
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
      did_research_cache: {
        Row: {
          citations: string[] | null
          created_at: string
          id: string
          part_name: string
          query: string
          result: string
          tags: string[] | null
          used_in_cards: boolean | null
          user_id: string
        }
        Insert: {
          citations?: string[] | null
          created_at?: string
          id?: string
          part_name: string
          query: string
          result: string
          tags?: string[] | null
          used_in_cards?: boolean | null
          user_id: string
        }
        Update: {
          citations?: string[] | null
          created_at?: string
          id?: string
          part_name?: string
          query?: string
          result?: string
          tags?: string[] | null
          used_in_cards?: boolean | null
          user_id?: string
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
      did_task_auto_feedback: {
        Row: {
          acknowledged: boolean | null
          created_at: string | null
          feedback_text: string
          feedback_type: string
          generated_by: string | null
          id: string
          part_name: string | null
          quality_score: number | null
          suggestions: string[] | null
          task_id: string
        }
        Insert: {
          acknowledged?: boolean | null
          created_at?: string | null
          feedback_text: string
          feedback_type?: string
          generated_by?: string | null
          id?: string
          part_name?: string | null
          quality_score?: number | null
          suggestions?: string[] | null
          task_id: string
        }
        Update: {
          acknowledged?: boolean | null
          created_at?: string | null
          feedback_text?: string
          feedback_type?: string
          generated_by?: string | null
          id?: string
          part_name?: string | null
          quality_score?: number | null
          suggestions?: string[] | null
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "did_task_auto_feedback_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "did_therapist_tasks"
            referencedColumns: ["id"]
          },
        ]
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
          escalated_at: string | null
          escalation_level: string | null
          id: string
          last_escalation_email_at: string | null
          note: string | null
          priority: string | null
          processed_by_reactive: boolean | null
          related_task_id: string | null
          source: string | null
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
          escalated_at?: string | null
          escalation_level?: string | null
          id?: string
          last_escalation_email_at?: string | null
          note?: string | null
          priority?: string | null
          processed_by_reactive?: boolean | null
          related_task_id?: string | null
          source?: string | null
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
          escalated_at?: string | null
          escalation_level?: string | null
          id?: string
          last_escalation_email_at?: string | null
          note?: string | null
          priority?: string | null
          processed_by_reactive?: boolean | null
          related_task_id?: string | null
          source?: string | null
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
          archive_status: string
          created_at: string
          current_detected_part: string | null
          entered_name: string | null
          id: string
          is_locked: boolean
          is_processed: boolean
          last_activity_at: string
          locked_at: string | null
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
          archive_status?: string
          created_at?: string
          current_detected_part?: string | null
          entered_name?: string | null
          id?: string
          is_locked?: boolean
          is_processed?: boolean
          last_activity_at?: string
          locked_at?: string | null
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
          archive_status?: string
          created_at?: string
          current_detected_part?: string | null
          entered_name?: string | null
          id?: string
          is_locked?: boolean
          is_processed?: boolean
          last_activity_at?: string
          locked_at?: string | null
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
      goal_evaluations: {
        Row: {
          created_at: string | null
          evaluated_by: string | null
          evaluation_text: string | null
          evidence: Json | null
          goal_id: string
          id: string
          new_progress: number | null
          previous_progress: number | null
        }
        Insert: {
          created_at?: string | null
          evaluated_by?: string | null
          evaluation_text?: string | null
          evidence?: Json | null
          goal_id: string
          id?: string
          new_progress?: number | null
          previous_progress?: number | null
        }
        Update: {
          created_at?: string | null
          evaluated_by?: string | null
          evaluation_text?: string | null
          evidence?: Json | null
          goal_id?: string
          id?: string
          new_progress?: number | null
          previous_progress?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "goal_evaluations_goal_id_fkey"
            columns: ["goal_id"]
            isOneToOne: false
            referencedRelation: "part_goals"
            referencedColumns: ["id"]
          },
        ]
      }
      karel_commitments: {
        Row: {
          commitment_text: string
          committed_by: string
          committed_to: string | null
          created_at: string | null
          due_date: string | null
          follow_up_sent: boolean | null
          follow_up_sent_at: string | null
          fulfilled_at: string | null
          fulfillment_note: string | null
          id: string
          source_id: string | null
          source_type: string | null
          status: string | null
          subject_id: string | null
          subject_type: string | null
        }
        Insert: {
          commitment_text: string
          committed_by: string
          committed_to?: string | null
          created_at?: string | null
          due_date?: string | null
          follow_up_sent?: boolean | null
          follow_up_sent_at?: string | null
          fulfilled_at?: string | null
          fulfillment_note?: string | null
          id?: string
          source_id?: string | null
          source_type?: string | null
          status?: string | null
          subject_id?: string | null
          subject_type?: string | null
        }
        Update: {
          commitment_text?: string
          committed_by?: string
          committed_to?: string | null
          created_at?: string | null
          due_date?: string | null
          follow_up_sent?: boolean | null
          follow_up_sent_at?: string | null
          fulfilled_at?: string | null
          fulfillment_note?: string | null
          id?: string
          source_id?: string | null
          source_type?: string | null
          status?: string | null
          subject_id?: string | null
          subject_type?: string | null
        }
        Relationships: []
      }
      karel_conversation_agenda: {
        Row: {
          condition: string | null
          context: string | null
          created_at: string | null
          discussed_at: string | null
          id: string
          priority: string | null
          related_crisis_id: string | null
          related_part: string | null
          source: string | null
          status: string | null
          therapist: string
          topic: string
          topic_type: string | null
        }
        Insert: {
          condition?: string | null
          context?: string | null
          created_at?: string | null
          discussed_at?: string | null
          id?: string
          priority?: string | null
          related_crisis_id?: string | null
          related_part?: string | null
          source?: string | null
          status?: string | null
          therapist: string
          topic: string
          topic_type?: string | null
        }
        Update: {
          condition?: string | null
          context?: string | null
          created_at?: string | null
          discussed_at?: string | null
          id?: string
          priority?: string | null
          related_crisis_id?: string | null
          related_part?: string | null
          source?: string | null
          status?: string | null
          therapist?: string
          topic?: string
          topic_type?: string | null
        }
        Relationships: []
      }
      karel_crisis_research: {
        Row: {
          citations: Json | null
          created_at: string | null
          crisis_alert_id: string | null
          crisis_event_id: string | null
          days_active_at_research: number | null
          id: string
          model_used: string | null
          part_name: string | null
          query_used: string | null
          research_findings: string | null
        }
        Insert: {
          citations?: Json | null
          created_at?: string | null
          crisis_alert_id?: string | null
          crisis_event_id?: string | null
          days_active_at_research?: number | null
          id?: string
          model_used?: string | null
          part_name?: string | null
          query_used?: string | null
          research_findings?: string | null
        }
        Update: {
          citations?: Json | null
          created_at?: string | null
          crisis_alert_id?: string | null
          crisis_event_id?: string | null
          days_active_at_research?: number | null
          id?: string
          model_used?: string | null
          part_name?: string | null
          query_used?: string | null
          research_findings?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "karel_crisis_research_crisis_alert_id_fkey"
            columns: ["crisis_alert_id"]
            isOneToOne: false
            referencedRelation: "crisis_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "karel_crisis_research_crisis_event_id_fkey"
            columns: ["crisis_event_id"]
            isOneToOne: false
            referencedRelation: "crisis_events"
            referencedColumns: ["id"]
          },
        ]
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
          archive_status: string
          created_at: string
          current_domain: string
          current_hana_state: string
          id: string
          is_active: boolean
          is_locked: boolean
          last_activity_at: string
          locked_at: string | null
          message_count: number
          messages: Json
          preview: string
          section: string
          source_topic_id: string | null
          started_at: string
          sub_mode: string
          thread_label: string
          user_id: string
        }
        Insert: {
          archive_status?: string
          created_at?: string
          current_domain?: string
          current_hana_state?: string
          id?: string
          is_active?: boolean
          is_locked?: boolean
          last_activity_at?: string
          locked_at?: string | null
          message_count?: number
          messages?: Json
          preview?: string
          section?: string
          source_topic_id?: string | null
          started_at?: string
          sub_mode?: string
          thread_label?: string
          user_id?: string
        }
        Update: {
          archive_status?: string
          created_at?: string
          current_domain?: string
          current_hana_state?: string
          id?: string
          is_active?: boolean
          is_locked?: boolean
          last_activity_at?: string
          locked_at?: string | null
          message_count?: number
          messages?: Json
          preview?: string
          section?: string
          source_topic_id?: string | null
          started_at?: string
          sub_mode?: string
          thread_label?: string
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
      karel_promises: {
        Row: {
          context: string | null
          created_at: string | null
          fulfilled_at: string | null
          id: string
          part_name: string
          promise_text: string
          source_session_id: string | null
          status: string | null
        }
        Insert: {
          context?: string | null
          created_at?: string | null
          fulfilled_at?: string | null
          id?: string
          part_name: string
          promise_text: string
          source_session_id?: string | null
          status?: string | null
        }
        Update: {
          context?: string | null
          created_at?: string | null
          fulfilled_at?: string | null
          id?: string
          part_name?: string
          promise_text?: string
          source_session_id?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "karel_promises_source_session_id_fkey"
            columns: ["source_session_id"]
            isOneToOne: false
            referencedRelation: "session_memory"
            referencedColumns: ["id"]
          },
        ]
      }
      karel_saved_topics: {
        Row: {
          created_at: string
          extracted_context: string
          id: string
          is_active: boolean
          last_continued_at: string | null
          pending_drive_sync: boolean
          section: string
          source_thread_id: string | null
          sub_mode: string
          synced_to_drive_at: string | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          extracted_context?: string
          id?: string
          is_active?: boolean
          last_continued_at?: string | null
          pending_drive_sync?: boolean
          section?: string
          source_thread_id?: string | null
          sub_mode?: string
          synced_to_drive_at?: string | null
          title: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          extracted_context?: string
          id?: string
          is_active?: boolean
          last_continued_at?: string | null
          pending_drive_sync?: boolean
          section?: string
          source_thread_id?: string | null
          sub_mode?: string
          synced_to_drive_at?: string | null
          title?: string
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
      part_goals: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          category: string | null
          completed_at: string | null
          created_at: string | null
          description: string | null
          evaluation_notes: string | null
          goal_text: string
          goal_type: string | null
          id: string
          last_evaluated_at: string | null
          milestones: Json | null
          part_name: string
          pause_reason: string | null
          priority: string | null
          progress_pct: number | null
          proposed_by: string | null
          sort_order: number | null
          state_at_creation: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          category?: string | null
          completed_at?: string | null
          created_at?: string | null
          description?: string | null
          evaluation_notes?: string | null
          goal_text: string
          goal_type?: string | null
          id?: string
          last_evaluated_at?: string | null
          milestones?: Json | null
          part_name: string
          pause_reason?: string | null
          priority?: string | null
          progress_pct?: number | null
          proposed_by?: string | null
          sort_order?: number | null
          state_at_creation?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          category?: string | null
          completed_at?: string | null
          created_at?: string | null
          description?: string | null
          evaluation_notes?: string | null
          goal_text?: string
          goal_type?: string | null
          id?: string
          last_evaluated_at?: string | null
          milestones?: Json | null
          part_name?: string
          pause_reason?: string | null
          priority?: string | null
          progress_pct?: number | null
          proposed_by?: string | null
          sort_order?: number | null
          state_at_creation?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      plan_update_log: {
        Row: {
          created_at: string | null
          error: string | null
          goals_updated: number | null
          id: string
          parts_included: string[] | null
          plan_type: string
          processing_time_ms: number | null
          sessions_completed: number | null
          sessions_planned: number | null
          web_searches: number | null
        }
        Insert: {
          created_at?: string | null
          error?: string | null
          goals_updated?: number | null
          id?: string
          parts_included?: string[] | null
          plan_type: string
          processing_time_ms?: number | null
          sessions_completed?: number | null
          sessions_planned?: number | null
          web_searches?: number | null
        }
        Update: {
          created_at?: string | null
          error?: string | null
          goals_updated?: number | null
          id?: string
          parts_included?: string[] | null
          plan_type?: string
          processing_time_ms?: number | null
          sessions_completed?: number | null
          sessions_planned?: number | null
          web_searches?: number | null
        }
        Relationships: []
      }
      planned_sessions: {
        Row: {
          actual_outcome: string | null
          completed_date: string | null
          created_at: string | null
          description: string | null
          expected_outcome: string | null
          horizon: string | null
          id: string
          method_name: string
          method_source: string | null
          notes: string | null
          part_name: string
          priority: string | null
          scheduled_date: string | null
          status: string | null
          therapist: string
          updated_at: string | null
        }
        Insert: {
          actual_outcome?: string | null
          completed_date?: string | null
          created_at?: string | null
          description?: string | null
          expected_outcome?: string | null
          horizon?: string | null
          id?: string
          method_name: string
          method_source?: string | null
          notes?: string | null
          part_name: string
          priority?: string | null
          scheduled_date?: string | null
          status?: string | null
          therapist: string
          updated_at?: string | null
        }
        Update: {
          actual_outcome?: string | null
          completed_date?: string | null
          created_at?: string | null
          description?: string | null
          expected_outcome?: string | null
          horizon?: string | null
          id?: string
          method_name?: string
          method_source?: string | null
          notes?: string | null
          part_name?: string
          priority?: string | null
          scheduled_date?: string | null
          status?: string | null
          therapist?: string
          updated_at?: string | null
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
      safety_alerts: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          alert_type: string
          created_at: string | null
          description: string | null
          detected_signals: Json | null
          id: string
          message_content: string | null
          notification_channel: string | null
          notification_sent: boolean | null
          notification_sent_at: string | null
          part_name: string | null
          recommended_action: string | null
          resolution_note: string | null
          resolved_at: string | null
          severity: string
          status: string | null
          thread_id: string | null
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          alert_type: string
          created_at?: string | null
          description?: string | null
          detected_signals?: Json | null
          id?: string
          message_content?: string | null
          notification_channel?: string | null
          notification_sent?: boolean | null
          notification_sent_at?: string | null
          part_name?: string | null
          recommended_action?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          severity?: string
          status?: string | null
          thread_id?: string | null
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          alert_type?: string
          created_at?: string | null
          description?: string | null
          detected_signals?: Json | null
          id?: string
          message_content?: string | null
          notification_channel?: string | null
          notification_sent?: boolean | null
          notification_sent_at?: string | null
          part_name?: string | null
          recommended_action?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          severity?: string
          status?: string | null
          thread_id?: string | null
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
      session_memory: {
        Row: {
          auto_generated: boolean | null
          created_at: string | null
          emotional_state: string | null
          id: string
          key_points: string[]
          manually_edited: boolean | null
          part_name: string
          positive_signals: string[] | null
          promises: string[] | null
          risk_signals: string[] | null
          session_date: string | null
          session_duration_msgs: number | null
          session_mode: string | null
          thread_id: string | null
          topics: string[] | null
          unresolved: string[] | null
        }
        Insert: {
          auto_generated?: boolean | null
          created_at?: string | null
          emotional_state?: string | null
          id?: string
          key_points?: string[]
          manually_edited?: boolean | null
          part_name: string
          positive_signals?: string[] | null
          promises?: string[] | null
          risk_signals?: string[] | null
          session_date?: string | null
          session_duration_msgs?: number | null
          session_mode?: string | null
          thread_id?: string | null
          topics?: string[] | null
          unresolved?: string[] | null
        }
        Update: {
          auto_generated?: boolean | null
          created_at?: string | null
          emotional_state?: string | null
          id?: string
          key_points?: string[]
          manually_edited?: boolean | null
          part_name?: string
          positive_signals?: string[] | null
          promises?: string[] | null
          risk_signals?: string[] | null
          session_date?: string | null
          session_duration_msgs?: number | null
          session_mode?: string | null
          thread_id?: string | null
          topics?: string[] | null
          unresolved?: string[] | null
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
      strategic_goals: {
        Row: {
          achieved_date: string | null
          category: string | null
          created_at: string | null
          evidence: string[] | null
          goal_text: string
          id: string
          notes: string | null
          part_name: string | null
          progress_pct: number | null
          status: string | null
          target_date: string | null
          updated_at: string | null
        }
        Insert: {
          achieved_date?: string | null
          category?: string | null
          created_at?: string | null
          evidence?: string[] | null
          goal_text: string
          id?: string
          notes?: string | null
          part_name?: string | null
          progress_pct?: number | null
          status?: string | null
          target_date?: string | null
          updated_at?: string | null
        }
        Update: {
          achieved_date?: string | null
          category?: string | null
          created_at?: string | null
          evidence?: string[] | null
          goal_text?: string
          id?: string
          notes?: string | null
          part_name?: string | null
          progress_pct?: number | null
          status?: string | null
          target_date?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      switching_events: {
        Row: {
          acknowledged: boolean | null
          confidence: string | null
          created_at: string | null
          detected_part: string
          id: string
          karel_response: string | null
          message_index: number | null
          original_part: string
          signals: Json | null
          thread_id: string
          user_message_excerpt: string | null
        }
        Insert: {
          acknowledged?: boolean | null
          confidence?: string | null
          created_at?: string | null
          detected_part: string
          id?: string
          karel_response?: string | null
          message_index?: number | null
          original_part: string
          signals?: Json | null
          thread_id: string
          user_message_excerpt?: string | null
        }
        Update: {
          acknowledged?: boolean | null
          confidence?: string | null
          created_at?: string | null
          detected_part?: string
          id?: string
          karel_response?: string | null
          message_index?: number | null
          original_part?: string
          signals?: Json | null
          thread_id?: string
          user_message_excerpt?: string | null
        }
        Relationships: []
      }
      system_health_log: {
        Row: {
          created_at: string | null
          details: Json | null
          event_type: string
          id: string
          message: string
          resolved: boolean | null
          severity: string
        }
        Insert: {
          created_at?: string | null
          details?: Json | null
          event_type: string
          id?: string
          message: string
          resolved?: boolean | null
          severity?: string
        }
        Update: {
          created_at?: string | null
          details?: Json | null
          event_type?: string
          id?: string
          message?: string
          resolved?: boolean | null
          severity?: string
        }
        Relationships: []
      }
      therapist_crisis_case_reviews: {
        Row: {
          closure_alignment_score: number | null
          consistency_score: number | null
          created_at: string
          crisis_event_id: string
          crisis_judgment_score: number | null
          escalation_sensitivity_score: number | null
          id: string
          initiative_score: number | null
          meeting_participation_score: number | null
          observation_quality_score: number | null
          recommended_karel_mode: string | null
          response_speed_score: number | null
          risks_observed: string[] | null
          strengths_observed: string[] | null
          supervision_notes: string | null
          supervision_trust_score: number | null
          task_reliability_score: number | null
          therapist_name: string
        }
        Insert: {
          closure_alignment_score?: number | null
          consistency_score?: number | null
          created_at?: string
          crisis_event_id: string
          crisis_judgment_score?: number | null
          escalation_sensitivity_score?: number | null
          id?: string
          initiative_score?: number | null
          meeting_participation_score?: number | null
          observation_quality_score?: number | null
          recommended_karel_mode?: string | null
          response_speed_score?: number | null
          risks_observed?: string[] | null
          strengths_observed?: string[] | null
          supervision_notes?: string | null
          supervision_trust_score?: number | null
          task_reliability_score?: number | null
          therapist_name: string
        }
        Update: {
          closure_alignment_score?: number | null
          consistency_score?: number | null
          created_at?: string
          crisis_event_id?: string
          crisis_judgment_score?: number | null
          escalation_sensitivity_score?: number | null
          id?: string
          initiative_score?: number | null
          meeting_participation_score?: number | null
          observation_quality_score?: number | null
          recommended_karel_mode?: string | null
          response_speed_score?: number | null
          risks_observed?: string[] | null
          strengths_observed?: string[] | null
          supervision_notes?: string | null
          supervision_trust_score?: number | null
          task_reliability_score?: number | null
          therapist_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "therapist_crisis_case_reviews_crisis_event_id_fkey"
            columns: ["crisis_event_id"]
            isOneToOne: false
            referencedRelation: "crisis_events"
            referencedColumns: ["id"]
          },
        ]
      }
      therapist_crisis_profile: {
        Row: {
          aggregate_closure_alignment_score: number | null
          aggregate_consistency_score: number | null
          aggregate_crisis_judgment_score: number | null
          aggregate_escalation_sensitivity_score: number | null
          aggregate_initiative_score: number | null
          aggregate_meeting_participation_score: number | null
          aggregate_observation_quality_score: number | null
          aggregate_response_speed_score: number | null
          aggregate_supervision_trust_score: number | null
          aggregate_task_reliability_score: number | null
          created_at: string
          id: string
          therapist_name: string
          total_crisis_cases: number | null
          updated_at: string
        }
        Insert: {
          aggregate_closure_alignment_score?: number | null
          aggregate_consistency_score?: number | null
          aggregate_crisis_judgment_score?: number | null
          aggregate_escalation_sensitivity_score?: number | null
          aggregate_initiative_score?: number | null
          aggregate_meeting_participation_score?: number | null
          aggregate_observation_quality_score?: number | null
          aggregate_response_speed_score?: number | null
          aggregate_supervision_trust_score?: number | null
          aggregate_task_reliability_score?: number | null
          created_at?: string
          id?: string
          therapist_name: string
          total_crisis_cases?: number | null
          updated_at?: string
        }
        Update: {
          aggregate_closure_alignment_score?: number | null
          aggregate_consistency_score?: number | null
          aggregate_crisis_judgment_score?: number | null
          aggregate_escalation_sensitivity_score?: number | null
          aggregate_initiative_score?: number | null
          aggregate_meeting_participation_score?: number | null
          aggregate_observation_quality_score?: number | null
          aggregate_response_speed_score?: number | null
          aggregate_supervision_trust_score?: number | null
          aggregate_task_reliability_score?: number | null
          created_at?: string
          id?: string
          therapist_name?: string
          total_crisis_cases?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      therapist_notes: {
        Row: {
          author: string
          created_at: string | null
          id: string
          incorporated_into: string | null
          is_read_by_karel: boolean | null
          note_text: string
          note_type: string
          part_name: string | null
          priority: string | null
          read_at: string | null
          session_date: string | null
          tags: string[] | null
        }
        Insert: {
          author?: string
          created_at?: string | null
          id?: string
          incorporated_into?: string | null
          is_read_by_karel?: boolean | null
          note_text: string
          note_type?: string
          part_name?: string | null
          priority?: string | null
          read_at?: string | null
          session_date?: string | null
          tags?: string[] | null
        }
        Update: {
          author?: string
          created_at?: string | null
          id?: string
          incorporated_into?: string | null
          is_read_by_karel?: boolean | null
          note_text?: string
          note_type?: string
          part_name?: string | null
          priority?: string | null
          read_at?: string | null
          session_date?: string | null
          tags?: string[] | null
        }
        Relationships: []
      }
      therapist_profiles: {
        Row: {
          communication_style: string | null
          experience_areas: string[] | null
          generated_by: string | null
          id: string
          last_updated: string | null
          limitations: string[] | null
          preferred_methods: string[] | null
          preferred_part_types: string[] | null
          raw_analysis: string | null
          strengths: string[] | null
          therapist_name: string
          workload_capacity: string | null
        }
        Insert: {
          communication_style?: string | null
          experience_areas?: string[] | null
          generated_by?: string | null
          id?: string
          last_updated?: string | null
          limitations?: string[] | null
          preferred_methods?: string[] | null
          preferred_part_types?: string[] | null
          raw_analysis?: string | null
          strengths?: string[] | null
          therapist_name: string
          workload_capacity?: string | null
        }
        Update: {
          communication_style?: string | null
          experience_areas?: string[] | null
          generated_by?: string | null
          id?: string
          last_updated?: string | null
          limitations?: string[] | null
          preferred_methods?: string[] | null
          preferred_part_types?: string[] | null
          raw_analysis?: string | null
          strengths?: string[] | null
          therapist_name?: string
          workload_capacity?: string | null
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

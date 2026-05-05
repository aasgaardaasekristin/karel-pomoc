# P28_CDI_2b — Dashboard Update Proof (Remaining Surfaces)

For each remaining surface, the realtime/refetch path that propagates a server-side pipeline write back into the dashboard.

| surface | component | submit_action | db_change | pipeline_event | refetch_or_realtime_mechanism | visible_expected_change | status |
|---|---|---|---|---|---|---|---|
| playroom_deliberation_answer | DeliberationRoom.tsx | iterate | did_team_deliberations.updated_at | deliberation_answered | useTeamDeliberations supabase channel postgres_changes on did_team_deliberations + invalidateQueries | new turn appears, signoff buttons re-evaluated | ok |
| session_approval_answer | DeliberationRoom.tsx | signoff | did_team_deliberations (status, signed_at) | approval_answered | useTeamDeliberations realtime; DidDailySessionPlan refetch on bridged plan id | "Schváleno" + plan card transitions to ready_to_start | ok |
| pending_question_answer | PendingQuestionsPanel.tsx | answer | did_pending_questions.status / follow_up_result | pending_question_answered | emitPendingQuestionsChanged window event + 30s polling in useOperationalInboxCounts | answered question disappears from open list, counts update | ok |
| card_update_discussion | DidKartotekaTab.tsx | discuss/apply | card_update_queue.updated_at | card_update_discussed (FE markActivity) + processor resync hint | DidKartotekaTab supabase channel on card_update_queue | queue item moves through states | partial (FE-only) |
| daily_plan_edit | DidDailySessionPlan.tsx, KarelDailyPlan.tsx | sync_and_start | did_daily_session_plans.status / updated_at | plan_edited | DidDailySessionPlan realtime + invalidateQueries on plan list | plan card flips to ready_to_start / in_progress | ok |
| live_session_block_update | DidLiveSessionPanel.tsx | feedback / block change | did_live_session_progress.updated_at | block_updated | DidLiveSessionPanel realtime + heartbeat tick | block tile updates, hint banner refreshes | ok |
| playroom_block_update | DidKidsPlayroom.tsx | feedback (is_playroom) | did_live_session_progress.updated_at | block_updated | DidKidsPlayroom realtime | playroom block highlight + Karel hint refresh | ok |
| did_part_chat_thread | Chat.tsx | message_sent | did_chat_messages | message_sent (covered in 2a; safe smoke only here) | useDidThreads realtime + ChatMessageList tail-append | new message bubble | ok (safe smoke) |
| session_resume | DidLiveSessionPanel.tsx | resume | surface_resume_state.next_resume_point | n/a (state IS the change) | DidLiveSessionPanel reads surface_resume_state on mount + realtime channel | resume banner shows where session left off | ok |
| playroom_resume | DidKidsPlayroom.tsx | resume | surface_resume_state.next_resume_point | n/a | DidKidsPlayroom reads + realtime | resume CTA shows correct block | ok |

All dashboards have either a direct `supabase.channel(...).on('postgres_changes', ...)` subscriber, or an `invalidateQueries`/window-event refresh hook. The single partial item (`card_update_discussion`) is FE-driven by design today and is queued for promotion in P28_CDI_3.

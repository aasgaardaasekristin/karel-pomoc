ALTER TABLE public.did_child_thread_message REPLICA IDENTITY FULL;
ALTER TABLE public.did_child_thread REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.did_child_thread_message;
ALTER PUBLICATION supabase_realtime ADD TABLE public.did_child_thread;

-- Create storage bucket for chat attachments
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-attachments',
  'chat-attachments',
  false,
  52428800, -- 50MB
  ARRAY[
    'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml',
    'audio/webm', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/x-m4a',
    'video/mp4', 'video/webm', 'video/quicktime',
    'application/pdf',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain', 'text/csv', 'text/markdown',
    'application/json', 'application/xml'
  ]
);

-- RLS: authenticated users can upload to their own folder
CREATE POLICY "Users can upload own attachments"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'chat-attachments'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

-- RLS: authenticated users can read their own files
CREATE POLICY "Users can read own attachments"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'chat-attachments'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

-- RLS: authenticated users can delete their own files
CREATE POLICY "Users can delete own attachments"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'chat-attachments'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

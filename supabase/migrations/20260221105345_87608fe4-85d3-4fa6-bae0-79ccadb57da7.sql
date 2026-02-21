
-- Table for email-verified calm access tokens
CREATE TABLE public.calm_access_tokens (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  used BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Index for fast token lookup
CREATE INDEX idx_calm_tokens_token ON public.calm_access_tokens (token);
-- Index for cleanup of expired tokens
CREATE INDEX idx_calm_tokens_expires ON public.calm_access_tokens (expires_at);

-- RLS enabled but no user policies needed - only edge functions with service role access this
ALTER TABLE public.calm_access_tokens ENABLE ROW LEVEL SECURITY;

-- Rate limit: max 5 magic link requests per email per hour (enforced in edge function)

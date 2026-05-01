-- Sanitize visible technical language in persisted team deliberations.
-- These columns are rendered directly in the Herna modal / DeliberationRoom UI.
UPDATE public.did_team_deliberations
SET
  initial_karel_brief = regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(initial_karel_brief, 'Karel[-_ ]led', 'vedená Karlem', 'gi'),
        'first[_ ]draft', 'pracovní návrh', 'gi'
      ),
      'program[_ ]draft', 'pracovní program', 'gi'
    ),
    'session[_ ]params', 'parametry sezení', 'gi'
  ),
  karel_proposed_plan = CASE WHEN karel_proposed_plan IS NULL THEN NULL ELSE
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(karel_proposed_plan, 'Karel[-_ ]led', 'vedená Karlem', 'gi'),
          'first[_ ]draft', 'pracovní návrh', 'gi'
        ),
        'program[_ ]draft', 'pracovní program', 'gi'
      ),
      'session[_ ]params', 'parametry sezení', 'gi'
    )
  END,
  reason = CASE WHEN reason IS NULL THEN NULL ELSE
    regexp_replace(
      regexp_replace(reason, 'Karel[-_ ]led', 'vedená Karlem', 'gi'),
      'first[_ ]draft', 'pracovní návrh', 'gi'
    )
  END,
  title = regexp_replace(
    regexp_replace(title, 'Karel[-_ ]led', 'vedená Karlem', 'gi'),
    'first[_ ]draft', 'pracovní návrh', 'gi'
  ),
  final_summary = CASE WHEN final_summary IS NULL THEN NULL ELSE
    regexp_replace(
      regexp_replace(final_summary, 'Karel[-_ ]led', 'vedená Karlem', 'gi'),
      'first[_ ]draft', 'pracovní návrh', 'gi'
    )
  END,
  updated_at = now()
WHERE
  initial_karel_brief ~* '(Karel[-_ ]led|first[_ ]draft|program[_ ]draft|session[_ ]params)'
  OR karel_proposed_plan ~* '(Karel[-_ ]led|first[_ ]draft|program[_ ]draft|session[_ ]params)'
  OR reason ~* '(Karel[-_ ]led|first[_ ]draft)'
  OR title ~* '(Karel[-_ ]led|first[_ ]draft)'
  OR final_summary ~* '(Karel[-_ ]led|first[_ ]draft)';
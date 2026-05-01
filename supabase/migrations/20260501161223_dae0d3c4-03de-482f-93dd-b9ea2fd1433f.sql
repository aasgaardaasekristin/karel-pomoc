-- Herna modal — micro language cleanup (visible Czech quality, not just regex tokens)
-- Removes awkward / unprofessional Czech sentences from existing initial_karel_brief
-- and replaces them with one natural clinical sentence.

UPDATE public.did_team_deliberations
SET initial_karel_brief = regexp_replace(
  initial_karel_brief,
  -- Match the whole sentence "Otevírám poradu ke schválení samostatného programu Herny. Herna je (Karel-led|vedená Karlem) práce s částí; ... ."
  'Otevírám poradu ke schválení samostatného programu Herny\.\s*Herna je (?:Karel[-_ ]led|vedená Karlem) práce[^.]*\.',
  'Otevírám poradu ke schválení samostatného programu Herny. Herna má svůj vlastní bezpečný herní program. Karel ji může vést až po schválení Haničkou a Káťou.',
  'gi'
)
WHERE initial_karel_brief ~* '(Karel[-_ ]led práce|vedená Karlem práce|nepoužije se plán terapeutického sezení)';

-- Also clean the "Herna je práce vedená Karlem po schválení terapeutkami; ... nepřebírá plán terapeutického Sezení." variant
UPDATE public.did_team_deliberations
SET initial_karel_brief = regexp_replace(
  initial_karel_brief,
  'Herna je práce vedená Karlem po schválení terapeutkami;[^.]*nepřebírá plán terapeutického Sezení\.',
  'Herna má svůj vlastní bezpečný herní program. Karel ji může vést až po schválení Haničkou a Káťou.',
  'gi'
)
WHERE initial_karel_brief ~* 'Herna je práce vedená Karlem po schválení terapeutkami';

-- Residual standalone "ani pracovní návrh" / leftover tokens
UPDATE public.did_team_deliberations
SET initial_karel_brief = regexp_replace(
  regexp_replace(initial_karel_brief, '\s*ani pracovní návrh', '', 'gi'),
  '\bpracovní návrh\b', 'pracovní podklad', 'gi'
)
WHERE initial_karel_brief ~* '(ani pracovní návrh|pracovní návrh)';
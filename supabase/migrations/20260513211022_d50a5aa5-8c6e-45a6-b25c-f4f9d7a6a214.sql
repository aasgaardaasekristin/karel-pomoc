UPDATE public.did_part_registry
SET known_triggers = ARRAY[
  'Locík',
  'Timmy',
  'utrpení zvířat',
  'umírání zvířat'
]
WHERE part_name = 'tundrupek'
  AND user_id = '8a7816ee-4fd1-43d4-8d83-4230d7517ae1';
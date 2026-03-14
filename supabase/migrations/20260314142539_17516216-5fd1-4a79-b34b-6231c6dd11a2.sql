ALTER TABLE karel_semantic_entities DROP CONSTRAINT karel_semantic_entities_typ_check;
ALTER TABLE karel_semantic_entities ADD CONSTRAINT karel_semantic_entities_typ_check CHECK (typ = ANY (ARRAY['clovek'::text, 'cast'::text, 'klient'::text, 'rodina'::text, 'jiny'::text, 'misto'::text, 'tema'::text, 'organizace'::text, 'cast_did'::text]));

ALTER TABLE karel_semantic_patterns DROP CONSTRAINT karel_semantic_patterns_domain_check;
ALTER TABLE karel_semantic_patterns ADD CONSTRAINT karel_semantic_patterns_domain_check CHECK (domain = ANY (ARRAY['HANA'::text, 'DID'::text, 'PRACE'::text, 'OBECNE'::text]));

ALTER TABLE karel_strategies DROP CONSTRAINT karel_strategies_domain_check;
ALTER TABLE karel_strategies ADD CONSTRAINT karel_strategies_domain_check CHECK (domain = ANY (ARRAY['HANA'::text, 'DID'::text, 'PRACE'::text, 'OBECNE'::text]));
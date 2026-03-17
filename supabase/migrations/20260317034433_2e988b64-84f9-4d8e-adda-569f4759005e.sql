-- Delete Dymi (duplicate of DMYTRI)
DELETE FROM did_part_registry WHERE part_name = 'Dymi';

-- Ensure Clark and Bélo are sleeping (they already are based on query, but verify)
UPDATE did_part_registry SET status = 'sleeping', cluster = 'spící' WHERE part_name IN ('Clark', 'Bélo');

-- Clean up duplicate Christoffer threads (keep the one with most messages: 2e79b81b)
DELETE FROM did_threads WHERE part_name = 'Christoffer' AND id != '2e79b81b-e282-4399-8ad8-f97e240c539b';

-- Clean up duplicate Mamka conversations (keep the most recent one)
DELETE FROM did_conversations WHERE sub_mode = 'mamka' AND preview = 'co lincoln psal, jak proběhl ten rozhovor?' AND id != (
  SELECT id FROM did_conversations WHERE sub_mode = 'mamka' AND preview = 'co lincoln psal, jak proběhl ten rozhovor?' ORDER BY saved_at DESC LIMIT 1
);

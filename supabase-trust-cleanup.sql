-- ═══════════════════════════════════════════════════
--  ANGADI — Trust-signal cleanup for the LIVE products table
--  (July 2026: renamed AI-tell image files, emoji-free badges,
--   tightened copy. Run in the Supabase SQL Editor.)
--
--  ⚠ RUN THIS ONLY AFTER DEPLOYING the renamed image files
--    (product/baby-goat-legs.png, product/country-eggs.png) —
--    otherwise those two product images will 404 until deploy.
-- ═══════════════════════════════════════════════════

-- 1. Renamed image files (were "ChatGPT Image Jun 3, 2026, …")
update products set image = 'product/baby-goat-legs.png' where slug = 'baby-goat-legs';
update products set image = 'product/country-eggs.png'   where slug = 'country-eggs';

-- 2. Emoji-free badges (match the new site design)
update products set badge = 'Bestseller'  where slug = 'goat-meat';
update products set badge = 'Premium'     where slug = 'baby-goat-legs';
update products set badge = 'Farm Fresh'  where slug = 'country-eggs';
update products set badge = 'Whole'       where slug = 'full-goat';
update products set badge = 'River Fresh' where slug = 'river-fish';
update products set badge = 'Fresh'       where slug = 'goat-legs';
update products set badge = 'Premium'     where slug = 'goat-liver';
update products set badge = 'Whole'       where slug = 'goat-head';
update products set badge = 'Natu'        where slug = 'country-chicken';

-- 3. Tightened copy (removes AI-sounding phrasing)
update products set short_desc = 'Tender baby goat legs, perfect for slow-roast or biryani. Rare and seasonal — worth booking ahead.'
  where slug = 'baby-goat-legs';
update products set short_desc = 'Free-range country chicken raised in open villages. Firm and flavourful — made for slow cooking. Available whole or curry cut.'
  where slug = 'country-chicken';
update products set short_desc = 'Collagen-rich village goat legs — perfect for paya curry, slow masala, and bone broth.'
  where slug = 'goat-legs';
update products set short_desc = 'Farm-fresh goat liver — rich in iron, B12, and Vitamin A. Village goat, processed same day.'
  where slug = 'goat-liver';

-- 4. OPTIONAL: the live row for slug 'baby-goat-legs' is currently
--    named just "Goat Legs" (same as the goat-legs row — confusing on
--    the site). Uncomment to restore the distinct name:
-- update products set name = 'Baby Goat Legs', name_te = 'Pilla Meka Kalu' where slug = 'baby-goat-legs';

-- Verify:
select slug, name, image, badge from products order by slug;

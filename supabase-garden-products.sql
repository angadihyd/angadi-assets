-- ═══════════════════════════════════════════════════
--  ANGADI — Garden products (goat manure)
--  Run in: Supabase Dashboard → SQL Editor → Run
--  Safe to re-run: existing rows are updated to these values.
-- ═══════════════════════════════════════════════════

insert into products (slug,name,name_te,price,unit,category,image,video,badge,fresh_label,short_desc,in_stock,featured,sort_order,active) values
('garden-goat-pellets','Free Range Goat Manure',null,110,'kg','garden','product/garden-pellets.webp',null,'Free Range Goats',null,
 'Dry manure pellets from our free-range village goats. Mix a handful into the soil of pots, terrace and kitchen gardens to help plants grow healthy. Gentle on plants, low smell. Comes in a sealed bag, packed separately from meat.',
 true,false,20,true),
('garden-goat-rumen-manure','Goat Rumen Manure',null,80,'kg','garden','product/garden-pellets.webp',null,'Free Range Goats',null,
 'Made from rumen: the partly digested grass and leaves from the goat''s stomach, stored and aged for months before packing. Contains natural nutrients that feed the soil. Mix it into the soil before planting, best for farms and big gardens. Comes in a sealed bag, packed separately from meat.',
 true,false,21,true)
on conflict (slug) do update set
  name = excluded.name,
  price = excluded.price,
  unit = excluded.unit,
  category = excluded.category,
  image = excluded.image,
  badge = excluded.badge,
  short_desc = excluded.short_desc,
  in_stock = excluded.in_stock,
  sort_order = excluded.sort_order,
  active = excluded.active;

-- Hide old garden rows in case an earlier version of this file was run
update products set active = false where slug in ('garden-goat-compost','garden-goat-cutting-manure','garden-goat-manure');

-- ═══════════════════════════════════════════════════
--  DONE. Both garden products are active.
-- ═══════════════════════════════════════════════════

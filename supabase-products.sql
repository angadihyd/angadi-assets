-- ═══════════════════════════════════════════════════
--  ANGADI — Products Catalog (run AFTER supabase-migration.sql)
--  Makes the catalog DB-driven: admin edits → live storefront.
--  Run in: Supabase Dashboard → SQL Editor → Run
-- ═══════════════════════════════════════════════════

create table if not exists products (
  id          uuid default gen_random_uuid() primary key,
  slug        text unique not null,        -- 'goat-meat' (used in product-detail.html?id=)
  name        text not null,
  name_te     text,
  price       numeric(10,2) not null default 0,
  unit        text default 'kg',
  category    text default 'goat',         -- goat | chicken | fish | eggs
  image       text,                        -- e.g. 'product/mutton.png' (root-relative)
  video       text,                        -- optional mp4 path
  badge       text,
  fresh_label text,
  short_desc  text,
  in_stock    boolean default true,
  stock       int default 0,               -- optional quantity counter
  featured    boolean default false,
  sort_order  int default 100,
  active      boolean default true,        -- soft-delete / hide without losing data
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create trigger products_updated_at
  before update on products
  for each row execute function update_updated_at();

-- ── RLS (MVP, anon key — same tradeoff as orders) ──
alter table products enable row level security;
drop policy if exists "products_anon_read"   on products;
drop policy if exists "products_anon_write"  on products;
create policy "products_anon_read"  on products for select using (true);
create policy "products_anon_write" on products for all    using (true) with check (true);

-- ── Realtime ──
do $$ begin
  begin execute 'alter publication supabase_realtime add table products'; exception when duplicate_object then null; end;
end $$;

-- ── Seed the 9 products (on conflict: keep existing so admin edits survive re-runs) ──
insert into products (slug,name,name_te,price,unit,category,image,video,badge,fresh_label,short_desc,in_stock,featured,sort_order) values
('goat-meat','Village Goat Meat','Meka Mamsam',680,'kg','goat','product/mutton.png','product/gaot farmer animated video.mp4','⭐ Bestseller','FRESH TODAY','Farm-raised Telangana goat, hand-cut to curry pieces. Rich flavour, tender texture. No hormones, no antibiotics.',true,true,1),
('country-chicken','Country Chicken','Nati Kodi',520,'kg','chicken','product/country chiken.png','product/country chiken animated video.mp4','🌿 Nati',null,'Free-range country chicken raised in open villages. Firm, flavourful, slow-cooked perfection. Available whole or curry cut.',true,true,2),
('river-fish','Fresh River Fish','Chepa Mukkalu',450,'kg','fish','product/fish.png','product/fisher man animated video.mp4','🐟 River Fresh',null,'Freshwater fish from Telangana rivers, cleaned and cut to order. Packed same day for maximum freshness.',true,true,3),
('baby-goat-legs','Baby Goat Legs','Pilla Meka Kalu',980,'kg','goat','product/ChatGPT Image Jun 3, 2026, 05_50_43 PM.png',null,'🏆 Premium',null,'Tender baby goat legs, perfect for slow-roast or biryani. Rare, seasonal, extraordinarily flavourful.',false,false,4),
('country-eggs','Country Eggs','Nati Kodi Gudlu',12,'egg','eggs','product/ChatGPT Image Jun 3, 2026, 05_24_46 PM.png',null,'🥚 Farm Fresh',null,'Deep golden yolk, rich flavour. Free-range hens from Telangana farms. Packed in 6s and 12s to your door.',true,false,5),
('full-goat','Full Goat','Poora Meka',8500,'goat','goat','product/mutton.png',null,'👑 Whole',null,'Whole farm goat, cleaned and cut to your preference. Ideal for events, functions & large families. Pre-order required.',true,false,6),
('goat-legs','Goat Legs','Meka Kalu',400,'4 pcs','goat','product/legs.png',null,'🦵 Fresh',null,'Collagen-rich village goat legs — perfect for paya curry, slow masala, and bone broth. Deeply nourishing.',true,false,7),
('goat-liver','Goat Liver','Meka Kalleja',1000,'kg','goat','product/liver.png',null,'💎 Premium',null,'Farm-fresh goat liver — extraordinarily rich in iron, B12, and Vitamin A. Village goat, processed same day.',true,false,8),
('goat-head','Goat Head','Meka Tala',520,'head','goat','product/head.png',null,'🐐 Whole',null,'Whole village goat head — prized for the brain, cheek meat, and tongue. Basis of the classic tala masala.',false,false,9)
on conflict (slug) do nothing;

-- ═══════════════════════════════════════════════════
--  DONE. Table: products (9 rows seeded)
-- ═══════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════
--  ANGADI — Coupons (admin-managed) — run in SQL Editor
-- ═══════════════════════════════════════════════════
create table if not exists coupons (
  id         uuid default gen_random_uuid() primary key,
  code       text unique not null,
  type       text default 'percent',   -- 'percent' | 'flat'
  value      numeric not null default 0,
  min_order  numeric default 0,
  label      text,
  active     boolean default true,
  expires_at date,
  created_at timestamptz default now()
);
alter table coupons enable row level security;
drop policy if exists "coupons_anon_read"  on coupons;
drop policy if exists "coupons_anon_write" on coupons;
create policy "coupons_anon_read"  on coupons for select using (true);
create policy "coupons_anon_write" on coupons for all    using (true) with check (true);

-- seed the existing 3 promo codes so they show in admin
insert into coupons (code,type,value,min_order,label) values
  ('ANGADI10','percent',10,0,'10% off'),
  ('FIRST100','flat',100,499,'₹100 off (orders ₹499+)'),
  ('VILLAGE','percent',5,0,'5% off')
on conflict (code) do nothing;
-- ═══════════════════════════════════════════════════

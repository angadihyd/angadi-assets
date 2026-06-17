-- ═══════════════════════════════════════════════════
--  ANGADI — Site settings (farmer spotlight, cut-off, banner)
--  Run in: Supabase Dashboard → SQL Editor → Run
-- ═══════════════════════════════════════════════════
create table if not exists site_settings (
  key   text primary key,
  value jsonb,
  updated_at timestamptz default now()
);
alter table site_settings enable row level security;
drop policy if exists "settings_anon_read"  on site_settings;
drop policy if exists "settings_anon_write" on site_settings;
create policy "settings_anon_read"  on site_settings for select using (true);
create policy "settings_anon_write" on site_settings for all    using (true) with check (true);

insert into site_settings (key, value) values
  ('farmer', '{"name":"Rafi Bhai","location":"Nalgonda","story":"12 years rearing native country goats on open pastures. Every animal hand-picked.","photo":""}'),
  ('cutoff', '{"hour":16,"label":"same-day delivery"}'),
  ('banner', '{"active":false,"text":"","cta":"Order Now"}'),
  ('features', '{"ticker":true,"sound":true,"goldenHour":true,"bulkOrder":true}'),
  ('delivery', '{"standard_fee":49,"free_above":999,"express_fee":99}')
on conflict (key) do nothing;
-- ═══════════════════════════════════════════════════

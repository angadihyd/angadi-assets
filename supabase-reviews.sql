-- ═══════════════════════════════════════════════════
--  ANGADI — Product reviews & ratings (run in SQL Editor)
-- ═══════════════════════════════════════════════════
create table if not exists reviews (
  id           uuid default gen_random_uuid() primary key,
  product_slug text not null,
  name         text,
  rating       int check (rating between 1 and 5),
  comment      text,
  status       text default 'approved',   -- 'approved' | 'hidden'
  created_at   timestamptz default now()
);
create index if not exists reviews_slug on reviews(product_slug);

alter table reviews enable row level security;
drop policy if exists "reviews_anon_read"  on reviews;
drop policy if exists "reviews_anon_write" on reviews;
-- public can read approved; admin pages (anon key) can read all + moderate
create policy "reviews_anon_read"  on reviews for select using (true);
create policy "reviews_anon_write" on reviews for all    using (true) with check (true);

do $$ begin
  begin execute 'alter publication supabase_realtime add table reviews'; exception when duplicate_object then null; end;
end $$;
-- ═══════════════════════════════════════════════════

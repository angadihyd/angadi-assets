-- ═══════════════════════════════════════════════════
--  ANGADI — Web Push subscriptions (run in SQL Editor)
-- ═══════════════════════════════════════════════════
create table if not exists push_subscriptions (
  id           uuid default gen_random_uuid() primary key,
  endpoint     text unique not null,
  p256dh       text not null,
  auth         text not null,
  role         text default 'admin',   -- 'admin' | 'partner'
  partner_code text,                    -- db1/db2/db3 for partners
  created_at   timestamptz default now()
);
alter table push_subscriptions enable row level security;
drop policy if exists "push_anon_all" on push_subscriptions;
create policy "push_anon_all" on push_subscriptions for all using (true) with check (true);
-- ═══════════════════════════════════════════════════

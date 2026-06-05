-- ═══════════════════════════════════════════════════
--  ANGADI — Order Lifecycle Migration
--  Full flow: pending → confirmed → preparing → ready →
--  assigned → picked_up → out_for_delivery → delivered → completed
--  Run in: Supabase Dashboard → SQL Editor → Run
-- ═══════════════════════════════════════════════════

-- ── 1. ORDERS: new default + lifecycle timestamps ────
alter table orders alter column status set default 'pending';

alter table orders add column if not exists ready_at      timestamptz;
alter table orders add column if not exists accepted_at   timestamptz;
alter table orders add column if not exists picked_up_at  timestamptz;
alter table orders add column if not exists delivered_at  timestamptz;
alter table orders add column if not exists accepted_by   text;  -- partner display name

-- ── 2. DELIVERY BOYS: login creds + stable code ──────
alter table delivery_boys add column if not exists code            text unique; -- db1/db2/db3
alter table delivery_boys add column if not exists username        text unique;
alter table delivery_boys add column if not exists password        text;
alter table delivery_boys add column if not exists active_order_id text;

-- Seed / upsert the three partners (codes match delivery-login.html)
insert into delivery_boys (code, username, password, name, phone, vehicle, area, status)
values
  ('db1','raju',   'raju123',   'Raju Kumar',   '+919949950001','Bike','Banjara Hills', 'available'),
  ('db2','suresh', 'suresh123', 'Suresh Babu',  '+919949950002','Bike','Madhapur',      'available'),
  ('db3','praveen','praveen123','Praveen Yadav','+919949950003','Bike','Gachibowli',    'available')
on conflict (code) do update
  set username = excluded.username,
      password = excluded.password,
      name     = excluded.name;

-- ── 3. ROW LEVEL SECURITY (MVP, anon-key) ────────────
-- ⚠️  SECURITY NOTE: Admin and delivery partners authenticate client-side
-- (no Supabase auth user), so these pages use the public anon key. The
-- policies below let anyone holding the anon key read/update orders and
-- delivery_boys. This is an acceptable MVP tradeoff to get cross-device
-- live updates working. TODO: before scaling, move privileged writes to
-- Supabase Edge Functions and give partners real auth identities, then
-- tighten these policies back down.

drop policy if exists "orders_own_read"   on orders;
drop policy if exists "orders_own_insert" on orders;
drop policy if exists "orders_anon_read"   on orders;
drop policy if exists "orders_anon_insert" on orders;
drop policy if exists "orders_anon_update" on orders;

create policy "orders_anon_read"   on orders for select using (true);
create policy "orders_anon_insert" on orders for insert with check (true);
create policy "orders_anon_update" on orders for update using (true) with check (true);

drop policy if exists "dboys_read"        on delivery_boys;
drop policy if exists "dboys_anon_read"   on delivery_boys;
drop policy if exists "dboys_anon_update" on delivery_boys;

create policy "dboys_anon_read"   on delivery_boys for select using (true);
create policy "dboys_anon_update" on delivery_boys for update using (true) with check (true);

-- ── 4. ENABLE REALTIME on orders + delivery_boys ─────
-- (so admin / partner / customer screens update live across devices)
do $$
begin
  begin execute 'alter publication supabase_realtime add table orders';        exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table delivery_boys';  exception when duplicate_object then null; end;
end $$;

-- ── 5. BACKFILL existing rows to the new model ───────
update orders set status = 'confirmed' where status in ('paid','paid_dev','confirmed_cod');
update orders set status = 'preparing' where status = 'processing';

-- ═══════════════════════════════════════════════════
--  DONE.
-- ═══════════════════════════════════════════════════

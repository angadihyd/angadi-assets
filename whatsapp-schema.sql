-- ═══════════════════════════════════════════════════
--  ANGADI — WhatsApp Ordering Automation
--  New tables for the WhatsApp bot. Reuses the EXISTING
--  `products` and `orders` tables (see supabase-products.sql /
--  supabase-setup.sql) so WhatsApp orders show up in the same
--  admin dashboard and push-notification flow as web orders.
--  Safe to run repeatedly. Run in: Supabase Dashboard → SQL Editor.
--  Requires supabase-setup.sql + supabase-products.sql already applied.
-- ═══════════════════════════════════════════════════

-- ── 1. WHATSAPP CUSTOMERS ────────────────────────
-- Remembers name + last address per WhatsApp number so returning
-- customers aren't asked to retype everything every week.
create table if not exists wa_customers (
  wa_id         text primary key,        -- WhatsApp number incl. country code, e.g. '91XXXXXXXXXX'
  name          text,
  last_address  text,
  last_area     text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

drop trigger if exists wa_customers_updated_at on wa_customers;
create trigger wa_customers_updated_at
  before update on wa_customers
  for each row execute function update_updated_at();

-- ── 2. DELIVERY AREAS ────────────────────────────
-- The serviceable zones shown as a WhatsApp list (~14 expected).
-- Edit rows here to add/remove zones or change delivery fees.
create table if not exists delivery_areas (
  id            uuid default gen_random_uuid() primary key,
  name          text not null,
  delivery_fee  numeric(10,2) default 0,
  active        boolean default true,
  sort_order    int default 100,
  created_at    timestamptz default now()
);

-- ── 3. ORDER WINDOWS ─────────────────────────────
-- One row per week. The bot only takes orders while now() is
-- between opens_at and closes_at. Insert next week's row manually
-- (or via a small script/cron later) — see WHATSAPP-SETUP.md.
create table if not exists order_windows (
  id            uuid default gen_random_uuid() primary key,
  opens_at      timestamptz not null,
  closes_at     timestamptz not null,
  delivery_date date not null,
  is_active     boolean default true,
  created_at    timestamptz default now()
);

create index if not exists order_windows_lookup on order_windows(is_active, opens_at, closes_at);

-- ── 4. CONVERSATION STATE ────────────────────────
-- One row per WhatsApp number tracking where they are in the
-- ordering conversation (product list → qty → area → payment).
create table if not exists wa_conversation_state (
  wa_id       text primary key,
  state       text default 'idle',
  context     jsonb default '{}'::jsonb,
  updated_at  timestamptz default now()
);

drop trigger if exists wa_conversation_state_updated_at on wa_conversation_state;
create trigger wa_conversation_state_updated_at
  before update on wa_conversation_state
  for each row execute function update_updated_at();

-- ── 4b. PROCESSED MESSAGES (idempotency) ─────────
-- Every inbound WhatsApp message id is INSERTed here before processing.
-- The unique constraint on msg_id makes this an atomic "claim" — if Meta
-- retries a webhook delivery, or a customer double-taps a button before
-- the first tap finishes, the second attempt's insert is skipped and that
-- request does NOT reprocess the message (see claimMessage() in
-- api/whatsapp-webhook.js). Rows are small and can be pruned periodically
-- (e.g. delete where created_at < now() - interval '30 days') — not
-- required for correctness, just housekeeping.
create table if not exists wa_processed_messages (
  msg_id      text primary key,
  created_at  timestamptz default now()
);

-- ── 5. ORDERS TABLE ADDITION ─────────────────────
-- Payment Links use a different id namespace ('plink_...') than
-- Razorpay Orders ('order_...' already stored in razorpay_order_id),
-- so this gets its own column — the two payment webhooks can never
-- match the wrong row. WhatsApp orders are tagged via
-- customer->>'source' = 'whatsapp' (no new column needed for that).
alter table orders add column if not exists razorpay_payment_link_id text;
create index if not exists orders_rzp_link_id on orders(razorpay_payment_link_id);

do $$
begin
  alter table orders add constraint orders_rzp_link_unique unique (razorpay_payment_link_id);
exception
  when duplicate_object then null;
  when duplicate_table  then null;
end $$;

-- ── 6. ROW LEVEL SECURITY ────────────────────────
-- wa_customers and wa_conversation_state hold phone numbers (PII) and
-- are only ever touched by the webhook using the service-role key —
-- so unlike products/orders (which intentionally allow anon read/write
-- as an MVP tradeoff), these get NO anon policies at all. Default deny.
alter table wa_customers           enable row level security;
alter table wa_conversation_state  enable row level security;
alter table wa_processed_messages  enable row level security;

-- delivery_areas and order_windows are not sensitive — allow public
-- read only (e.g. useful later for a "we deliver to your area?" widget
-- on the website), writes stay service-role only.
alter table delivery_areas enable row level security;
alter table order_windows  enable row level security;

drop policy if exists "delivery_areas_anon_read" on delivery_areas;
create policy "delivery_areas_anon_read" on delivery_areas for select using (true);

drop policy if exists "order_windows_anon_read" on order_windows;
create policy "order_windows_anon_read" on order_windows for select using (true);

-- ── 7. SEED: delivery areas (EDIT to match your real ~14 zones) ──
insert into delivery_areas (name, delivery_fee, sort_order) values
  ('Kukatpally',       0, 1),
  ('Miyapur',           0, 2),
  ('Madhapur',          0, 3),
  ('Gachibowli',        0, 4),
  ('Hitech City',       0, 5),
  ('Kondapur',          0, 6),
  ('Ameerpet',          0, 7),
  ('Begumpet',          0, 8),
  ('Secunderabad',      0, 9),
  ('Dilsukhnagar',      0, 10),
  ('LB Nagar',          0, 11),
  ('Uppal',             0, 12),
  ('Banjara Hills',     0, 13),
  ('Jubilee Hills',     0, 14)
on conflict do nothing;

-- ── 8. SEED: this week's order window (EDIT the dates!) ──
-- Example: opens now, closes next Saturday 8pm IST, delivers next Sunday.
-- Replace the dates below before running, or delete this block and
-- insert manually each week from the Supabase Table Editor.
-- insert into order_windows (opens_at, closes_at, delivery_date) values
--   (now(), '2026-09-12 20:00:00+05:30', '2026-09-13');

-- ═══════════════════════════════════════════════════
--  DONE. New tables: wa_customers, delivery_areas,
--  order_windows, wa_conversation_state,
--  wa_processed_messages.
--  orders table: +razorpay_payment_link_id column.
-- ═══════════════════════════════════════════════════

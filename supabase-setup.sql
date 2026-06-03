-- ═══════════════════════════════════════════════════
--  ANGADI — Supabase Database Setup
--  Run this in: Supabase Dashboard → SQL Editor → Run
-- ═══════════════════════════════════════════════════

-- ── 1. PROFILES ──────────────────────────────────
create table if not exists profiles (
  id            uuid references auth.users(id) on delete cascade primary key,
  name          text,
  phone         text,
  email         text,
  dob           date,
  cut_pref      text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- Auto-update updated_at
create or replace function update_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger profiles_updated_at
  before update on profiles
  for each row execute function update_updated_at();

-- ── 2. ADDRESSES ─────────────────────────────────
create table if not exists addresses (
  id            uuid default gen_random_uuid() primary key,
  user_id       uuid references profiles(id) on delete cascade,
  flat          text,
  area          text,
  landmark      text,
  pincode       text,
  city          text default 'Hyderabad',
  type          text default 'Home',
  is_default    boolean default false,
  created_at    timestamptz default now()
);

-- Only one default address per user
create unique index if not exists one_default_address
  on addresses(user_id) where is_default = true;

-- ── 3. ORDERS ────────────────────────────────────
create table if not exists orders (
  id            uuid default gen_random_uuid() primary key,
  order_id      text unique,            -- e.g. ANG-M5K2X-P9QR
  user_id       uuid references profiles(id),
  customer      jsonb,                  -- {name, phone, address, slot, notes}
  items         jsonb,                  -- [{name, price, qty}]
  subtotal      numeric(10,2) default 0,
  delivery      numeric(10,2) default 0,
  discount      numeric(10,2) default 0,
  total         numeric(10,2) default 0,
  payment       text default 'razorpay',-- 'razorpay' | 'cod'
  payment_id    text,                   -- Razorpay payment ID
  status        text default 'confirmed',
  assigned_to   text,                   -- delivery boy ID
  placed_at     timestamptz default now(),
  updated_at    timestamptz default now()
);

create trigger orders_updated_at
  before update on orders
  for each row execute function update_updated_at();

-- Index for fast customer lookups
create index if not exists orders_user_id on orders(user_id);
create index if not exists orders_status   on orders(status);
create index if not exists orders_placed   on orders(placed_at desc);

-- ── 4. DELIVERY BOYS ─────────────────────────────
create table if not exists delivery_boys (
  id                uuid default gen_random_uuid() primary key,
  name              text not null,
  phone             text not null,
  vehicle           text default 'Bike',
  area              text,
  status            text default 'available', -- 'available'|'busy'|'offline'
  emergency_contact text,
  vehicle_number    text,
  delivered_today   int default 0,
  total_delivered   int default 0,
  created_at        timestamptz default now()
);

-- ── 5. ROW LEVEL SECURITY ────────────────────────
-- Enable RLS on all tables
alter table profiles      enable row level security;
alter table addresses     enable row level security;
alter table orders        enable row level security;
alter table delivery_boys enable row level security;

-- profiles: users can only read/write their own
create policy "profiles_own" on profiles
  for all using (auth.uid() = id);

-- addresses: users can only access their own
create policy "addresses_own" on addresses
  for all using (auth.uid() = user_id);

-- orders: users can read their own; service role can read all
create policy "orders_own_read" on orders
  for select using (auth.uid() = user_id);
create policy "orders_own_insert" on orders
  for insert with check (auth.uid() = user_id);

-- delivery_boys: readable by authenticated users, writable by service role only
create policy "dboys_read" on delivery_boys
  for select using (auth.role() = 'authenticated');

-- ── 6. STORAGE BUCKET (product images) ──────────
-- Run in Supabase Dashboard → Storage → Create bucket
-- Bucket name: product-images
-- Public: true

-- ═══════════════════════════════════════════════════
--  DONE. Tables created:
--  ✅ profiles
--  ✅ addresses
--  ✅ orders
--  ✅ delivery_boys
-- ═══════════════════════════════════════════════════

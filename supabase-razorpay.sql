-- ═══════════════════════════════════════════════════════════════
--  Angadi — Razorpay payment migration
--  Run this ONCE in: Supabase Dashboard → SQL Editor → New query → Run
--  It only adds what the payment system needs. Safe to run repeatedly,
--  and it will NOT error on things that already exist.
-- ═══════════════════════════════════════════════════════════════

-- Link a Razorpay order to our order row (the webhook / verify-payment
-- use this to mark the order 'paid').
alter table orders add column if not exists razorpay_order_id text;

-- Fast lookups + prevent duplicates (guarded so re-running won't error).
create index if not exists orders_rzp_id on orders(razorpay_order_id);

do $$
begin
  alter table orders add constraint orders_rzp_unique unique (razorpay_order_id);
exception
  when duplicate_object then null;
  when duplicate_table  then null;
end $$;

-- Done. The 'orders' table can now store razorpay_order_id.

-- ═══════════════════════════════════════════════════════════════
--  ANGADI — SECURITY LOCKDOWN (run in Supabase → SQL Editor → Run)
--
--  Before this migration the public anon key could:
--    • read EVERY order (all customer names, phones, addresses)
--    • update/insert/cancel any order
--    • rewrite product prices, create coupons, approve reviews
--    • read/write all push subscriptions and delivery staff rows
--
--  After this migration the anon key can ONLY:
--    • read active products, active coupons, site settings,
--      approved reviews
--    • submit a review (it lands as 'pending' for moderation)
--    • (logged-in customers) read their own orders by user_id
--
--  Everything else goes through the Vercel serverless APIs which
--  use the SERVICE ROLE key + token auth:
--    /api/create-order  – all order creation (online AND COD)
--    /api/my-orders     – customer order list / track / cancel
--    /api/admin         – admin panel + delivery partner app
--
--  Run AFTER deploying the matching code and setting env vars
--  (see SECURITY-SETUP.md). Safe to re-run — idempotent.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. ORDERS — remove all public access ─────────────────────────
drop policy if exists "orders_anon_read"   on orders;
drop policy if exists "orders_anon_insert" on orders;
drop policy if exists "orders_anon_update" on orders;
-- client inserts are gone too: /api/create-order (service role) is
-- now the only writer, so prices can never be tampered with.
drop policy if exists "orders_own_insert"  on orders;
-- keep: logged-in customers may read their own orders directly.
drop policy if exists "orders_own_read" on orders;
create policy "orders_own_read" on orders
  for select using (auth.uid() = user_id);

-- extra timestamp used by the new cancel flow
alter table orders add column if not exists cancelled_at timestamptz;

-- ── 2. DELIVERY BOYS — staff data is not public ──────────────────
drop policy if exists "dboys_anon_read"   on delivery_boys;
drop policy if exists "dboys_anon_update" on delivery_boys;
drop policy if exists "dboys_read"        on delivery_boys;
-- no client policies at all: only /api/admin (service role) touches it.

-- ── 3. PRODUCTS — public read of live catalog, no public writes ──
drop policy if exists "products_anon_read"  on products;
drop policy if exists "products_anon_write" on products;
create policy "products_public_read" on products
  for select using (active = true);
-- admin edits go through /api/admin.

-- ── 4. COUPONS — customers can only see active codes ─────────────
drop policy if exists "coupons_anon_read"  on coupons;
drop policy if exists "coupons_anon_write" on coupons;
create policy "coupons_public_read" on coupons
  for select using (active = true);
-- create/edit/delete via /api/admin only.

-- ── 5. SITE SETTINGS — public read, admin-only write ─────────────
drop policy if exists "settings_anon_read"  on site_settings;
drop policy if exists "settings_anon_write" on site_settings;
create policy "settings_public_read" on site_settings
  for select using (true);

-- ── 6. REVIEWS — read approved; submissions land as pending ──────
drop policy if exists "reviews_anon_read"  on reviews;
drop policy if exists "reviews_anon_write" on reviews;
alter table reviews alter column status set default 'pending';
create policy "reviews_public_read" on reviews
  for select using (status = 'approved');
create policy "reviews_public_submit" on reviews
  for insert with check (status = 'pending');
-- approve/hide/delete via /api/admin (admin/reviews.html).

-- ── 7. PUSH SUBSCRIPTIONS — server-only ──────────────────────────
drop policy if exists "push_anon_all" on push_subscriptions;
-- /api/subscribe and /api/notify use the service role key.

-- ═══════════════════════════════════════════════════════════════
--  VERIFY (optional — run each; all four should return zero rows
--  or a "permission denied"-style empty result when called with
--  the anon key from the API docs / a curl test):
--
--  curl "$SUPABASE_URL/rest/v1/orders?select=customer&limit=1" \
--       -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
--     → []            (was: full customer data)
--
--  curl "$SUPABASE_URL/rest/v1/delivery_boys?select=*" ...      → []
--  curl "$SUPABASE_URL/rest/v1/push_subscriptions?select=*" ... → []
--  curl -X PATCH "$SUPABASE_URL/rest/v1/products?slug=eq.goat-meat" \
--       -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
--       -H "Content-Type: application/json" -d '{"price":1}'
--     → 0 rows updated (was: price changed to ₹1)
-- ═══════════════════════════════════════════════════════════════

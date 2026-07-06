# Angadi — Security Lockdown Setup

This deploy closes the holes found in the July 2026 security audit:

| Before | After |
|---|---|
| Anyone could read every order (all customer names, phones, addresses) with the public key | Orders are private. Customers see only their own (via OTP login or Order-ID + phone) |
| Anyone could update/cancel any order, change product prices, create coupons, approve reviews | All writes go through token-guarded server APIs |
| Admin password was visible in the page source (plus a dev hint on the login screen) | Password lives only in a Vercel env var, checked server-side |
| Delivery partner passwords hardcoded in the page | Partner credentials live in an env var, verified server-side |
| COD orders trusted browser-set prices (₹1 goat possible) | COD goes through `/api/create-order` with server-validated prices + ₹5,000 COD limit enforced |
| Online orders with weight suffixes could be silently overcharged, and unknown item names could set their own price | Prices come from the products table; weights are parsed and validated; unknown items rejected |
| Admin-created coupons were ignored at payment time (customers paid more than cart showed) | Server honours DB coupons incl. min-order and expiry |
| Dashboard CSV export & stock toggle only touched localStorage (did nothing in production) | Both work against live data now |

## 1. Set Vercel environment variables

Vercel → Project → Settings → Environment Variables. You should already have
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RAZORPAY_KEY_ID`,
`RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `VAPID_PUBLIC`, `VAPID_PRIVATE`.

Add these new ones:

```
ADMIN_TOKEN     = <a long random password — this IS the admin login password>
                  e.g. run:  openssl rand -base64 24
                  Do NOT reuse "Sunset@123" or "angadi123" — both were public.

PARTNER_CREDS   = {"raju":{"password":"<new-pass>","code":"db1","name":"Raju Kumar"},
                   "suresh":{"password":"<new-pass>","code":"db2","name":"Suresh Babu"},
                   "praveen":{"password":"<new-pass>","code":"db3","name":"Praveen Yadav"}}
                  (one line of JSON; pick NEW passwords — the old raju123/… were public)

SUPABASE_ANON_KEY = <your anon key>   (optional — used to verify customer OTP
                     sessions in /api/my-orders; falls back to the service key)
```

## 2. Deploy the code

Push/deploy this commit. New/changed serverless functions:
`api/admin.js` (new), `api/my-orders.js` (new), `api/create-order.js`,
`api/notify.js`, `api/subscribe.js`. Total functions: 8 (within Vercel's free limit of 12).

## 3. Run the SQL lockdown

Supabase Dashboard → SQL Editor → paste and run
[`supabase-security-lockdown.sql`](supabase-security-lockdown.sql).
Safe to re-run. Do this AFTER the code deploy (steps 1–2), otherwise the
admin panel and COD checkout briefly lose their data source.

## 4. Storage bucket (manual, 1 minute)

Dashboard → Storage → `product-images` → Policies:
- Keep the public **SELECT** (read) policy — product photos are public.
- **Delete any INSERT / UPDATE / DELETE policies for `anon`** — uploads now go
  through the admin API with the service key.

## 5. Verify (2 minutes)

With `$ANON` = your anon key:

```bash
# all four should return [] or a permission error — NOT data:
curl "https://www.angadi.farm/api/supabase/rest/v1/orders?select=customer&limit=1" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
curl "https://www.angadi.farm/api/supabase/rest/v1/delivery_boys?select=*" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
curl "https://www.angadi.farm/api/supabase/rest/v1/push_subscriptions?select=*" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
curl -X PATCH "https://www.angadi.farm/api/supabase/rest/v1/products?slug=eq.goat-meat" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H "Content-Type: application/json" -d '{"price":1}' -i   # expect 0 rows updated
```

Then click through:
1. `/admin/dashboard.html` → log in with the new ADMIN_TOKEN → orders load, stock toggle works.
2. `/admin/delivery-login.html` → partner login with a new password → offers list loads.
3. Shop → add to cart → checkout COD → order appears in admin.
4. `my-orders.html` → order status shows and updates.

## Notes

- The **anon key staying public is fine** — that's its design. Safety now comes
  from row-level-security policies, not secrecy.
- The admin "login" flag in the browser is cosmetic; real enforcement is the
  `x-admin-token` header checked by `/api/admin` on every request.
- Customer reviews now land as **pending** — approve them in Admin → Reviews.
- If the admin panel shows "Admin API not configured", the env vars from
  step 1 aren't set on the deployment.

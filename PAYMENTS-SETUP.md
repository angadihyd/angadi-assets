# Angadi — Automatic Online Payments (Razorpay)

This sets up **cashless payments with automatic confirmation**. Money is
confirmed by Razorpay's webhook, so a "paid" order can never be faked from
the browser. UPI is ~0% commission; cards ~2%.

## How it works

```
Customer clicks Pay
   → /api/create-order    (server validates prices, creates Razorpay order, saves PENDING order)
   → Razorpay UPI/card popup
   → customer pays
   → /api/verify-payment  (checks the signature → marks order "paid" instantly for the user)
   → /api/razorpay-webhook (reliable backstop: also marks "paid" even if the browser closed)
   → admin (Supabase) shows a "Confirmed" order, ready to fulfil
```

Orders only become `paid` via the server (verify-payment / webhook). The browser
can never set the amount or the paid status.

### Endpoints
| Endpoint | Purpose |
|----------|---------|
| `POST /api/create-order` | Validates cart prices server-side, creates the Razorpay order, saves a `pending` order |
| `POST /api/verify-payment` | Verifies the checkout signature (HMAC-SHA256 of `order_id\|payment_id`), marks order `paid` |
| `POST /api/razorpay-webhook` | Razorpay → server callback; backstop that also marks `paid` (idempotent) |
| `GET/PATCH /api/admin/orders` | Admin panel reads/updates ALL orders (service-role, token-protected) |

---

## One-time setup

### 1. Create a Razorpay account (free)
- Sign up at https://razorpay.com — no setup or annual fee.
- Complete KYC (PAN, bank account) to accept live payments.
- Until KYC is done, use **Test Mode** keys to try everything end to end.

### 2. Get your API keys
Razorpay Dashboard → **Settings → API Keys → Generate Key**
- `Key Id`  → use as `RAZORPAY_KEY_ID`
- `Key Secret` → use as `RAZORPAY_KEY_SECRET` (shown once — copy it)

### 3. Get your Supabase service-role key
Supabase Dashboard → **Settings → API**
- Project URL → `SUPABASE_URL` = `https://ijvkvgmzjjhwvrwtladj.supabase.co`
- **service_role** secret → `SUPABASE_SERVICE_ROLE_KEY`
  ⚠️ Never put this in any HTML file — server only.

### 4. Add environment variables in Vercel
Vercel → your project → **Settings → Environment Variables** (Production):

| Name | Value |
|------|-------|
| `RAZORPAY_KEY_ID` | your rzp_test_… (test) / rzp_live_… (live) key id |
| `RAZORPAY_KEY_SECRET` | your secret |
| `RAZORPAY_WEBHOOK_SECRET` | you choose this in step 5 |
| `SUPABASE_URL` | https://ijvkvgmzjjhwvrwtladj.supabase.co |
| `SUPABASE_SERVICE_ROLE_KEY` | your service_role key |
| `ADMIN_TOKEN` | a private admin token (keep it secret; not stored in this repo) |

Redeploy after adding them. The test keys are already in your local `.env`
(git-ignored) for `vercel dev`; production must use the Vercel dashboard.

> **ADMIN_TOKEN** must equal the password used to sign in to the admin panel.
> The admin pages send it as the `x-admin-token` header so the server can let
> them read all orders with the service-role key. Change both before going live.

### 5. Create the webhook
Razorpay Dashboard → **Settings → Webhooks → Add New Webhook**
- **URL:** `https://www.angadi.farm/api/razorpay-webhook`
- **Secret:** make up a strong random string → also paste it as
  `RAZORPAY_WEBHOOK_SECRET` in Vercel (must match exactly).
- **Active events:** tick `payment.captured` (optionally also `order.paid`).
- Save.

### 6. Update the database
Run the updated `supabase-setup.sql` in Supabase → SQL Editor. It adds the
`razorpay_order_id` column and tightens the security rules. Safe to re-run.

---

## Test it (Test Mode)
1. Use `rzp_test_...` keys.
2. Place an order on the site → pay with a Razorpay test UPI / test card
   (e.g. card `4111 1111 1111 1111`, any future expiry, any CVV).
3. Check Supabase `orders`: the row should flip from `pending` → `paid`
   within a second or two (that's the webhook).
4. Check the admin Orders page: it shows "Confirmed".

If it stays `pending`: open Razorpay Dashboard → Webhooks → your webhook →
recent deliveries, and check the response. A 400 means the secret doesn't
match; 500 means a missing env var.

---

## Going live
- Finish Razorpay KYC, switch to `rzp_live_...` keys in Vercel.
- Point the webhook at the live URL (same `/api/razorpay-webhook`).
- That's it — UPI payments will auto-confirm at near-zero commission.

## Notes / future
- Product prices are duplicated in `api/create-order.js` (the `PRICES` map).
  Keep them in sync with `shop.html` / `product-detail.html`, or later move
  them to a Supabase `products` table so there's a single source of truth.
- Cash-on-Delivery still works and is created directly by the browser
  (it has no payment to confirm).

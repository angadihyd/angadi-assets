# ANGADI WhatsApp Ordering Automation — Setup

Self-built WhatsApp ordering bot. No monthly SaaS fee — you pay Meta's
per-conversation rate (Cloud API) and Razorpay's normal payment fees.

## Architecture

```
Customer's WhatsApp
        │
        ▼
Meta WhatsApp Cloud API  ──webhook──▶  api/whatsapp-webhook.js  (Vercel)
                                              │
                                              ▼
                                         Supabase (products, orders,
                                         wa_customers, delivery_areas,
                                         order_windows, wa_conversation_state)
                                              │
                                              ▼
                                   Razorpay Payment Link (if "Pay Online")
                                              │
                                    payment_link.paid webhook
                                              ▼
                              api/whatsapp-payment-webhook.js (Vercel)
                                  → marks order 'paid' + confirms on WhatsApp
```

Orders land in the **same `orders` table** the website uses
(`customer.source = 'whatsapp'` tags them), so they appear automatically in
`admin/orders.html` and trigger the existing push notification
(`api/notify.js`) — no separate admin screen needed.

## Files

- `whatsapp-schema.sql` — new tables (run once in Supabase)
- `api/whatsapp-webhook.js` — Meta webhook: verification + conversation logic
- `api/whatsapp-payment-webhook.js` — Razorpay Payment Link webhook
- `.env.example` — updated with the 5 new env vars this needs

## 1. Supabase

1. Supabase Dashboard → SQL Editor → paste and run **`whatsapp-schema.sql`**.
2. Edit the seeded `delivery_areas` rows to match your real ~14 zones
   (Table Editor → `delivery_areas`, or re-run an `insert` block with your
   actual zone names/fees).
3. Insert this week's order window (Table Editor → `order_windows`, or SQL):
   ```sql
   insert into order_windows (opens_at, closes_at, delivery_date)
   values (now(), '2026-09-12 20:00:00+05:30', '2026-09-13');
   ```
   The bot only takes orders while `now()` is between `opens_at` and
   `closes_at`. You (or a scheduled task later) need to insert a fresh row
   each week — nothing does this automatically yet.

## 2. Meta WhatsApp Cloud API

You've already created the Meta Business app. Remaining steps:

1. **Meta App Dashboard → WhatsApp → API Setup**: copy the **Phone number ID**
   → `META_PHONE_NUMBER_ID`.
2. Generate an access token. The default temporary token **expires in 24
   hours** — fine for testing, but before going live create a **System
   User** (Meta Business Settings → System Users → Add) with `whatsapp_business_messaging`
   permission and generate a **permanent token** from it → `META_ACCESS_TOKEN`.
3. **WhatsApp → Configuration → Webhook**:
   - Callback URL: `https://www.angadi.farm/api/whatsapp-webhook`
   - Verify token: any string you pick, put the same value in `META_VERIFY_TOKEN`
   - Subscribe to webhook field: **messages**
4. (Recommended) **App Settings → Basic**: copy the **App Secret** →
   `META_APP_SECRET`. This lets the webhook verify inbound requests are
   really from Meta (via `X-Hub-Signature-256`) instead of accepting anyone
   who finds the URL.

## 3. Razorpay — second webhook for Payment Links

Your existing webhook (`/api/razorpay-webhook`) only listens for
`payment.captured` on Orders created via the website checkout. WhatsApp uses
**Payment Links** instead (no checkout page to redirect to), which fire a
different event, so it needs its **own** webhook registration:

1. Razorpay Dashboard → Settings → Webhooks → **Add New Webhook**.
2. URL: `https://www.angadi.farm/api/whatsapp-payment-webhook`
3. Active event: **`payment_link.paid`**
4. Razorpay shows you a secret for this specific webhook — copy it into
   `RAZORPAY_WHATSAPP_WEBHOOK_SECRET` (this is intentionally a *different*
   value from `RAZORPAY_WEBHOOK_SECRET`, even though both live in the same
   Razorpay account).

`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` are reused as-is — no change there.

## 4. Vercel env vars

Add these 5 in Vercel → Project → Settings → Environment Variables (all
environments), then **redeploy** (env var changes don't apply until the next
deploy — see the gotcha already noted for the Razorpay setup):

| Variable | Where it comes from |
|---|---|
| `META_ACCESS_TOKEN` | Meta System User permanent token (step 2 above) |
| `META_PHONE_NUMBER_ID` | Meta App Dashboard → WhatsApp → API Setup |
| `META_VERIFY_TOKEN` | any string you choose |
| `META_APP_SECRET` | Meta App Dashboard → Settings → Basic |
| `ADMIN_WHATSAPP_NUMBER` | your own WhatsApp number, digits only incl. country code (e.g. `91XXXXXXXXXX`) — optional, powers the "talk to us" handoff below |
| `RAZORPAY_WHATSAPP_WEBHOOK_SECRET` | Razorpay → new webhook (step 3) |

## 5. Deploy

Same as always — push to `main`, Vercel auto-deploys from GitHub.

## Talking to a human

Any customer can type **talk**, **help**, **human**, **agent**, **support**,
**call**, or **question** at any point to skip the bot. They get an
acknowledgment ("we'll reply here shortly"), and — if `ADMIN_WHATSAPP_NUMBER`
is set — you get a WhatsApp message with their number and a `wa.me` link so
you can reply directly in the same chat. There's also a **💬 Talk to us**
button on the "add another item?" and payment screens for anyone who'd
rather tap than type. Once handed off, the bot stays silent on that chat
until the customer types a restart word (hi/menu/order/start) — it won't
talk over you while you're replying.

## 6. Verify before going live

- [ ] **Webhook verification**: after setting the Meta webhook URL, Meta
      calls it with a GET request immediately — Meta's dashboard shows a
      green checkmark if `hub.challenge` was echoed back correctly. If it
      fails, double check `META_VERIFY_TOKEN` matches exactly.
- [ ] **Send "hi"** from a real WhatsApp number to your business number —
      confirm the product list message appears (or the "orders closed"
      message, if you haven't inserted an `order_windows` row yet).
- [ ] **List row limits**: WhatsApp interactive lists cap at **10 rows per
      message**. Both the product list and the delivery-area list paginate
      past that ("➡️ More items" / "➡️ More areas") — if you have more than
      9 active products or delivery zones, test that the second page
      actually appears and that picking from it works.
- [ ] **COD path end-to-end**: complete an order choosing Cash on Delivery,
      confirm it appears in `admin/orders.html` with status `confirmed_cod`
      and you get the existing push notification.
- [ ] **Online path end-to-end**: complete an order choosing Pay Online,
      actually pay the Razorpay link (use test mode first if you have test
      keys), confirm the order flips to `paid` in Supabase and you receive
      the "Payment received" WhatsApp message.
- [ ] **Duplicate-delivery safety**: send an order through once normally.
      Then, to sanity-check the idempotency guard, try rapidly double-tapping
      a "Pay Online"/"Cash on Delivery" button — confirm only ONE order/row
      is created (check `wa_processed_messages` picked up both message ids
      but only one led to a `sbPost` into `orders`).
- [ ] **Price refresh**: start an order, add an item, then (from the
      Supabase Table Editor) change that product's price before finishing
      the conversation. Confirm the final order/payment amount reflects the
      NEW price, not the one shown when you first picked the item.
- [ ] **Talk to us**: type "talk" mid-conversation (or tap the 💬 button on
      the add-item/payment screens) — confirm you get the acknowledgment and,
      if `ADMIN_WHATSAPP_NUMBER` is set, that number receives the handoff
      message. Confirm the bot stays silent afterward until you type "hi".
- [ ] **Token expiry**: if you're still using a temporary Meta access token,
      it will silently stop working after 24h — the webhook will 401
      against Meta's Send Message API. Set up the permanent System User
      token (step 2) before relying on this for real customers.
- [ ] **Push notification trigger**: confirm the Supabase Database Webhook
      that calls `/api/notify` on `orders` INSERT is still active — it
      wasn't touched by this change, but it's worth a quick check since
      WhatsApp orders depend on the same trigger firing.

## Known limitations / follow-ups (not built yet)

- No cancel/edit-order flow once an order is placed.
- No cron/automation for opening next week's `order_windows` row — it's a
  manual (or manually-scripted) weekly step for now.
- Product list is text-only (Meta list rows don't support images).
- Single language (English) — no Telugu conversation flow yet.
- If average processing time per message grows (many sequential Supabase/Meta
  calls), consider acknowledging Meta's webhook immediately and processing
  asynchronously instead of awaiting everything before responding — the
  `wa_processed_messages` claim would need to move earlier in that case too.
- `wa_processed_messages` grows forever; periodically pruning rows older than
  ~30 days is safe (nothing reads old rows) but isn't automated yet.
- The double-tap dedup relies on a DB unique constraint, so it's atomic even
  under real concurrency — but two *genuinely simultaneous* first-time
  messages with different Meta-assigned ids (not a realistic case) wouldn't
  be caught by it; that's a different, essentially theoretical scenario.

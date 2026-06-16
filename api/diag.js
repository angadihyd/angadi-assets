// TEMPORARY diagnostic — reports config presence (booleans only, NO secret
// material) and the live Supabase response, to pinpoint why create-order's
// save fails. DELETE after debugging.
//   GET /api/_diag?key=angadi-diag-9f3
module.exports = async (req, res) => {
  if ((req.query?.key || '') !== 'angadi-diag-9f3') {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const {
    RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET,
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_TOKEN,
  } = process.env;

  const present = (v) => v != null && v.length > 0;

  const out = {
    env_present: {
      RAZORPAY_KEY_ID:           present(RAZORPAY_KEY_ID),
      RAZORPAY_KEY_SECRET:       present(RAZORPAY_KEY_SECRET),
      RAZORPAY_WEBHOOK_SECRET:   present(RAZORPAY_WEBHOOK_SECRET),
      SUPABASE_SERVICE_ROLE_KEY: present(SUPABASE_SERVICE_ROLE_KEY),
      ADMIN_TOKEN:               present(ADMIN_TOKEN),
    },
    // SUPABASE_URL is a public project URL (already in client code) — safe to echo
    // so we can spot a malformed value (missing https://, trailing slash, spaces).
    SUPABASE_URL_value: SUPABASE_URL || 'MISSING',
    service_role_is_jwt: !!(SUPABASE_SERVICE_ROLE_KEY && SUPABASE_SERVICE_ROLE_KEY.startsWith('eyJ')),
  };

  // Live read-only test against Supabase using the service-role key.
  out.supabase_test = {};
  try {
    const url = `${SUPABASE_URL}/rest/v1/orders?select=order_id&limit=1`;
    const r = await fetch(url, {
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY || '',
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY || ''}`,
      },
    });
    out.supabase_test.http_status = r.status;        // 200 = OK, 401 = bad key, 404 = bad url
    out.supabase_test.body = (await r.text()).slice(0, 200);
  } catch (e) {
    out.supabase_test.error = String(e);             // e.g. "Failed to parse URL" = malformed SUPABASE_URL
  }

  res.status(200).json(out);
};

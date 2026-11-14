// ═══════════════════════════════════════════════════════════════
//  GET /api/pincode?pin=500072
//  Looks up an Indian PIN code (India Post data via api.postalpincode.in)
//  server-side and says whether it is inside Angadi's Hyderabad area.
//
//  Response: { ok, pin, areas:[names], district, state, zone }
//    zone = 'in'      Hyderabad / Rangareddy / Medchal-Malkajgiri
//         | 'unsure'  elsewhere in Telangana (confirm on WhatsApp)
//         | 'out'     outside Telangana
//
//  Advisory only: the checkout never blocks on this, and if the lookup
//  fails it returns ok:false so the form simply carries on.
// ═══════════════════════════════════════════════════════════════

const IN_DISTRICTS = ['hyderabad', 'rangareddy', 'ranga reddy', 'medchal', 'malkajgiri'];
const cache = new Map(); // warm-instance cache; pincodes rarely change

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
  let pin = '';
  try { pin = new URL(req.url, 'http://x').searchParams.get('pin') || ''; }
  catch { res.status(400).json({ ok: false, error: 'bad request' }); return; }
  pin = pin.trim();
  if (!/^[1-9]\d{5}$/.test(pin)) { res.status(400).json({ ok: false, error: 'pin must be 6 digits' }); return; }

  if (cache.has(pin)) { res.status(200).json(cache.get(pin)); return; }

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(`https://api.postalpincode.in/pincode/${pin}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error('upstream ' + r.status);
    const data = await r.json();
    const hit = Array.isArray(data) ? data[0] : null;
    if (!hit || hit.Status !== 'Success' || !Array.isArray(hit.PostOffice) || !hit.PostOffice.length) {
      // Genuinely unknown PIN (not an outage): tell the client so it can say so.
      const out = { ok: true, pin, found: false };
      cache.set(pin, out);
      res.status(200).json(out);
      return;
    }
    const offices = hit.PostOffice;
    const district = String(offices[0].District || '');
    const state = String(offices[0].State || '');
    const d = district.toLowerCase();
    const zone = state.toLowerCase() !== 'telangana'
      ? 'out'
      : (IN_DISTRICTS.some((x) => d.includes(x)) ? 'in' : 'unsure');
    const out = {
      ok: true, pin, found: true, district, state, zone,
      areas: [...new Set(offices.map((o) => String(o.Name || '').trim()).filter(Boolean))],
    };
    cache.set(pin, out);
    res.status(200).json(out);
  } catch (e) {
    // Outage/timeout: fail open so checkout is never held up by this.
    res.status(200).json({ ok: false, pin, error: 'lookup unavailable' });
  }
};

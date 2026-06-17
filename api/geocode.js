// ═══════════════════════════════════════════════════════════════
//  GET /api/geocode
//  Server-side proxy for OpenStreetMap Nominatim (address search +
//  reverse geocoding). The browser calls THIS (same-origin), so it
//  works even on networks that block nominatim.openstreetmap.org
//  directly, and we send the User-Agent Nominatim's policy requires.
//
//    /api/geocode?q=Banjara Hills        → search  (returns array)
//    /api/geocode?lat=17.41&lon=78.44    → reverse (returns object)
// ═══════════════════════════════════════════════════════════════

const UA = 'AngadiMeat/1.0 (https://www.angadi.farm; orders@angadi.farm)';
// Hyderabad bounding box (lon/lat) to bias + bound search results.
const VIEWBOX = '78.05,17.75,78.85,17.10';

module.exports = async (req, res) => {
  let params;
  try { params = new URL(req.url, 'http://x').searchParams; }
  catch { res.status(400).json({ error: 'bad request' }); return; }

  const q = (params.get('q') || '').trim();
  const lat = params.get('lat');
  const lon = params.get('lon');

  let url;
  if (q) {
    url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6'
        + '&countrycodes=in&viewbox=' + VIEWBOX + '&bounded=1'
        + '&q=' + encodeURIComponent(q);
  } else if (lat && lon) {
    url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1'
        + '&lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lon);
  } else {
    res.status(400).json({ error: 'Provide q (search) or lat & lon (reverse)' });
    return;
  }

  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (!r.ok) { res.status(502).json({ error: 'geocoder error', status: r.status }); return; }
    const data = await r.json();
    // Cache at the edge for 5 min to stay well within Nominatim's usage policy.
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
    res.status(200).json(data);
  } catch (e) {
    console.error('geocode proxy error', e);
    res.status(502).json({ error: 'geocoder unreachable' });
  }
};

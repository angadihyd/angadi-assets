// Angadi — GA4 funnel analytics (view_item → add_to_cart → begin_checkout → purchase).
// Paste the GA4 Measurement ID below (Google Analytics → Admin → Data streams → Web).
// Until an ID is set, gaTrack is a silent no-op and nothing loads.
(function () {
  var GA4_ID = 'G-PP33FGYE45';

  if (!GA4_ID) {
    window.gaTrack = function () {};
    return;
  }

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA4_ID;
  document.head.appendChild(s);

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', GA4_ID);

  window.gaTrack = function (name, params) {
    try { gtag('event', name, params || {}); } catch (e) { /* never break the shop */ }
  };
})();

// Map the localStorage cart shape ({name, price, qty}) to GA4 ecommerce items.
window.gaItems = function (items) {
  return (items || []).map(function (i) {
    return { item_name: i.name, price: i.price, quantity: i.qty || 1 };
  });
};

// ── In-house visit log, shown in admin/analytics.html (in addition to GA4) ──
// visitorId is a random id kept in localStorage — just enough to tell repeat
// browsers apart from new ones, never tied to a real identity.
(function trackVisit() {
  try {
    var id = localStorage.getItem('angadi_visitor_id');
    if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('angadi_visitor_id', id); }
    // ?src= tag from a tracked link (built in admin/analytics.html, e.g.
    // angadi.farm/?src=insta-bio). Remembered so later pages keep the label.
    var q = new URLSearchParams(location.search);
    var tag = (q.get('src') || q.get('utm_source') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
    if (tag) localStorage.setItem('angadi_src', tag);
    var payload = JSON.stringify({ type: 'visit', path: location.pathname, visitorId: id, referrer: document.referrer, source: localStorage.getItem('angadi_src') || '' });
    if (navigator.sendBeacon) navigator.sendBeacon('/api/subscribe', new Blob([payload], { type: 'application/json' }));
    else fetch('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(function () {});
  } catch (e) { /* never break the shop */ }
})();

// Checkout calls this when the customer taps Continue on the address step
// (the form tells them we may WhatsApp if they don't finish), so admins can
// follow up with people who leave before paying — see admin/analytics.html.
window.angadiLead = function (lead) {
  try {
    var payload = JSON.stringify(Object.assign({ type: 'lead', visitorId: localStorage.getItem('angadi_visitor_id') || '', source: localStorage.getItem('angadi_src') || '' }, lead));
    fetch('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(function () {});
  } catch (e) { /* never break checkout */ }
};

// Angadi — GA4 funnel analytics (view_item → add_to_cart → begin_checkout → purchase).
// Paste the GA4 Measurement ID below (Google Analytics → Admin → Data streams → Web).
// Until an ID is set, gaTrack is a silent no-op and nothing loads.
(function () {
  var GA4_ID = ''; // e.g. 'G-XXXXXXXXXX'

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

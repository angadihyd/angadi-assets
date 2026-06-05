/* ───────────────────────────────────────────────
   ANGADI — Shared mobile bottom navigation
   App-like tab bar for phones (≤720px). Include with:
   <script src="mobile-nav.js" defer></script>
   (customer-facing pages only — not admin)
─────────────────────────────────────────────── */
(function () {
  if (window.__angadiMobileNav) return;
  window.__angadiMobileNav = true;

  var page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();

  var TABS = [
    { id: 'index.html',      label: 'Home',    icon: '🏡', match: ['', 'index.html'] },
    { id: 'shop.html',       label: 'Shop',    icon: '🛍️', match: ['shop.html', 'product-detail.html'] },
    { id: 'cart.html',       label: 'Cart',    icon: '🛒', match: ['cart.html', 'checkout.html'], badge: true },
    { id: 'my-orders.html',  label: 'Orders',  icon: '📦', match: ['my-orders.html', 'order-confirm.html'] },
    { id: 'my-profile.html', label: 'Account', icon: '👤', match: ['my-profile.html', 'login.html'] },
  ];

  function cartCount() {
    try {
      var c = JSON.parse(localStorage.getItem('angadi_cart') || '[]');
      return c.reduce(function (s, i) { return s + (i.qty || 0); }, 0);
    } catch (e) { return 0; }
  }

  // ── styles ──
  var css = document.createElement('style');
  css.textContent = [
    '@media (max-width:720px){',
    '  body{padding-bottom:calc(64px + env(safe-area-inset-bottom,0px)) !important;}',
    '  .ang-mnav{position:fixed;left:0;right:0;bottom:0;z-index:1200;display:flex;',
    '    background:rgba(16,8,4,0.92);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);',
    '    border-top:1px solid rgba(196,98,45,0.28);',
    '    padding-bottom:env(safe-area-inset-bottom,0px);box-shadow:0 -6px 24px rgba(0,0,0,0.35);}',
    '  .ang-mtab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;',
    '    min-height:60px;text-decoration:none;color:rgba(246,237,216,0.5);font-family:inherit;',
    '    font-size:0.62rem;font-weight:600;letter-spacing:0.02em;position:relative;-webkit-tap-highlight-color:transparent;',
    '    transition:color .2s;}',
    '  .ang-mtab .ang-mi{font-size:1.25rem;line-height:1;transition:transform .2s;}',
    '  .ang-mtab.active{color:#E8956A;}',
    '  .ang-mtab.active .ang-mi{transform:translateY(-1px) scale(1.08);}',
    '  .ang-mtab.active::before{content:"";position:absolute;top:0;width:26px;height:3px;border-radius:0 0 3px 3px;background:#C4622D;}',
    '  .ang-mbadge{position:absolute;top:6px;right:calc(50% - 22px);min-width:16px;height:16px;padding:0 4px;',
    '    border-radius:9px;background:#C4622D;color:#fff;font-size:0.6rem;font-weight:700;display:flex;',
    '    align-items:center;justify-content:center;line-height:1;}',
    '  .ang-mbadge.hidden{display:none;}',
    '}',
    '@media (min-width:721px){ .ang-mnav{display:none;} }'
  ].join('');
  document.head.appendChild(css);

  // ── markup ──
  var nav = document.createElement('nav');
  nav.className = 'ang-mnav';
  nav.setAttribute('aria-label', 'Primary');
  nav.innerHTML = TABS.map(function (t) {
    var active = t.match.indexOf(page) !== -1;
    var badge = t.badge ? '<span class="ang-mbadge hidden" id="angCartBadge">0</span>' : '';
    return '<a class="ang-mtab' + (active ? ' active' : '') + '" href="' + t.id + '">' +
             '<span class="ang-mi">' + t.icon + '</span>' + badge +
             '<span>' + t.label + '</span>' +
           '</a>';
  }).join('');

  function mount() {
    if (!document.body) return;
    document.body.appendChild(nav);
    refreshBadge();
  }

  function refreshBadge() {
    var b = document.getElementById('angCartBadge');
    if (!b) return;
    var n = cartCount();
    b.textContent = n;
    b.classList.toggle('hidden', n === 0);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  // keep cart badge live
  window.addEventListener('storage', function (e) { if (e.key === 'angadi_cart') refreshBadge(); });
  window.addEventListener('focus', refreshBadge);
  window.addEventListener('pageshow', refreshBadge);
  setInterval(refreshBadge, 1500);
})();

/* ───────────────────────────────────────────────
   ANGADI — Shared mobile bottom nav + premium brand header
   Include with: <script src="mobile-nav.js" defer></script>
   (customer-facing pages only — not admin)
─────────────────────────────────────────────── */
(function () {
  if (window.__angadiMobileNav) return;
  window.__angadiMobileNav = true;

  var page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  // depth-correct path to the logo (customer pages are at site root)
  var LOGO = 'angadi/Andadi logo .png';

  var TABS = [
    { id: 'index.html',      label: 'Home',    icon: '🏡', match: ['', 'index.html'] },
    { id: 'shop.html',       label: 'Shop',    icon: '🥩', match: ['shop.html', 'product-detail.html'] },
    { id: 'cart.html',       label: 'Cart',    icon: '🛒', match: ['cart.html', 'checkout.html'], badge: true },
    { id: 'my-orders.html',  label: 'Orders',  icon: '🧾', match: ['my-orders.html', 'order-confirm.html'] },
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
    /* ===== Premium brand lockup (all viewports) ===== */
    '.angadi-brand{display:flex;align-items:center;gap:0.6rem;text-decoration:none;}',
    '.angadi-brand-mark{width:40px;height:40px;border-radius:50%;overflow:hidden;flex-shrink:0;',
    '  background:#F6EDD8;border:1.5px solid rgba(212,160,23,0.55);',
    '  box-shadow:0 2px 12px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(122,51,24,0.15);}',
    '.angadi-brand-mark img{width:100%;height:100%;object-fit:cover;object-position:50% 33%;display:block;}',
    '.angadi-brand-text{display:flex;flex-direction:column;line-height:1;}',
    '.angadi-brand-name{font-family:"Bebas Neue",sans-serif;font-size:1.4rem;letter-spacing:0.13em;color:#F6EDD8;}',
    '.angadi-brand-tag{font-family:"Space Mono",monospace;font-size:0.5rem;letter-spacing:0.22em;',
    '  text-transform:uppercase;color:#D4A017;margin-top:2px;}',
    /* inside the big fullscreen mobile menu, scale up */
    '.mobile-menu .angadi-brand-mark{width:54px;height:54px;}',
    '.mobile-menu .angadi-brand-name{font-size:2rem;}',

    /* ===== Mobile refinements ===== */
    '@media (max-width:720px){',
    '  nav{padding-left:1rem !important;padding-right:1rem !important;}',
    '  nav .angadi-brand-mark{width:36px;height:36px;}',
    '  nav .angadi-brand-name{font-size:1.25rem;white-space:nowrap;}',
    '  .angadi-brand-tag{display:none;}',            /* hide tagline on phones — keeps header clean */
    '  #navLoginBtn{max-width:34vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '  body{padding-bottom:calc(64px + env(safe-area-inset-bottom,0px)) !important;}',
    '  .ang-mnav{position:fixed !important;left:0 !important;right:0 !important;bottom:0 !important;top:auto !important;height:auto !important;z-index:1200;display:flex;',
    '    background:rgba(16,8,4,0.94);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);',
    '    border-top:1px solid rgba(212,160,23,0.22);',
    '    padding-bottom:env(safe-area-inset-bottom,0px);box-shadow:0 -6px 24px rgba(0,0,0,0.4);}',
    '  .ang-mtab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;',
    '    min-height:60px;text-decoration:none;color:rgba(246,237,216,0.5);font-family:inherit;',
    '    font-size:0.62rem;font-weight:600;letter-spacing:0.02em;position:relative;-webkit-tap-highlight-color:transparent;transition:color .2s;}',
    '  .ang-mtab .ang-mi{font-size:1.25rem;line-height:1;transition:transform .2s;}',
    '  .ang-mtab.active{color:#E8956A;}',
    '  .ang-mtab.active .ang-mi{transform:translateY(-1px) scale(1.08);}',
    '  .ang-mtab.active::before{content:"";position:absolute;top:0;width:26px;height:3px;border-radius:0 0 3px 3px;background:linear-gradient(90deg,#C4622D,#D4A017);}',
    '  .ang-mbadge{position:absolute;top:6px;right:calc(50% - 22px);min-width:16px;height:16px;padding:0 4px;',
    '    border-radius:9px;background:#C4622D;color:#fff;font-size:0.6rem;font-weight:700;display:flex;align-items:center;justify-content:center;line-height:1;}',
    '  .ang-mbadge.hidden{display:none;}',
    '  /* hide tagline on the smallest screens to keep header tidy */',
    '}',
    '@media (max-width:380px){ .angadi-brand-tag{display:none;} }',
    '@media (min-width:721px){ .ang-mnav{display:none;} }'
  ].join('');
  document.head.appendChild(css);

  // ── upgrade every .nav-logo into the premium brand lockup ──
  function upgradeBrand() {
    document.querySelectorAll('.nav-logo').forEach(function (el) {
      if (el.dataset.angadiBranded) return;
      el.dataset.angadiBranded = '1';
      el.classList.add('angadi-brand');
      el.innerHTML =
        '<span class="angadi-brand-mark"><img src="' + LOGO + '" alt="Angadi"></span>' +
        '<span class="angadi-brand-text">' +
          '<span class="angadi-brand-name">ANGADI</span>' +
          '<span class="angadi-brand-tag">Healthy · Hygienic · Handpicked</span>' +
        '</span>';
    });
  }

  // ── bottom tab bar (a DIV, not <nav>, so the site's global nav{} styles can't hijack it) ──
  var nav = document.createElement('div');
  nav.className = 'ang-mnav';
  nav.setAttribute('role', 'navigation');
  nav.setAttribute('aria-label', 'Primary');
  nav.innerHTML = TABS.map(function (t) {
    var active = t.match.indexOf(page) !== -1;
    var badge = t.badge ? '<span class="ang-mbadge hidden" id="angCartBadge">0</span>' : '';
    return '<a class="ang-mtab' + (active ? ' active' : '') + '" href="' + t.id + '">' +
             '<span class="ang-mi">' + t.icon + '</span>' + badge +
             '<span>' + t.label + '</span>' +
           '</a>';
  }).join('');

  function refreshBadge() {
    var b = document.getElementById('angCartBadge');
    if (!b) return;
    var n = cartCount();
    b.textContent = n;
    b.classList.toggle('hidden', n === 0);
  }

  function mount() {
    if (!document.body) return;
    upgradeBrand();
    document.body.appendChild(nav);
    refreshBadge();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  window.addEventListener('storage', function (e) { if (e.key === 'angadi_cart') refreshBadge(); });
  window.addEventListener('focus', refreshBadge);
  window.addEventListener('pageshow', refreshBadge);
  setInterval(refreshBadge, 1500);
})();

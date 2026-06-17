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
    '.angadi-brand-tag.loc{display:block !important;color:#E8956A;letter-spacing:0.04em;text-transform:none;font-family:inherit;font-size:0.66rem;max-width:48vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    /* ── Login button — matches the header's dark-glass style, not a CTA ── */
    '#navLoginBtn{background:rgba(255,255,255,0.06) !important;color:#F6EDD8 !important;border:1px solid rgba(246,237,216,0.18) !important;border-radius:10px !important;padding:0.42rem 0.9rem !important;font-size:0.8rem !important;font-weight:600 !important;letter-spacing:0.02em !important;text-decoration:none !important;display:inline-flex !important;align-items:center !important;gap:0.35rem !important;backdrop-filter:blur(4px) !important;transition:all 0.2s !important;white-space:nowrap !important;box-shadow:none !important;}',
    '#navLoginBtn:hover{background:rgba(196,98,45,0.18) !important;border-color:rgba(196,98,45,0.5) !important;}',
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
    '@media (min-width:721px){ .ang-mnav{display:none;} }',
    /* ── Hamburger always visible on mobile, Login text hidden (bottom nav handles it) ── */
    '@media (max-width:720px){',
    '  .nav-hamburger{display:flex !important;flex-shrink:0 !important;visibility:visible !important;opacity:1 !important;}',
    '  #navLoginBtn:not([data-loggedin]){display:none !important;}',  /* hide Login text on mobile — Account tab covers it */
    '}'
  ].join('');
  document.head.appendChild(css);

  // ── upgrade every .nav-logo into the premium brand lockup ──
  function upgradeLoginBtn() {
    var btn = document.getElementById('navLoginBtn');
    if (!btn || btn.dataset.upgraded) return;
    if (btn.textContent.trim() === 'Login') {
      btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg> Login';
    }
    btn.dataset.upgraded = '1';
  }

  function upgradeBrand() {
    upgradeLoginBtn();
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

      // The TOP header logo opens the slide-out menu on touch (people instinctively
      // tap the logo). Footer logo and desktop keep the normal "go home" behaviour.
      if (el.closest('nav')) {
        el.style.cursor = 'pointer';
        el.addEventListener('click', function (e) {
          var menu = document.getElementById('mobileMenu');
          var hamburger = document.getElementById('menuToggle') || document.querySelector('.nav-hamburger');
          // Only hijack when we're in mobile layout (hamburger visible) and a menu exists.
          var mobileLayout = hamburger && hamburger.offsetParent !== null;
          if (menu && mobileLayout) {
            e.preventDefault();
            if (window.angadiBounce) window.angadiBounce(el.querySelector('.angadi-brand-mark') || el);
            menu.classList.add('open');
          }
          // otherwise: let the <a href="/"> navigate home as usual
        });
      }
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

  // ── show the customer's current location under the ANGADI wordmark ──
  function setLoc(text) {
    if (!text) return;
    document.querySelectorAll('.angadi-brand-tag').forEach(function (el) {
      el.textContent = '📍 ' + text;
      el.classList.add('loc');
    });
  }
  function showLocation() {
    var saved = null;
    try { saved = localStorage.getItem('angadi_location'); } catch (e) {}
    if (saved) setLoc(saved);
    if (!('geolocation' in navigator)) return;

    function onPos(p) {
      fetch('/api/geocode?lat=' + p.coords.latitude + '&lon=' + p.coords.longitude)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var a = d.address || {};
          var area = [a.neighbourhood, a.suburb, a.quarter, a.road, a.village].filter(Boolean)[0] || a.city_district || a.county || '';
          var city = a.city || a.town || a.county || '';
          var label = area ? (area + (city ? ', ' + city : '')) : (city || '');
          if (label) { try { localStorage.setItem('angadi_location', label); } catch (e) {} setLoc(label); }
        }).catch(function () {});
    }
    function detect() { navigator.geolocation.getCurrentPosition(onPos, function () {}, { timeout: 8000, maximumAge: 600000 }); }
    function askedBefore() { try { return localStorage.getItem('angadi_loc_asked') === '1'; } catch (e) { return false; } }
    function markAsked() { try { localStorage.setItem('angadi_loc_asked', '1'); } catch (e) {} }

    // Granted → detect silently (no prompt). Prompt state → ask only once, ever. Denied → never.
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'geolocation' }).then(function (st) {
        if (st.state === 'granted') detect();
        else if (st.state === 'prompt' && !askedBefore()) { markAsked(); detect(); }
      }).catch(function () { if (!askedBefore()) { markAsked(); detect(); } });
    } else if (!askedBefore()) { markAsked(); detect(); }
  }

  // ── TELUGU TOGGLE (EN ⇄ తెలుగు) ──
  var I18N = {
    'Village Goat Meat':'గ్రామ మేక మాంసం','Country Chicken':'నాటు కోడి','Fresh River Fish':'తాజా నది చేప',
    'Country Eggs':'నాటు కోడి గుడ్లు','Goat Liver':'మేక కాలేయం','Goat Legs':'మేక కాళ్లు','Goat Head':'మేక తల',
    'Baby Goat Legs':'పిల్ల మేక కాళ్లు','Full Goat':'పూర్తి మేక',
    'All Products':'అన్ని ఉత్పత్తులు','Proceed to Checkout':'చెక్‌అవుట్‌కు వెళ్లండి','Continue to Payment':'చెల్లింపుకు కొనసాగండి',
    'Order via WhatsApp':'వాట్సాప్ ద్వారా ఆర్డర్','Add to Cart':'కార్ట్‌లో చేర్చు','View All Products':'అన్ని ఉత్పత్తులు చూడండి',
    'Shop Now':'ఇప్పుడే కొనండి','WhatsApp Order':'వాట్సాప్ ఆర్డర్','Submit review':'సమీక్ష ఇవ్వండి','Rate this product':'ఈ ఉత్పత్తిని రేట్ చేయండి',
    'Order again':'మళ్లీ ఆర్డర్','Add to cart':'కార్ట్‌లో చేర్చు','Use my location':'నా లొకేషన్ వాడండి','Place Order':'ఆర్డర్ చేయండి',
    'Delivery Address':'డెలివరీ చిరునామా','Full Name':'పూర్తి పేరు','Phone Number':'ఫోన్ నంబర్','Landmark':'ల్యాండ్‌మార్క్',
    'Cash on Delivery':'డెలివరీ సమయంలో నగదు','Pay Online':'ఆన్‌లైన్ చెల్లింపు','Subtotal':'ఉప మొత్తం','Total':'మొత్తం',
    'Delivery':'డెలివరీ','Discount':'తగ్గింపు','Quantity':'పరిమాణం','Promo code':'ప్రోమో కోడ్','Apply':'వర్తించు',
    'Reviews':'సమీక్షలు','What customers':'కస్టమర్లు ఏమి','Why Angadi':'ఎందుకు అంగడి','Our Handpicked Selection':'మా ఎంపిక',
    'per kilogram':'కిలోకు','per egg':'గుడ్డుకు','SOLD OUT':'అయిపోయింది','Home':'హోమ్','Shop':'షాప్','Cart':'కార్ట్',
    'Orders':'ఆర్డర్లు','Account':'ఖాతా','Login':'లాగిన్','My Orders':'నా ఆర్డర్లు','My Profile':'నా ప్రొఫైల్',
    'Goat':'మేక','Chicken':'కోడి','Fish':'చేప','Eggs':'గుడ్లు','Free':'ఉచితం','Delivered':'డెలివరీ అయింది'
  };
  var I18N_KEYS = Object.keys(I18N).sort(function (a, b) { return b.length - a.length; });
  var origText = new WeakMap();
  function translateStr(s) { var out = s; for (var i = 0; i < I18N_KEYS.length; i++) { var k = I18N_KEYS[i]; if (out.indexOf(k) !== -1) out = out.split(k).join(I18N[k]); } return out; }
  function walkLang(root, toTE) {
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null), n;
    while ((n = w.nextNode())) {
      var p = n.parentNode; if (!p) continue;
      var t = p.nodeName; if (t === 'SCRIPT' || t === 'STYLE' || t === 'TEXTAREA') continue;
      if (p.closest && p.closest('.ang-lang')) continue;
      var orig = origText.has(n) ? origText.get(n) : n.nodeValue;
      if (toTE) { if (!origText.has(n)) origText.set(n, orig); var tr = translateStr(orig); if (tr !== n.nodeValue) n.nodeValue = tr; }
      else { if (origText.has(n)) n.nodeValue = orig; }
    }
  }
  var langObserver = null;
  function applyLang(lang) {
    var toTE = lang === 'te';
    walkLang(document.body, toTE);
    var lbl = document.getElementById('angLangLbl'); if (lbl) lbl.textContent = toTE ? 'English' : 'తెలుగు';
    try { localStorage.setItem('angadi_lang', lang); } catch (e) {}
    if (toTE && !langObserver) {
      langObserver = new MutationObserver(function (muts) {
        muts.forEach(function (m) { m.addedNodes && m.addedNodes.forEach(function (node) { if (node.nodeType === 1) walkLang(node, true); else if (node.nodeType === 3 && node.parentNode) walkLang(node.parentNode, true); }); });
      });
      langObserver.observe(document.body, { childList: true, subtree: true });
    } else if (!toTE && langObserver) { langObserver.disconnect(); langObserver = null; }
  }
  function setupLang() {
    var cur = 'en'; try { cur = localStorage.getItem('angadi_lang') || 'en'; } catch (e) {}
    var b = document.createElement('button');
    b.className = 'ang-lang';
    b.innerHTML = '🌐 <span id="angLangLbl">' + (cur === 'te' ? 'English' : 'తెలుగు') + '</span>';
    b.style.cssText = 'position:fixed;right:1rem;top:74px;z-index:99999;background:rgba(16,8,4,0.92);color:#F6EDD8;border:1px solid rgba(212,160,23,0.4);border-radius:100px;padding:0.4rem 0.8rem;font-size:0.74rem;font-weight:700;cursor:pointer;font-family:inherit;backdrop-filter:blur(8px);box-shadow:0 4px 14px rgba(0,0,0,0.4);';
    b.onclick = function () { var next = (localStorage.getItem('angadi_lang') === 'te') ? 'en' : 'te'; applyLang(next); };
    document.body.appendChild(b);
    if (cur === 'te') setTimeout(function () { applyLang('te'); }, 150);
  }

  function mount() {
    if (!document.body) return;
    upgradeBrand();
    document.body.appendChild(nav);
    refreshBadge();
    showLocation();
    setupLang();
    setupInstall();
  }

  // ── PWA INSTALL ("Add to Home Screen" → app on Android & iPhone) ──
  function setupInstall() {
    // Already running as an installed app? Nothing to do.
    var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
    if (standalone) return;
    try { if (localStorage.getItem('angadi_install_dismissed') === '1') return; } catch (e) {}

    var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    var isSafari = /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(navigator.userAgent);
    var deferred = null;

    var st = document.createElement('style');
    st.textContent = [
      '.angadi-install{position:fixed;left:50%;transform:translateX(-50%);',
      '  bottom:calc(74px + env(safe-area-inset-bottom,0px));z-index:1300;',
      '  background:linear-gradient(135deg,#C4622D,#7A3318);color:#F6EDD8;',
      '  border:1px solid rgba(212,160,23,0.5);border-radius:100px;padding:0.6rem 1.15rem;',
      '  font-family:"DM Sans",sans-serif;font-size:0.82rem;font-weight:700;letter-spacing:0.01em;',
      '  box-shadow:0 6px 24px rgba(0,0,0,0.45);display:none;align-items:center;gap:0.5rem;cursor:pointer;}',
      '.angadi-install.show{display:inline-flex;animation:angInstallIn .4s ease;}',
      '.angadi-install .x{margin-left:0.45rem;opacity:0.65;font-weight:400;font-size:0.95rem;}',
      '@media(min-width:721px){.angadi-install{bottom:24px;}}',
      '@keyframes angInstallIn{from{opacity:0;transform:translateX(-50%) translateY(14px);}to{opacity:1;transform:translateX(-50%) translateY(0);}}',
    ].join('');
    document.head.appendChild(st);

    var btn = document.createElement('button');
    btn.className = 'angadi-install';
    btn.type = 'button';
    function show(label) { btn.innerHTML = label + ' <span class="x" aria-label="dismiss">✕</span>'; btn.classList.add('show'); }
    btn.addEventListener('click', function (e) {
      if (e.target && e.target.classList.contains('x')) {
        btn.classList.remove('show');
        try { localStorage.setItem('angadi_install_dismissed', '1'); } catch (er) {}
        return;
      }
      if (deferred) {
        deferred.prompt();
        deferred.userChoice.then(function () { btn.classList.remove('show'); deferred = null; });
      } else if (isIOS) {
        alert('To install the Angadi app:\n\n1. Tap the Share button  (the box with an ↑ arrow) at the bottom of Safari\n2. Scroll down and tap "Add to Home Screen"');
      }
    });
    document.body.appendChild(btn);

    // Android / Chrome: capture the native install prompt.
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; show('📲 Install App'); });
    // iOS Safari has no beforeinstallprompt — show the hint button directly.
    if (isIOS && isSafari) show('📲 Install App');
    // Hide once installed.
    window.addEventListener('appinstalled', function () { btn.classList.remove('show'); });
  }

  // ── HAPTIC FEEDBACK (iOS-compatible) ──
  // Android: real vibration. iOS: short tick sound (AudioContext) + scale-bounce.
  window.angadiBounce = function (el) {
    // Scale-bounce animation on the button
    if (el && el.style) {
      el.style.transition = 'transform 0.12s cubic-bezier(.36,.07,.19,.97)';
      el.style.transform = 'scale(0.88)';
      setTimeout(function () { el.style.transform = 'scale(1.08)'; }, 80);
      setTimeout(function () { el.style.transform = 'scale(1)'; el.style.transition = ''; }, 180);
    }
    // Android vibration
    try { if (navigator.vibrate) { navigator.vibrate([30, 15, 30]); return; } } catch (e) {}
    // iOS: very short tick via AudioContext (sounds like a system tap)
    try {
      var ac = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ac.createOscillator();
      var gain = ac.createGain();
      osc.connect(gain); gain.connect(ac.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1200, ac.currentTime);
      osc.frequency.exponentialRampToValueAtTime(600, ac.currentTime + 0.04);
      gain.gain.setValueAtTime(0.08, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.045);
      osc.start(ac.currentTime);
      osc.stop(ac.currentTime + 0.05);
      setTimeout(function () { ac.close(); }, 200);
    } catch (e) {}
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  window.addEventListener('storage', function (e) { if (e.key === 'angadi_cart') refreshBadge(); });
  window.addEventListener('focus', refreshBadge);
  window.addEventListener('pageshow', refreshBadge);
  setInterval(refreshBadge, 1500);
})();

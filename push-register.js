/* Angadi Web Push registration + a floating "Enable alerts" button.
   A page opts in by setting, BEFORE this script:
     window.ANGADI_PUSH_ROLE = 'admin';            // admin pages
     window.ANGADI_PUSH_ROLE = 'partner';          // partner page
     window.ANGADI_PUSH_CODE = 'db1';              // partner code (partner only)
*/
(function () {
  var VAPID_PUBLIC = 'BPiQcgEVyRxp96djwa3O-eX7XSOvp5lN4PTpP9V1QN2EKBZ9kOINNdK-bppKo4qGOgYrzO3HPaasuBdWjMTVTuQ';
  var ROLE = window.ANGADI_PUSH_ROLE || 'admin';
  var CODE = window.ANGADI_PUSH_CODE || null;

  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;

  function urlB64ToUint8(s) {
    var pad = '='.repeat((4 - s.length % 4) % 4);
    var b = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(b); var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function enable() {
    try {
      var reg = await navigator.serviceWorker.register('/sw.js');
      var perm = Notification.permission;
      if (perm === 'default') perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('Notifications blocked. Allow them in browser settings.'); return false; }
      var sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(VAPID_PUBLIC) });
      var r = await fetch('/api/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), role: ROLE, code: CODE })
      });
      if (r.ok) { localStorage.setItem('angadi_push_on', '1'); hideBtn(); toast('🔔 Alerts enabled on this device'); return true; }
      toast('Could not save subscription'); return false;
    } catch (e) { console.warn('push enable failed', e); toast('Could not enable alerts'); return false; }
  }

  function toast(m) {
    var t = document.createElement('div');
    t.textContent = m;
    t.style.cssText = 'position:fixed;bottom:5.2rem;left:50%;transform:translateX(-50%);background:#C4622D;color:#F6EDD8;padding:0.6rem 1.2rem;border-radius:100px;font-size:0.82rem;font-weight:600;z-index:100000;white-space:nowrap;box-shadow:0 6px 20px rgba(0,0,0,0.4);';
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2800);
  }

  var btn;
  function showBtn() {
    if (btn) return;
    btn = document.createElement('button');
    btn.innerHTML = '🔔 Enable alerts';
    btn.style.cssText = 'position:fixed;right:1rem;bottom:5.2rem;z-index:100000;background:linear-gradient(135deg,#C4622D,#7A3318);color:#F6EDD8;border:1px solid rgba(246,237,216,0.25);border-radius:100px;padding:0.65rem 1.1rem;font-size:0.82rem;font-weight:700;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,0.45);font-family:inherit;';
    btn.onclick = enable;
    document.body.appendChild(btn);
  }
  function hideBtn() { if (btn) { btn.remove(); btn = null; } }

  async function init() {
    // already enabled on this device?
    try {
      var reg = await navigator.serviceWorker.getRegistration();
      var sub = reg && await reg.pushManager.getSubscription();
      if (sub && Notification.permission === 'granted') { return; } // good, silent
    } catch (e) {}
    showBtn(); // prompt the user to enable (needs a tap — required by browsers/iOS)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  window.AngadiPush = { enable: enable };
})();

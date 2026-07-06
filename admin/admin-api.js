/* ───────────────────────────────────────────────
   ANGADI — Admin/Partner API client
   All admin pages talk to /api/admin (service-role backed,
   token-guarded) instead of hitting Supabase with the anon key.
   Include with: <script src="admin-api.js"></script>
─────────────────────────────────────────────── */
(function () {
  var API = '/api/admin';

  async function post(payload, headers) {
    try {
      var r = await fetch(API, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body: JSON.stringify(payload),
      });
      var j = null;
      try { j = await r.json(); } catch (e) { j = null; }
      if (!r.ok) return { data: null, error: (j && j.error) || ('HTTP ' + r.status), status: r.status, raw: j };
      return Object.assign({ data: null, error: null, status: r.status }, j || {});
    } catch (e) {
      return { data: null, error: 'Network error — ' + (e.message || e), status: 0 };
    }
  }

  window.AdminAPI = {
    // ── admin auth ──
    token: function () { return sessionStorage.getItem('angadi_admin_token') || ''; },
    isAdmin: function () { return !!this.token(); },
    login: async function (password) {
      var r = await post({ action: 'login', password: password });
      if (r.token) {
        sessionStorage.setItem('angadi_admin_token', r.token);
        sessionStorage.setItem('angadi_admin', '1'); // legacy guard flag (UX only)
      }
      return r;
    },
    logout: function () {
      sessionStorage.removeItem('angadi_admin_token');
      sessionStorage.removeItem('angadi_admin');
    },

    // ── admin data (mirrors the {data, error} shape of supabase-js) ──
    call: async function (action, payload) {
      var r = await post(Object.assign({ action: action }, payload || {}), { 'x-admin-token': this.token() });
      if (r.status === 401) { this.logout(); }
      return r;
    },
    db: function (table, op, opts) {
      return this.call('db', Object.assign({ table: table, op: op }, opts || {}));
    },

    // ── delivery partner ──
    ptoken: function () { return sessionStorage.getItem('angadi_partner_token') || ''; },
    partnerLogin: async function (username, password) {
      var r = await post({ action: 'partner-login', username: username, password: password });
      if (r.token) {
        sessionStorage.setItem('angadi_partner_token', r.token);
        sessionStorage.setItem('angadi_delivery', username);
        sessionStorage.setItem('angadi_partner_code', r.code || username);
        sessionStorage.setItem('angadi_partner_name', r.name || username);
      }
      return r;
    },
    partnerLogout: function () {
      ['angadi_partner_token', 'angadi_delivery', 'angadi_partner_code', 'angadi_partner_name']
        .forEach(function (k) { sessionStorage.removeItem(k); });
    },
    partner: async function (action, payload) {
      var r = await post(Object.assign({ action: action }, payload || {}), { 'x-partner-token': this.ptoken() });
      if (r.status === 401) { this.partnerLogout(); }
      return r;
    },
  };
})();

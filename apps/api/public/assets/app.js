/* =====================================================================
   Volt4Amper — Energy Monitoring Command Center (vanilla SPA)
   Same-origin client for the api.volt4amper.com REST API.
   ===================================================================== */
(() => {
  "use strict";

  // ---------------------------------------------------------------- state
  const SETTINGS_KEY = "v4a.settings";
  const TOKEN_KEY = "apiToken"; // panel session JWT (shared key name w/ legacy pages)
  const USER_KEY = "v4a.user";
  // Bump THEME_REV to force a one-time reset of the saved theme to the current default
  // (so stale "dark" preferences from before the Storm Clay redesign flip to light once).
  const THEME_REV = 2;
  // Settings schema rev: bump to push a new cost-saving default onto existing operators once.
  const SETTINGS_REV = 1;
  // While a switch/refresh command is mid-flight we poll fast so the operator sees the
  // "opened / closed" confirmation promptly; otherwise we stay on the slow idle cadence.
  const FAST_REFRESH_MS = 10000;
  const defaultSettings = { refreshMs: 300000, onlineWindowSec: 360, theme: "light", offlineAlarmMin: 15, themeRev: THEME_REV, settingsRev: SETTINGS_REV, billing: { monthlyCost: 92, marginPct: 30, currency: "USD", costBasis: "manual", usageWindowDays: 7 } };

  function loadUser() {
    try { const u = JSON.parse(localStorage.getItem(USER_KEY) || "null"); return u && u.username ? u : null; }
    catch { return null; }
  }

  const state = {
    settings: loadSettings(),
    token: (localStorage.getItem(TOKEN_KEY) || "").trim(),
    user: loadUser(),
    route: { name: "overview", param: null, query: {} },
    refresher: null,        // async (silent) => void, set by the active view
    activeCmd: null,        // { sn, deadline } — drives the fast polling burst after a command
    lookups: { customers: [], propertyTypes: [], loaded: false },
    lastOverview: null
  };
  // Timestamp of the last auto-refresh tick that actually ran (drives the adaptive cadence).
  let lastRefreshAt = 0;

  function loadSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      const merged = Object.assign({}, defaultSettings, raw);
      merged.billing = Object.assign({}, defaultSettings.billing, raw.billing || {});
      // One-time migration: snap to the new light default if the saved prefs predate it.
      if (merged.themeRev !== THEME_REV) { merged.theme = "light"; merged.themeRev = THEME_REV; }
      // One-time migration to the cost-saving cadence: 5 dk idle yenileme + 6 dk çevrimiçi eşiği.
      // (Komut verilince yine otomatik hızlanır.) Sonradan kullanıcı değiştirirse o tercih korunur.
      if (merged.settingsRev !== SETTINGS_REV) { merged.refreshMs = 300000; merged.onlineWindowSec = 360; merged.settingsRev = SETTINGS_REV; }
      return merged;
    } catch { return Object.assign({}, defaultSettings); }
  }
  function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); }

  // ---------------------------------------------------------------- dom utils
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const view = $("#view");
  let routeAnimTimer = 0;

  const esc = (s) => (s == null ? "" : String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  )));

  // ---------------------------------------------------------------- formatting
  const nfMap = {};
  const nf = (v, digits = 0) => {
    if (v == null || v === "" || Number.isNaN(Number(v))) return "—";
    const k = digits;
    if (!nfMap[k]) nfMap[k] = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 0, maximumFractionDigits: digits });
    return nfMap[k].format(Number(v));
  };
  const unit = (v, u, digits = 1) => (v == null || Number.isNaN(Number(v)) ? "—" : `${nf(v, digits)} ${u}`);

  function timeAgo(iso) {
    if (!iso) return "—";
    const ms = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(ms)) return "—";
    const s = Math.round(ms / 1000);
    if (s < 0) return "şimdi";
    if (s < 60) return `${s} sn önce`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} dk önce`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} sa önce`;
    const d = Math.round(h / 24);
    if (d < 30) return `${d} gün önce`;
    return new Date(iso).toLocaleDateString("tr-TR");
  }
  function fmtDateTime(iso) { return iso ? new Date(iso).toLocaleString("tr-TR") : "—"; }
  function fmtDate(iso) {
    return iso ? new Date(iso).toLocaleDateString("tr-TR", { day: "2-digit", month: "short", year: "numeric" }) : "—";
  }
  function fmtTime(iso) { return iso ? new Date(iso).toLocaleTimeString("tr-TR") : "—"; }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  // ---------------------------------------------------------------- api client
  async function api(method, path, body, opts = {}) {
    const headers = {};
    if (state.token) headers["authorization"] = `Bearer ${state.token}`;
    let payload;
    if (opts.asText) { headers["content-type"] = "text/csv"; payload = body; }
    else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
    let res;
    try {
      res = await fetch(path, { method, headers, body: payload });
    } catch (e) {
      setConn(false, "API erişilemiyor");
      throw new Error("network");
    }
    if (res.status === 401) {
      setConn(false, "oturum süresi doldu");
      clearSession();
      if (!opts.silent401) showLogin("Oturum süreniz doldu. Lütfen tekrar giriş yapın.");
      const err = new Error("unauthorized"); err.status = 401; throw err;
    }
    if (res.status === 403) {
      const err = new Error("forbidden"); err.status = 403; throw err;
    }
    setConn(true);
    markUpdated();
    let json = null;
    try { json = await res.json(); } catch { /* non-json */ }
    if (!res.ok) { const err = new Error((json && json.error) || `HTTP ${res.status}`); err.status = res.status; err.body = json; throw err; }
    return json;
  }

  // ---------------------------------------------------------------- chrome: conn / updated / toasts
  const connChip = $("#connChip"), connText = $("#connText");
  function setConn(ok, msg) {
    connChip.classList.toggle("ok", !!ok);
    connChip.classList.toggle("bad", !ok);
    connText.textContent = msg || (ok ? "bağlı" : "bağlantı yok");
  }
  let lastUpdatedAt = null;
  function markUpdated() { lastUpdatedAt = Date.now(); renderUpdated(); }
  function renderUpdated() { $("#lastUpdated").textContent = lastUpdatedAt ? timeAgo(new Date(lastUpdatedAt).toISOString()) : "—"; }
  setInterval(renderUpdated, 5000);

  function toast(title, msg, type = "info", ttl = 4200) {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.innerHTML = `<div class="t-title">${esc(title)}</div>${msg ? `<div class="t-msg">${esc(msg)}</div>` : ""}`;
    $("#toasts").appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateX(30px)"; setTimeout(() => el.remove(), 240); }, ttl);
  }

  // ---------------------------------------------------------------- theme
  function applyTheme(t) { document.documentElement.setAttribute("data-theme", t); state.settings.theme = t; saveSettings(); }
  $("#themeBtn").addEventListener("click", () => applyTheme(state.settings.theme === "dark" ? "light" : "dark"));
  applyTheme(state.settings.theme);

  // ---------------------------------------------------------------- auth: login / session
  const ROLE_LABELS = { admin: "Yönetici", operator: "Operatör", viewer: "İzleyici" };
  const loginScreen = $("#loginScreen");
  let booted = false;

  function showLogin(message) {
    const err = $("#loginError");
    if (message) { err.textContent = message; err.hidden = false; } else { err.hidden = true; }
    const wasHidden = loginScreen.hidden;
    loginScreen.hidden = false;
    $("#userChip").hidden = true;
    // Stop any background auto-refresh so repeated 401s don't keep re-triggering this
    // (which previously yanked the caret out of the password field while typing).
    state.refresher = null;
    // Only grab focus when the gate first appears, and never steal it from a field
    // the user is already typing into.
    if (wasHidden) setTimeout(() => {
      const active = document.activeElement;
      if (active && loginScreen.contains(active)) return;
      const u = $("#loginUser"); if (u) u.focus();
    }, 40);
  }
  function hideLogin() { loginScreen.hidden = true; }

  function renderUserChip() {
    const chip = $("#userChip");
    const navBilling = $("#navBilling");
    if (navBilling) navBilling.hidden = !(state.user && state.user.role === "admin");
    if (!state.user) { chip.hidden = true; return; }
    chip.hidden = false;
    $("#userAva").textContent = (state.user.username || "?").charAt(0).toUpperCase();
    $("#userName").textContent = state.user.username || "—";
    $("#userRole").textContent = ROLE_LABELS[state.user.role] || state.user.role || "";
  }

  function setSession(token, user) {
    state.token = token;
    state.user = user;
    localStorage.setItem(TOKEN_KEY, token);
    try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch { /* */ }
    renderUserChip();
  }

  function clearSession() {
    state.token = "";
    state.user = null;
    state.refresher = null;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    renderUserChip();
  }

  function isAdmin() { return state.user && state.user.role === "admin"; }
  function canControl() { return state.user && (state.user.role === "admin" || state.user.role === "operator"); }

  async function doLogin(username, password) {
    const res = await fetch("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    let json = null; try { json = await res.json(); } catch { /* */ }
    if (!res.ok) {
      const map = { invalid_credentials: "Kullanıcı adı veya parola hatalı.", missing_credentials: "Kullanıcı adı ve parola gerekli." };
      throw new Error((json && map[json.error]) || "Giriş başarısız.");
    }
    setSession(json.token, json.user);
  }

  function logout() {
    clearSession();
    setConn(false, "oturum kapatıldı");
    showLogin();
  }

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#loginSubmit");
    const u = $("#loginUser").value.trim();
    const p = $("#loginPass").value;
    if (!u || !p) { showLogin("Kullanıcı adı ve parola gerekli."); return; }
    btn.disabled = true; btn.textContent = "Giriş yapılıyor…";
    try {
      await doLogin(u, p);
      $("#loginPass").value = "";
      hideLogin();
      setConn(true);
      toast("Hoş geldiniz", state.user.username, "success", 2500);
      router();
    } catch (err) {
      showLogin(err.message || "Giriş başarısız.");
    } finally {
      btn.disabled = false; btn.textContent = "Giriş yap";
    }
  });

  $("#logoutBtn").addEventListener("click", () => { if (confirm("Oturumu kapatmak istiyor musunuz?")) logout(); });

  // ================================================================ SVG widgets
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  function polar(cx, cy, r, deg) { const a = (deg - 90) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }
  function arcPath(cx, cy, r, startDeg, endDeg) {
    const [x1, y1] = polar(cx, cy, r, startDeg);
    const [x2, y2] = polar(cx, cy, r, endDeg);
    const large = (endDeg - startDeg) % 360 > 180 ? 1 : 0;
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  }

  // 240° radial gauge. zones: [{to:fraction, color}] for the track segments (optional).
  function gauge({ value, min = 0, max = 100, unit: u = "", label = "", digits = 1, color, zones }) {
    const has = value != null && !Number.isNaN(Number(value));
    const f = has ? clamp((Number(value) - min) / (max - min || 1), 0, 1) : 0;
    const START = -120, SWEEP = 240; // degrees, 0 = top
    const cx = 80, cy = 78, r = 60;
    const valDeg = START + f * SWEEP;
    let col = color || "var(--brand)";
    if (zones && has) { for (const z of zones) { if (f <= z.to) { col = z.color; break; } } }
    const track = `<path d="${arcPath(cx, cy, r, START, START + SWEEP)}" fill="none" stroke="var(--panel-3)" stroke-width="12" stroke-linecap="round"/>`;
    const val = has ? `<path d="${arcPath(cx, cy, r, START, valDeg)}" fill="none" stroke="${col}" stroke-width="12" stroke-linecap="round"/>` : "";
    const [hx, hy] = polar(cx, cy, r, valDeg);
    const knob = has ? `<circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="6" fill="${col}" stroke="var(--panel)" stroke-width="2"/>` : "";
    return `<div class="gauge">
      <svg viewBox="0 0 160 118" role="img" aria-label="${esc(label)}">
        ${track}${val}${knob}
        <text x="${cx}" y="74" text-anchor="middle" class="g-val-t" fill="var(--txt)" font-size="26" font-weight="800">${has ? nf(value, digits) : "—"}</text>
        <text x="${cx}" y="96" text-anchor="middle" fill="var(--muted)" font-size="12" font-weight="600">${esc(u)}</text>
      </svg>
      <div class="g-label">${esc(label)}</div>
    </div>`;
  }

  // Multi-series time chart. series:[{name,color,points:[{t(ms),y}],axis:'l'|'r',area,unit}]
  function lineChart(series, { height = 200, xTicks = 4 } = {}) {
    const W = 720, H = height, padL = 44, padR = 44, padT = 14, padB = 24;
    const all = series.flatMap((s) => s.points.filter((p) => p.y != null).map((p) => p.t));
    if (all.length === 0) return `<div class="empty">Bu aralıkta veri yok.</div>`;
    const tMin = Math.min(...all), tMax = Math.max(...all);
    const tSpan = tMax - tMin || 1;
    const axes = { l: series.filter((s) => (s.axis || "l") === "l"), r: series.filter((s) => s.axis === "r") };
    const range = (arr) => {
      const ys = arr.flatMap((s) => s.points.filter((p) => p.y != null).map((p) => p.y));
      if (!ys.length) return null;
      let lo = Math.min(...ys), hi = Math.max(...ys);
      if (lo === hi) { lo -= 1; hi += 1; }
      const pad = (hi - lo) * 0.12; return [lo - pad, hi + pad];
    };
    const rl = range(axes.l), rr = range(axes.r);
    const x = (t) => padL + ((t - tMin) / tSpan) * (W - padL - padR);
    const yOf = (val, rng) => { const [lo, hi] = rng; return H - padB - ((val - lo) / (hi - lo)) * (H - padT - padB); };

    let grid = "", yl = "";
    if (rl) {
      for (let i = 0; i <= 4; i++) {
        const v = rl[0] + (i / 4) * (rl[1] - rl[0]);
        const yy = yOf(v, rl);
        grid += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="var(--line)" stroke-width="1" opacity="0.6"/>`;
        yl += `<text x="${padL - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end" fill="var(--muted)" font-size="10">${nf(v, Math.abs(rl[1]) < 5 ? 1 : 0)}</text>`;
      }
    }
    let yr = "";
    if (rr) for (let i = 0; i <= 4; i++) { const v = rr[0] + (i / 4) * (rr[1] - rr[0]); const yy = yOf(v, rr); yr += `<text x="${W - padR + 6}" y="${(yy + 3).toFixed(1)}" text-anchor="start" fill="var(--muted)" font-size="10">${nf(v, Math.abs(rr[1]) < 5 ? 1 : 0)}</text>`; }

    let xl = "";
    for (let i = 0; i <= xTicks; i++) {
      const t = tMin + (i / xTicks) * tSpan; const xx = x(t);
      const span = tSpan;
      const lbl = span > 3 * 86400000 ? new Date(t).toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit" })
        : new Date(t).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
      xl += `<text x="${xx.toFixed(1)}" y="${H - 6}" text-anchor="middle" fill="var(--muted)" font-size="10">${lbl}</text>`;
    }

    let paths = "", areas = "", dots = "";
    series.forEach((s, idx) => {
      const rng = (s.axis === "r") ? rr : rl; if (!rng) return;
      let d = "", area = "", started = false, firstX = 0, lastX = 0;
      s.points.forEach((p) => {
        if (p.y == null) { started = false; return; }
        const px = x(p.t), py = yOf(p.y, rng);
        if (!started) { d += `M ${px.toFixed(1)} ${py.toFixed(1)}`; if (area === "") firstX = px; started = true; }
        else d += ` L ${px.toFixed(1)} ${py.toFixed(1)}`;
        lastX = px;
      });
      if (!d) return;
      if (s.area) {
        const gid = `grad${idx}`;
        areas += `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${s.color}" stop-opacity="0.28"/><stop offset="100%" stop-color="${s.color}" stop-opacity="0"/></linearGradient></defs>`;
        // build area by reusing line path then closing to bottom
        const pts = s.points.filter((p) => p.y != null);
        let ad = `M ${x(pts[0].t).toFixed(1)} ${(H - padB).toFixed(1)}`;
        pts.forEach((p) => { ad += ` L ${x(p.t).toFixed(1)} ${yOf(p.y, rng).toFixed(1)}`; });
        ad += ` L ${x(pts[pts.length - 1].t).toFixed(1)} ${(H - padB).toFixed(1)} Z`;
        areas += `<path d="${ad}" fill="url(#${gid})"/>`;
      }
      paths += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`;
    });

    const legend = series.map((s) => `<span class="lg"><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("");
    return `<div class="chart-legend">${legend}</div>
      <svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${areas}${paths}${yl}${yr}${xl}${dots}</svg>`;
  }

  function donut(segments, total) {
    const r = 52, c = 2 * Math.PI * r, cx = 64, cy = 64;
    let off = 0; let arcs = "";
    const sum = total || segments.reduce((a, s) => a + s.value, 0) || 1;
    segments.forEach((s) => {
      const frac = s.value / sum, len = frac * c;
      arcs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="16" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
      off += len;
    });
    return `<svg viewBox="0 0 128 128" width="128" height="128">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--panel-3)" stroke-width="16"/>
      ${arcs}
      <text x="${cx}" y="${cy - 2}" text-anchor="middle" fill="var(--txt)" font-size="26" font-weight="800">${nf(sum)}</text>
      <text x="${cx}" y="${cy + 16}" text-anchor="middle" fill="var(--muted)" font-size="11">cihaz</text>
    </svg>`;
  }

  // Two concentric rings sharing one total: inner = status, outer = device type.
  function donut2(innerSegs, outerSegs, total) {
    const cx = 90, cy = 90;
    const ring = (segs, r, w, ringName) => {
      const c = 2 * Math.PI * r;
      const sum = total || segs.reduce((a, s) => a + (s.value || 0), 0) || 1;
      let off = 0, arcs = "";
      segs.forEach((s) => {
        const len = ((s.value || 0) / sum) * c;
        if (len <= 0) return;
        const p = sum ? Math.round(((s.value || 0) / sum) * 100) : 0;
        arcs += `<circle class="donut-seg" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${w}" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})" data-label="${esc(s.label || "")}" data-ring="${ringName}" data-value="${esc(nf(s.value || 0))}" data-pct="${p}" data-color="${esc(s.color)}"></circle>`;
        off += len;
      });
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--panel-3)" stroke-width="${w}"/>${arcs}`;
    };
    return `<svg class="mix-donut" viewBox="0 0 180 180" width="100%" height="100%" data-total="${esc(nf(total))}" data-label="toplam cihaz" preserveAspectRatio="xMidYMid meet">
      ${ring(outerSegs, 74, 17, "Cihaz Tipi")}
      ${ring(innerSegs, 48, 17, "Durum")}
      <text class="donut-cv" x="${cx}" y="${cy - 2}" text-anchor="middle" fill="var(--txt)" font-size="34" font-weight="800">${nf(total)}</text>
      <text class="donut-cl" x="${cx}" y="${cy + 17}" text-anchor="middle" fill="var(--muted)" font-size="12">toplam cihaz</text>
    </svg>`;
  }

  // A single-ring donut for monetary segments (e.g. last month vs this-month forecast). Slices carry a
  // pre-formatted `display` string so the shared tooltip can show currency rather than a raw count.
  function donutMoney(segs, centerText, centerSub) {
    const cx = 90, cy = 90, r = 62, w = 21;
    const c = 2 * Math.PI * r;
    const sum = segs.reduce((a, s) => a + (s.value || 0), 0);
    let off = 0, arcs = "";
    segs.forEach((s) => {
      const len = sum > 0 ? ((s.value || 0) / sum) * c : 0;
      if (len <= 0) return;
      const p = sum ? Math.round(((s.value || 0) / sum) * 100) : 0;
      arcs += `<circle class="donut-seg" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${w}" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})" data-label="${esc(s.label)}" data-ring="${esc(s.ring || "Ödeme")}" data-value="${esc(s.display || "")}" data-pct="${p}" data-color="${esc(s.color)}"></circle>`;
      off += len;
    });
    return `<svg class="mix-donut" viewBox="0 0 180 180" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--panel-3)" stroke-width="${w}"/>
      ${arcs || ""}
      <text class="donut-cv" x="${cx}" y="${cy - 1}" text-anchor="middle" fill="var(--txt)" font-size="23" font-weight="800">${esc(centerText)}</text>
      <text class="donut-cl" x="${cx}" y="${cy + 18}" text-anchor="middle" fill="var(--muted)" font-size="11">${esc(centerSub)}</text>
    </svg>`;
  }

  function wireDonut(root) {
    const svgs = Array.from(root.querySelectorAll(".mix-donut"));
    if (!svgs.length) return;
    let tip = document.getElementById("donutTip");
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "donutTip";
      tip.className = "donut-tip";
      document.body.appendChild(tip);
    }
    const place = (e) => {
      const pad = 16;
      let x = e.clientX + 16, y = e.clientY + 16;
      const r = tip.getBoundingClientRect();
      if (x + r.width + pad > window.innerWidth) x = e.clientX - r.width - 16;
      if (y + r.height + pad > window.innerHeight) y = e.clientY - r.height - 16;
      tip.style.left = `${Math.max(pad, x)}px`;
      tip.style.top = `${Math.max(pad, y)}px`;
    };
    svgs.forEach((svg) => {
      const segs = Array.from(svg.querySelectorAll(".donut-seg"));
      const hide = () => { tip.style.display = "none"; segs.forEach((s) => s.classList.remove("dim", "hot")); };
      segs.forEach((seg) => {
        seg.addEventListener("mouseenter", () => {
          tip.innerHTML = `<span class="dt-dot" style="background:${seg.dataset.color}"></span>`
            + `<span class="dt-l">${esc(seg.dataset.ring)} · ${esc(seg.dataset.label)}</span>`
            + `<b>${esc(seg.dataset.value)}</b><span class="dt-p">%${esc(seg.dataset.pct)}</span>`;
          tip.style.display = "flex";
          segs.forEach((s) => { s.classList.toggle("hot", s === seg); s.classList.toggle("dim", s !== seg); });
        });
        seg.addEventListener("mousemove", place);
        seg.addEventListener("mouseleave", hide);
      });
    });
  }

  function signalBars(rssi) {
    let lvl = 0, label = "—";
    if (rssi != null && !Number.isNaN(Number(rssi))) {
      const v = Number(rssi);
      if (v <= 0) { // dBm
        lvl = v >= -65 ? 4 : v >= -75 ? 3 : v >= -85 ? 2 : v >= -95 ? 1 : 0; label = `${v} dBm`;
      } else if (v <= 31) { // CSQ
        lvl = v >= 20 ? 4 : v >= 15 ? 3 : v >= 10 ? 2 : v >= 2 ? 1 : 0; label = `CSQ ${v}`;
      } else { lvl = v >= 75 ? 4 : v >= 50 ? 3 : v >= 25 ? 2 : 1; label = `${v}`; }
    }
    const bars = [1, 2, 3, 4].map((i) => `<i class="${i <= lvl ? "lit" : ""}"></i>`).join("");
    return `<span class="signal" title="${esc(label)}">${bars}</span>`;
  }

  // shared bits
  const statusPill = (s) => `<span class="pill ${esc(s)}"><span class="pdot"></span>${esc(statusLabel(s))}</span>`;
  function statusLabel(s) { return ({ registered: "Kayıtlı", auto: "Otomatik", quarantined: "Karantina" })[s] || s; }
  const onlineDot = (on) => `<span class="online-dot ${on ? "on" : ""}"><i></i>${on ? "Çevrimiçi" : "Çevrimdışı"}</span>`;

  function switchPill(sw) {
    if (sw === 1 || sw === "on") return `<span class="pill on"><span class="pdot"></span>AÇIK</span>`;
    if (sw === 0 || sw === "off") return `<span class="pill off"><span class="pdot"></span>KAPALI</span>`;
    return `<span class="pill warn"><span class="pdot"></span>?</span>`;
  }

  function cmdClass(status) {
    const ok = ["verified_success", "verified_success_with_late_confirmation", "reconciled"];
    const bad = ["failed", "delivery_timeout", "expired", "verified_mismatch", "cancelled", "needs_attention"];
    if (ok.includes(status)) return "ok";
    if (bad.includes(status)) return "bad";
    return "pend";
  }

  // Human label for desired-state reconcile_status (bounded 3-cycle command model).
  function reconcileLabel(status) {
    const map = {
      pending: "bekliyor",
      in_flight: "gönderiliyor",
      reconciled: "tamamlandı",
      unreachable: "ulaşılamıyor (tutuluyor)",
      needs_attention: "dikkat gerekiyor"
    };
    return map[status] || status;
  }

  function alarmTypeLabel(type) {
    const map = { COMMAND_CONFIRMATION_TIMEOUT: "Komut teyit zaman aşımı" };
    return map[type] || type;
  }
  function alarmSevClass(sev) {
    return sev === "critical" ? "bad" : sev === "warning" ? "warn" : "info";
  }
  // One open-alarm row with an acknowledge button (handled via delegation on data-ack).
  function alarmRow(a) {
    return `<div class="alarm-line sev-${alarmSevClass(a.severity)}" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--line)">
        <span class="pill ${alarmSevClass(a.severity)}"><span class="pdot"></span>${esc(alarmTypeLabel(a.alarm_type))}</span>
        <div style="flex:1;min-width:0"><div style="font-size:13px">${esc(a.message || "")}</div><div class="muted" style="font-size:11px">${timeAgo(a.raised_at)}</div></div>
        <button class="btn xs ghost" data-ack="${esc(a.id)}">Onayla</button>
      </div>`;
  }

  // ---- adaptive polling: slow when idle, fast burst while a command is reconciling ----
  function fmtInterval(ms) {
    if (ms >= 60000) { const m = Math.round(ms / 60000); return `${m} dk`; }
    return `${Math.round(ms / 1000)} sn`;
  }
  // How long we are willing to keep fast-polling after issuing a command: bounded by the
  // device's command TTL when known, otherwise the online (kopma) window. Clamped 30s..15dk.
  function commandSettleWindowMs(cv) {
    const at = cv && cv.adaptiveTiming;
    const ttlSec = at && at.commandTtlSec ? at.commandTtlSec : (state.settings.onlineWindowSec || 360);
    return Math.min(Math.max(ttlSec, 30), 900) * 1000;
  }
  function commandPending(cv) {
    const d = cv && cv.desired;
    return !!(d && cmdClass(d.reconcile_status) === "pend");
  }
  // Reconcile the fast-polling flag against the live control view of the open device.
  function syncActiveCmd(sn, cv) {
    if (commandPending(cv)) {
      if (!state.activeCmd || state.activeCmd.sn !== sn) {
        state.activeCmd = { sn, deadline: Date.now() + commandSettleWindowMs(cv) };
      }
      return;
    }
    // Command settled (or none): if we were tracking one for this device, announce the outcome.
    if (state.activeCmd && state.activeCmd.sn === sn) {
      const d = cv && cv.desired;
      if (d) {
        const cls = cmdClass(d.reconcile_status);
        if (cls === "ok") toast("İşlem tamamlandı", `Röle ${cv.switchDecoded === "on" ? "AÇILDI" : cv.switchDecoded === "off" ? "KAPANDI" : "durumu teyit edildi"}.`, "success");
        else if (cls === "bad") toast("İşlem sonuçlanmadı", `Komut durumu: ${d.reconcile_status}. Uzlaştırıcı yeniden deneyecek.`, "error");
      }
      state.activeCmd = null;
    }
  }
  function currentRefreshMs() {
    if (state.activeCmd) {
      if (Date.now() < state.activeCmd.deadline) return FAST_REFRESH_MS;
      state.activeCmd = null; // settle window expired without confirmation; fall back to idle
    }
    return Math.max(2000, state.settings.refreshMs);
  }

  // ================================================================ lookups
  async function ensureLookups(force) {
    if (state.lookups.loaded && !force) return;
    try {
      const [pt, cu] = await Promise.all([api("GET", "/property-types"), api("GET", "/customers")]);
      state.lookups.propertyTypes = (pt && pt.items) || [];
      state.lookups.customers = (cu && cu.items) || [];
      state.lookups.loaded = true;
    } catch { /* tolerate */ }
  }

  // ================================================================ OVERVIEW
  function overviewSkeleton() {
    const panel = (h) => `<div class="panel"><div class="panel-head"><div class="skel" style="height:13px;width:140px"></div></div><div class="panel-pad">${h}</div></div>`;
    const lines = (n) => Array.from({ length: n }).map(() => `<div class="skel" style="height:14px;margin:10px 0;width:${60 + Math.round(Math.random() * 35)}%"></div>`).join("");
    return `
      <div class="page-head"><div><div class="skel" style="height:24px;width:200px"></div><div class="skel" style="height:12px;width:300px;margin-top:8px"></div></div></div>
      <div class="skel-grid">
        ${panel(`<div style="display:flex;gap:20px;align-items:center"><div class="skel" style="width:140px;height:140px;border-radius:50%"></div><div style="flex:1">${lines(5)}</div></div>`)}
        ${panel(lines(4))}
      </div>`;
  }

  // ---- Generic org-chart (flow chart) renderer ----------------------------------------------
  // A node is { kind, title, sub, badge, ico, stats:{total,online,offline,openAlarms}, data, children:[] }.
  // Counts roll up: a parent's stats should equal the sum of its children (callers build it so).
  const ORG_ICO = {
    root: `<svg viewBox="0 0 24 24" class="ic"><path d="M3 21h18M5 21V8l7-4 7 4v13M9 21v-5h6v5"/></svg>`,
    campus: `<svg viewBox="0 0 24 24" class="ic"><path d="M3 21h18M5 21V9l5-3 5 3M5 13h10M5 17h10M15 21V12l4 2v7"/></svg>`,
    bldg: `<svg viewBox="0 0 24 24" class="ic"><path d="M3 21h18M6 21V5l7-2 0 18M6 9h7M6 13h7M6 17h7M13 21V9l5 2v10"/></svg>`,
    dot: `<svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="12" r="4"/></svg>`
  };
  function unitIco(label) {
    const t = (label || "").toLocaleLowerCase("tr");
    if (/daire|ev|oda|mesken|müstakil|mustakil/.test(t)) return `<svg viewBox="0 0 24 24" class="ic"><path d="M4 11 12 4l8 7M6 10v9h12v-9"/></svg>`;
    if (/dükkan|dukkan|ofis|mağaza|magaza/.test(t)) return `<svg viewBox="0 0 24 24" class="ic"><path d="M4 9h16l-1-4H5L4 9Zm0 0v10h16V9M9 19v-5h6v5"/></svg>`;
    if (/fabrika|sanayi|makine|üretim|uretim/.test(t)) return `<svg viewBox="0 0 24 24" class="ic"><path d="M3 21V10l5 3V10l5 3V8l8 4v9H3Z"/></svg>`;
    if (/yurt|apart/.test(t)) return `<svg viewBox="0 0 24 24" class="ic"><path d="M5 21V4h10v17M15 21V9h4v12M8 8h4M8 12h4M8 16h4"/></svg>`;
    return ORG_ICO.dot;
  }
  function ocStatsHtml(s) {
    if (!s) return "";
    const cell = (v, cls) => `<span class="oc-s ${cls}">${nf(v)}</span>`;
    return `<div class="oc-stats">${cell(s.total, "tot")}${cell(s.online, "on")}${s.offline ? cell(s.offline, "off") : ""}${s.openAlarms ? `<span class="oc-s bad">⚠ ${nf(s.openAlarms)}</span>` : ""}</div>`;
  }
  function ocNodeHtml(n) {
    const head = n.badge
      ? `<span class="oc-badge">${esc(n.badge)}</span>`
      : `<span class="oc-ic">${n.ico || ORG_ICO.dot}</span>`;
    const sub = n.sub ? `<div class="oc-sub">${esc(n.sub)}</div>` : "";
    const alarm = n.stats && n.stats.openAlarms ? " has-alarm" : "";
    const kids = (n.children && n.children.length)
      ? `<ul>${n.children.map((c) => `<li>${ocNodeHtml(c)}</li>`).join("")}</ul>` : "";
    return `<div class="oc-node ${n.kind || ""}${alarm}${n.data ? " clickable" : ""}" ${n.data || ""}>
        <div class="oc-title">${head}<span class="oc-t" title="${esc(n.title)}">${esc(n.title)}</span></div>
        ${sub}${ocStatsHtml(n.stats)}
      </div>${kids}`;
  }
  function orgChartHtml(root) {
    return `<div class="org-scroll"><ul class="org-chart"><li>${ocNodeHtml(root)}</li></ul></div>`;
  }
  // Build a node tree from a /fleet/hierarchy customer row (customer → site → building → unit type).
  function customerToNode(c) {
    const cname = c.customerName && String(c.customerName).trim() ? c.customerName : "Atanmamış müşteri";
    const since = c.customerSince ? "Kayıt: " + new Date(c.customerSince).toLocaleDateString("tr-TR") : "";
    const custData = c.customerId ? ` data-customer="${esc(c.customerId)}" data-customer-label="${esc(cname)}"` : "";
    const nBld = (c.sites || []).reduce((s, st) => s + ((st.buildings && st.buildings.length) || 0), 0);
    return {
      kind: "cust", title: cname, badge: cname.slice(0, 2).toUpperCase(),
      sub: `${since}${since ? " · " : ""}${nf((c.sites || []).length)} yerleşke · ${nf(nBld)} bina`,
      stats: c, data: custData.trim(),
      children: (c.sites || []).map((st) => {
        const sname = st.siteName && String(st.siteName).trim() ? st.siteName : "Atanmamış yerleşke";
        const siteKey = (st.siteName && String(st.siteName).trim()) ? st.siteName : "__none__";
        const sdata = `data-site="${esc(siteKey)}" data-site-label="${esc(sname)}"${custData}`;
        return {
          kind: "campus", title: sname, ico: ORG_ICO.campus, stats: st, data: sdata,
          children: (st.buildings || []).map((b) => {
            const bname = b.buildingName && String(b.buildingName).trim() ? b.buildingName : "Atanmamış bina";
            const projKey = (b.buildingName && String(b.buildingName).trim()) ? b.buildingName : "__none__";
            const bdata = `data-project="${esc(projKey)}" data-project-label="${esc(bname)}"${custData}`;
            return {
              kind: "bldg", title: bname, ico: ORG_ICO.bldg, stats: b, data: bdata,
              children: (b.units || []).map((u) => ({
                kind: "leaf",
                title: u.unitLabel && String(u.unitLabel).trim() ? u.unitLabel : "Tip yok",
                ico: unitIco(u.unitLabel), stats: u, data: bdata
              }))
            };
          })
        };
      })
    };
  }
  // Open the flow chart for a single customer (or any node) in a modal — keeps the list clean.
  function openDiagramModal(rootNode, titleText) {
    modalMount.innerHTML = `
      <div class="modal-backdrop"><div class="modal xl">
        <div class="modal-head"><h3>${esc(titleText || "Akış şeması")}</h3>
          <span class="oc-legend"><i class="lg tot"></i>sayaç <i class="lg on"></i>aktif <i class="lg off"></i>çevrimdışı</span>
        </div>
        ${orgChartHtml(rootNode)}
        <div class="modal-actions"><button class="btn" id="diagClose">Kapat</button></div>
      </div></div>`;
    $("#diagClose").addEventListener("click", closeModal);
    $(".modal-backdrop", modalMount).addEventListener("click", (e) => { if (e.target.classList.contains("modal-backdrop")) closeModal(); });
    $$("[data-project],[data-site],[data-customer]", modalMount).forEach((el) => el.addEventListener("click", () => {
      if (el.dataset.project) { devicesState.project = el.dataset.project; devicesState.projectLabel = el.dataset.projectLabel || el.dataset.project; }
      else { devicesState.project = ""; devicesState.projectLabel = ""; }
      if (el.dataset.site) { devicesState.site = el.dataset.site; devicesState.siteLabel = el.dataset.siteLabel || el.dataset.site; }
      else { devicesState.site = ""; devicesState.siteLabel = ""; }
      devicesState.customer = el.dataset.customer || ""; devicesState.customerLabel = el.dataset.customerLabel || "";
      devicesState.q = ""; devicesState.status = ""; devicesState.online = ""; devicesState.page = 0;
      closeModal(); navigate("#/devices");
    }));
  }
  // A made-up hierarchy to preview deeper nesting (customer → campus → building → units).
  function demoDiagramNode() {
    const leaf = (label, total, online, alarms) => ({ kind: "leaf", title: label, ico: unitIco(label), stats: { total, online, offline: total - online, openAlarms: alarms || 0 } });
    const roll = (kind, title, ico, children) => {
      const s = { total: 0, online: 0, offline: 0, openAlarms: 0 };
      children.forEach((c) => { s.total += c.stats.total; s.online += c.stats.online; s.offline += c.stats.offline; s.openAlarms += c.stats.openAlarms; });
      return { kind, title, ico, stats: s, children };
    };
    const b = (name, units) => roll("bldg", name, ORG_ICO.bldg, units);
    const campus = (name, blds) => roll("campus", name, ORG_ICO.campus, blds);
    const cust = (name, campuses) => { const n = roll("cust", name, null, campuses); n.badge = name.slice(0, 2).toUpperCase(); n.sub = `${campuses.length} yerleşke`; return n; };
    const m1 = cust("Mülk A", [
      campus("Yerleşke 1", [
        b("Bina 1", [leaf("Daire", 12, 11), leaf("Dükkan", 4, 4), leaf("Makine", 2, 1, 1)]),
        b("Bina 2", [leaf("Daire", 8, 8), leaf("Makine", 3, 3)])
      ]),
      campus("Yerleşke 2", [
        b("Bina 1", [leaf("Daire", 10, 9, 1), leaf("Dükkan", 3, 2)])
      ])
    ]);
    const m2 = cust("Mülk B", [
      campus("Yerleşke 1", [
        b("Bina 1", [leaf("Daire", 6, 6), leaf("Dükkan", 2, 2)]),
        b("Bina 2", [leaf("Makine", 5, 4, 2), leaf("Daire", 7, 7)]),
        b("Bina 3", [leaf("Dükkan", 4, 3), leaf("Daire", 9, 9)])
      ]),
      campus("Yerleşke 2", [
        b("Bina 1", [leaf("Daire", 5, 5)]),
        b("Bina 2", [leaf("Makine", 3, 2, 1), leaf("Dükkan", 2, 2)])
      ]),
      campus("Yerleşke 3", [
        b("Bina 1", [leaf("Daire", 4, 4), leaf("Dükkan", 1, 1), leaf("Makine", 1, 1)])
      ])
    ]);
    return roll("root", "Tüm Filo (demo)", ORG_ICO.root, [m1, m2]);
  }

  async function renderOverview(silent) {
    if (!silent) view.innerHTML = overviewSkeleton();
    let ov, offline, alarms, owing, cmdAlarms, tree, models, bill, billAlloc, billAws;
    try {
      [ov, offline, alarms, owing, cmdAlarms, tree, models, bill, billAlloc, billAws] = await Promise.all([
        api("GET", `/fleet/overview?window=${state.settings.onlineWindowSec}`),
        api("GET", `/fleet/devices?online=false&limit=6&window=${state.settings.onlineWindowSec}`).catch(() => ({ items: [] })),
        api("GET", `/fleet/devices?alarm=true&limit=6`).catch(() => ({ items: [] })),
        api("GET", `/fleet/devices?owing=true&limit=6`).catch(() => ({ items: [] })),
        api("GET", `/alarms?status=open&limit=6`).catch(() => ({ items: [] })),
        api("GET", `/fleet/hierarchy?window=${state.settings.onlineWindowSec}`).catch(() => ({ items: [] })),
        api("GET", `/fleet/models`).catch(() => ({ items: [] })),
        isAdmin() ? api("GET", "/billing/config").catch(() => null) : Promise.resolve(null),
        isAdmin() ? api("GET", `/fleet/billing?window=${state.settings.onlineWindowSec}`).catch(() => null) : Promise.resolve(null),
        isAdmin() ? api("GET", "/billing/aws-cost").catch(() => null) : Promise.resolve(null)
      ]);
    } catch (e) { if (!silent) view.innerHTML = errorBox(e); return; }
    state.lastOverview = ov;
    setAlarmBadge((cmdAlarms.items || []).length + ov.alarms + ov.owing);

    const ICO = {
      alarm: `<svg viewBox="0 0 24 24" class="ic"><path d="M12 9v4m0 4h.01M10.3 4.3 2.4 18a1 1 0 0 0 .9 1.5h17.4a1 1 0 0 0 .9-1.5L13.7 4.3a1 1 0 0 0-1.7 0Z"/></svg>`,
      money: `<svg viewBox="0 0 24 24" class="ic"><path d="M12 2v20M16 6.5C16 5 14.2 4 12 4S8 5 8 6.7s1.8 2.3 4 2.8 4 1.3 4 3-1.8 2.7-4 2.7-4-1-4-2.5"/></svg>`,
      offline: `<svg viewBox="0 0 24 24" class="ic"><path d="M18.4 5.6 5.6 18.4M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z"/></svg>`
    };
    // Fault-focused attention list (dedup by sn): customer · meter no · fault status.
    // açamadı/kapatamadı derive from the command-timeout alarm's desired direction
    // (desired 1 = AÇIK, 0 = KAPALI); offline meters surface as "Kopuk".
    const FAULT = {
      open_fail:  { text: "Açamadı",    sev: "bad",  ic: "alarm" },
      close_fail: { text: "Kapatamadı", sev: "bad",  ic: "alarm" },
      cmd_fail:   { text: "Komut doğrulanamadı", sev: "bad", ic: "alarm" },
      alarm:      { text: "Arıza",      sev: "bad",  ic: "alarm" },
      offline:    { text: "Kopuk",      sev: "warn", ic: "offline" },
      owing:      { text: "Borçlu",     sev: "info", ic: "money" }
    };
    const att = new Map();
    const putFault = (sn, info) => { if (!att.has(sn)) att.set(sn, info); };
    (cmdAlarms.items || []).forEach((a) => {
      let f = FAULT.cmd_fail;
      if (a.alarm_type === "COMMAND_CONFIRMATION_TIMEOUT") {
        const des = Number(a.fields && (a.fields.desired ?? a.fields.desiredSwitch));
        if (des === 1) f = FAULT.open_fail;
        else if (des === 0) f = FAULT.close_fail;
      }
      att.set(a.sn, { sn: a.sn, label: a.label, customer: a.customer_name, city: null, time: a.raised_at, text: f.text, sev: f.sev, ic: f.ic });
    });
    (alarms.items || []).forEach((d) => putFault(d.sn, { sn: d.sn, label: d.label, customer: d.customer_name, city: d.city, time: d.last_seen_at, text: FAULT.alarm.text, sev: FAULT.alarm.sev, ic: FAULT.alarm.ic }));
    (offline.items || []).forEach((d) => { if (d.registry_status !== "quarantined") putFault(d.sn, { sn: d.sn, label: d.label, customer: d.customer_name, city: d.city, time: d.last_seen_at, text: FAULT.offline.text, sev: FAULT.offline.sev, ic: FAULT.offline.ic }); });
    (owing.items || []).forEach((d) => putFault(d.sn, { sn: d.sn, label: d.label, customer: d.customer_name, city: d.city, time: d.last_seen_at, text: FAULT.owing.text, sev: FAULT.owing.sev, ic: FAULT.owing.ic }));
    const sevRank = { bad: 0, warn: 1, info: 2 };
    const attArr = Array.from(att.values()).sort((a, b) => sevRank[a.sev] - sevRank[b.sev]).slice(0, 8);
    const attHtml = attArr.length ? `<div class="alarm-list">${attArr.map((a) => `
      <div class="alarm-item sev-${a.sev}" data-sn="${esc(a.sn)}">
        <div class="a-ic">${ICO[a.ic] || ICO.alarm}</div>
        <div class="a-main">
          <div class="a-title">${esc(a.customer || "Atanmamış müşteri")}</div>
          <div class="a-sub">Sayaç <span class="mono">${esc(a.label || a.sn)}</span>${a.label && a.label !== a.sn ? ` · ${esc(a.sn)}` : ""}${a.city ? " · " + esc(a.city) : ""}</div>
        </div>
        <div class="a-status"><span class="a-tag sev-${a.sev}">${esc(a.text)}</span><span class="a-time">${timeAgo(a.time)}</span></div>
      </div>`).join("")}</div>` : `<div class="alarm-empty"><div class="ae-ic">✓</div><div class="ae-txt"><b>Her şey yolunda</b><span>Arızalı veya kopuk sayaç yok.</span></div></div>`;
    const alarmsHtml = `
      <div class="panel">
        <div class="panel-head"><h2>Alarm ve Uyarılar</h2><div class="panel-actions">${attArr.length ? `<span class="pill ${attArr.some((a) => a.sev === "bad") ? "warn" : "on"}"><span class="pdot"></span>${nf(attArr.length)}</span>` : ""}<button class="btn sm ghost" data-go="alarms">Tümü →</button></div></div>
        <div>${attHtml}</div>
      </div>`;

    // Customers as a clean table; the flow chart for each customer opens in a modal (keeps the page
    // tidy even with many customers). Data feeds the per-row "diagram" action.
    const custItems = (tree && tree.items) || [];
    state.hierItems = custItems;
    const bldgCount = (c) => (c.sites || []).reduce((s, st) => s + ((st.buildings && st.buildings.length) || 0), 0);
    const totalSites = custItems.reduce((s, c) => s + ((c.sites && c.sites.length) || 0), 0);
    const totalBuildings = custItems.reduce((s, c) => s + bldgCount(c), 0);
    const cell = (v, cls) => `<td class="num"><span class="t-stat ${cls || ""}">${nf(v)}</span></td>`;
    const custRow = (c, i) => {
      const cname = c.customerName && String(c.customerName).trim() ? c.customerName : "Atanmamış müşteri";
      const since = c.customerSince ? new Date(c.customerSince).toLocaleDateString("tr-TR") : "—";
      const cidAttr = c.customerId ? `data-customer="${esc(c.customerId)}" data-customer-label="${esc(cname)}"` : "";
      return `<tr class="${c.openAlarms ? "row-alarm" : ""}">
        <td><div class="t-cust"><span class="t-badge">${esc(cname.slice(0, 2).toUpperCase())}</span><b>${esc(cname)}</b></div></td>
        <td class="muted">${esc(since)}</td>
        <td class="num">${nf((c.sites || []).length)}</td>
        <td class="num">${nf(bldgCount(c))}</td>
        ${cell(c.total, "tot")}
        ${cell(c.online, "on")}
        ${cell(c.offline, c.offline ? "off" : "")}
        <td class="num">${c.openAlarms ? `<span class="pill bad sm"><span class="pdot"></span>${nf(c.openAlarms)}</span>` : `<span class="muted">—</span>`}</td>
        <td class="row-actions">
          <button class="btn sm icon" data-diag="${i}" title="Akış şemasını aç"><svg viewBox="0 0 24 24" class="ic"><path d="M9 4h6v4H9zM4 16h6v4H4zM14 16h6v4h-6zM12 8v4M7 16v-2h10v2"/></svg></button>
          ${cidAttr ? `<button class="btn sm ghost" ${cidAttr} data-cust-devs="1">Cihazlar →</button>` : ""}
        </td>
      </tr>`;
    };
    const projHtml = `<div class="panel proj-panel">
        <div class="panel-head"><h2>Müşteriler</h2><div class="panel-actions">
          <button class="btn sm" id="simDiag" title="Örnek hiyerarşi"><svg viewBox="0 0 24 24" class="ic"><path d="M9 4h6v4H9zM4 16h6v4H4zM14 16h6v4h-6zM12 8v4M7 16v-2h10v2"/></svg>Simülasyon</button>
          <span class="panel-note">${nf(custItems.length)} müşteri · ${nf(totalSites)} yerleşke · ${nf(totalBuildings)} bina</span>
        </div></div>
        <div class="panel-pad">${custItems.length ? `<div class="table-wrap"><table class="data cust-table">
          <thead><tr><th>Müşteri</th><th>Kayıt</th><th class="num">Yerleşke</th><th class="num">Bina</th><th class="num">Sayaç</th><th class="num">Aktif</th><th class="num">Çevrimdışı</th><th class="num">Alarm</th><th></th></tr></thead>
          <tbody>${custItems.map(custRow).join("")}</tbody>
        </table></div>` : `<div class="empty" style="padding:24px">Henüz müşteriye atanmış cihaz yok.</div>`}</div>
      </div>`;

    // Device-mix donut: inner ring = status, outer ring = device type (model).
    const MODEL_COLORS = ["#3FA7A0", "#546E7A", "#6CA8D6", "#7FB77E", "#E0A84E", "#C94B4B", "#8E7CC3", "#5C8A8A", "#B5894E"];
    const statusSegs = [
      { label: "Çevrim İçi", value: ov.online, color: "var(--on)" },
      { label: "Karantina", value: ov.quarantined, color: "var(--warn)" },
      { label: "Çevrim Dışı", value: ov.offline, color: "var(--off)" }
    ];
    const modelSegs = ((models && models.items) || []).map((m, i) => ({
      label: m.model || "Bilinmiyor", value: m.total, color: MODEL_COLORS[i % MODEL_COLORS.length]
    }));
    const pct = (v, t) => (t ? Math.round((v / t) * 100) : 0);
    const dlRow = (s) => `<div class="dl"><i style="background:${s.color}"></i>${esc(s.label)}<b>${nf(s.value)}<span class="dl-pct">%${pct(s.value, ov.total)}</span></b></div>`;
    const mixHtml = `
      <div class="panel">
        <div class="panel-head"><h2>Cihaz Dağılımı</h2><div class="panel-actions"><button class="btn sm ghost" data-go="devices">Tüm cihazlar →</button></div></div>
        <div class="panel-pad mix-pad">
          <div class="mix-wrap">
            <div class="mix-donut-wrap">${donut2(statusSegs, modelSegs, ov.total)}</div>
            <div class="mix-legends">
              <div class="mix-col"><div class="dl-group">Durum (iç halka)</div>${statusSegs.map(dlRow).join("")}</div>
              <div class="mix-col"><div class="dl-group">Cihaz Tipi (dış halka)</div>${modelSegs.length ? modelSegs.map(dlRow).join("") : `<div class="dl" style="color:var(--muted)">Model bilgisi yok</div>`}</div>
            </div>
          </div>
        </div>
      </div>`;

    // Payment-forecast donut (admin only): last month actual vs this month estimate (AWS Cost Explorer).
    let costMixHtml = "";
    if (isAdmin() && bill) {
      state.settings.billing = Object.assign({}, state.settings.billing, bill); saveSettings();
      const cMargin = Number(bill.marginPct) || 0;
      const cManual = Number(bill.monthlyCost) || 0;
      const cMtd = billAws ? Number(billAws.monthToDate) || 0 : null;
      const cForecast = billAws && billAws.forecastMonthEnd != null ? Number(billAws.forecastMonthEnd) : null;
      const cLast = billAws ? Number(billAws.lastMonth) || 0 : null;
      // "Bu ay tahmini ödenecek": forecast if available, else month-to-date, else manual estimate.
      const cThis = cForecast != null ? cForecast : (cMtd != null ? cMtd : cManual);
      const cLastVal = cLast != null ? cLast : 0;
      const C_LAST = "#6CA8D6";
      const segs = [
        { label: "Bu ay (tahmini)", ring: "Ödeme", value: cThis, display: money(cThis), color: "var(--brand)" },
        { label: "Geçen ay", ring: "Ödeme", value: cLastVal, display: money(cLastVal), color: C_LAST }
      ];
      const sumSeg = cThis + cLastVal;
      let deltaHtml = "";
      if (cLast != null) {
        if (cLastVal > 0) {
          const dp = ((cThis - cLastVal) / cLastVal) * 100;
          const up = dp >= 0;
          deltaHtml = `<span class="cost-delta ${up ? "up" : "down"}" title="geçen aya göre">${up ? "▲" : "▼"} %${nf(Math.abs(dp), 0)}</span>`;
        } else if (cThis > 0) {
          deltaHtml = `<span class="cost-delta up" title="geçen ay maliyet yok">yeni</span>`;
        }
      }
      const charge = cThis * (1 + cMargin / 100);
      const totalDev = (billAlloc && billAlloc.totalDevices) || ov.managed || 0;
      const legendRow = (s, note) => `<div class="dl"><i style="background:${s.color}"></i>${esc(s.label)}<b>${money(s.value)}<span class="dl-pct muted">${esc(note)}</span></b></div>`;
      costMixHtml = `
      <div class="panel">
        <div class="panel-head"><h2>Ödeme Tahmini</h2><div class="panel-actions">${deltaHtml}<button class="btn sm ghost" data-go="billing">Detay →</button></div></div>
        <div class="panel-pad mix-pad">
          <div class="mix-wrap">
            <div class="mix-donut-wrap">${donutMoney(segs, sumSeg > 0 ? money(cThis) : money(0), "bu ay tahmini")}</div>
            <div class="mix-legends">
              <div class="mix-col">
                <div class="dl-group">Ödenecek (AWS)</div>
                ${legendRow(segs[0], "tahmini")}
                ${legendRow(segs[1], "gerçekleşen")}
                ${cMtd != null ? `<div class="dl"><i style="background:var(--on)"></i>Şu an ödenecek<b>${money(cMtd)}<span class="dl-pct muted">bugüne</span></b></div>` : ""}
              </div>
              <div class="mix-col">
                <div class="dl-group">Müşteriye talep</div>
                <div class="dl"><i style="background:var(--warn)"></i>Toplam${cMargin ? ` (marj %${nf(cMargin)})` : ""}<b>${money(charge)}</b></div>
                <div class="dl"><i style="background:var(--muted)"></i>Cihaz başı<b>${money(totalDev > 0 ? charge / totalDev : 0)}</b></div>
              </div>
            </div>
          </div>
          ${billAws ? "" : `<div class="bl-hint" style="margin:8px 0 0">AWS yapılandırılmamış — "Elle" maliyet gösteriliyor.</div>`}
        </div>
      </div>`;
    }

    view.innerHTML = `
      <div class="page-head">
        <div><h1>Genel Bakış</h1></div>
      </div>
      <div class="grid-2 ov-cols">
        <div class="ov-col">${mixHtml}${projHtml}</div>
        <div class="ov-col">${costMixHtml || ""}${alarmsHtml}</div>
      </div>`;

    wireDonut(view);
    $$("[data-sn]", view).forEach((el) => el.addEventListener("click", () => navigate(`#/device/${encodeURIComponent(el.dataset.sn)}`)));
    $$("[data-go]", view).forEach((el) => el.addEventListener("click", () => navigate(`#/${el.dataset.go}`)));
    $$("[data-diag]", view).forEach((el) => el.addEventListener("click", () => {
      const c = (state.hierItems || [])[Number(el.dataset.diag)];
      if (c) openDiagramModal(customerToNode(c), (c.customerName || "Atanmamış müşteri") + " · akış şeması");
    }));
    const simBtn = $("#simDiag", view);
    if (simBtn) simBtn.addEventListener("click", () => openDiagramModal(demoDiagramNode(), "Simülasyon · örnek hiyerarşi"));
    $$("[data-cust-devs]", view).forEach((el) => el.addEventListener("click", () => {
      devicesState.customer = el.dataset.customer || "";
      devicesState.customerLabel = el.dataset.customerLabel || "";
      devicesState.project = ""; devicesState.projectLabel = "";
      devicesState.site = ""; devicesState.siteLabel = "";
      devicesState.q = ""; devicesState.status = ""; devicesState.online = ""; devicesState.page = 0;
      navigate("#/devices");
    }));
    state.refresher = renderOverview;
  }

  // ================================================================ DEVICES TABLE
  const devicesState = { q: "", status: "", online: "", project: "", projectLabel: "", site: "", siteLabel: "", customer: "", customerLabel: "", page: 0, pageSize: 50, total: 0 };

  async function renderDevices(silent) {
    if (!silent) {
      view.innerHTML = `
        <div class="page-head"><div><h1>Cihazlar</h1><div class="sub" id="devCount">yükleniyor…</div></div>
          <div class="head-actions">
            <button class="btn" id="devExport"><svg viewBox="0 0 24 24" class="ic"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/></svg>Dışa aktar</button>
            <button class="btn" id="devImport"><svg viewBox="0 0 24 24" class="ic"><path d="M12 15V3m0 0 4 4m-4-4-4 4M5 21h14"/></svg>CSV içe aktar</button>
            <button class="btn primary" id="devNew"><svg viewBox="0 0 24 24" class="ic"><path d="M12 5v14M5 12h14"/></svg>Yeni sayaç</button>
          </div>
        </div>
        <div class="toolbar">
          <div class="seg" id="statusSeg">
            <button data-v="" class="active">Tümü</button><button data-v="registered">Kayıtlı</button>
            <button data-v="auto">Otomatik</button><button data-v="quarantined">Karantina</button>
          </div>
          <div class="seg" id="onlineSeg">
            <button data-v="" class="active">Hepsi</button><button data-v="true">Çevrimiçi</button><button data-v="false">Çevrimdışı</button>
          </div>
          ${devicesState.site ? `<button class="chip-filter" id="clearSite" title="Yerleşke filtresini kaldır">Yerleşke: <b>${esc(devicesState.siteLabel || devicesState.site)}</b> <span class="x">✕</span></button>` : ""}
          ${devicesState.project ? `<button class="chip-filter" id="clearProject" title="Bina filtresini kaldır">Bina: <b>${esc(devicesState.projectLabel || devicesState.project)}</b> <span class="x">✕</span></button>` : ""}
          ${devicesState.customer ? `<button class="chip-filter" id="clearCustomer" title="Müşteri filtresini kaldır">Müşteri: <b>${esc(devicesState.customerLabel || devicesState.customer)}</b> <span class="x">✕</span></button>` : ""}
          <div class="spacer"></div>
          <input id="devSearch" placeholder="SN / etiket / müşteri / şehir ara…" style="width:280px" value="${esc(devicesState.q)}" />
        </div>
        <div class="panel"><div class="table-wrap"><table class="data" id="devTable">
          <thead><tr>
            <th>Durum</th><th>SN</th><th>Etiket</th><th>Model</th><th>Müşteri / Konum</th>
            <th class="num">Gerilim</th><th class="num">Akım</th><th class="num">Güç</th><th class="num">PF</th>
            <th class="num">Enerji</th><th>Röle</th><th>Sinyal</th><th>Son görülme</th><th></th>
          </tr></thead>
          <tbody id="devBody"><tr><td colspan="14" class="empty">Yükleniyor…</td></tr></tbody>
        </table></div><div class="pager" id="devPager"></div></div>`;

      $("#statusSeg").addEventListener("click", (e) => segPick(e, "status"));
      $("#onlineSeg").addEventListener("click", (e) => segPick(e, "online"));
      $("#devSearch").addEventListener("input", debounce((e) => { devicesState.q = e.target.value.trim(); devicesState.page = 0; loadDevices(); }, 300));
      $("#devNew").addEventListener("click", () => openRegisterModal(null));
      $("#devImport").addEventListener("click", openImportModal);
      $("#devExport").addEventListener("click", exportDevicesCsv);
      const clrSite = $("#clearSite");
      if (clrSite) clrSite.addEventListener("click", () => { devicesState.site = ""; devicesState.siteLabel = ""; devicesState.page = 0; renderDevices(); });
      const clrProj = $("#clearProject");
      if (clrProj) clrProj.addEventListener("click", () => { devicesState.project = ""; devicesState.projectLabel = ""; devicesState.page = 0; renderDevices(); });
      const clrCust = $("#clearCustomer");
      if (clrCust) clrCust.addEventListener("click", () => { devicesState.customer = ""; devicesState.customerLabel = ""; devicesState.page = 0; renderDevices(); });
    }
    await loadDevices(silent);
    state.refresher = (s) => loadDevices(true);
  }

  function segPick(e, key) {
    const btn = e.target.closest("button"); if (!btn) return;
    $$("button", e.currentTarget).forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    devicesState[key] = btn.dataset.v;
    devicesState.page = 0;
    loadDevices();
  }

  function buildDevicesQuery() {
    const p = new URLSearchParams();
    if (devicesState.q) p.set("q", devicesState.q);
    if (devicesState.status) p.set("status", devicesState.status);
    if (devicesState.online) p.set("online", devicesState.online);
    if (devicesState.project) p.set("project", devicesState.project);
    if (devicesState.site) p.set("site", devicesState.site);
    if (devicesState.customer) p.set("customer", devicesState.customer);
    p.set("window", state.settings.onlineWindowSec);
    p.set("limit", devicesState.pageSize);
    p.set("offset", devicesState.page * devicesState.pageSize);
    return p.toString();
  }

  async function loadDevices(silent) {
    const body = $("#devBody"); if (!body) return;
    let res;
    try { res = await api("GET", `/fleet/devices?${buildDevicesQuery()}`); }
    catch (e) { body.innerHTML = `<tr><td colspan="14" class="empty">${esc(e.message)}</td></tr>`; return; }
    devicesState.total = res.total;
    const cnt = $("#devCount"); if (cnt) cnt.textContent = `${nf(res.total)} cihaz`;
    if (!res.items.length) { body.innerHTML = `<tr><td colspan="14" class="empty">Eşleşen cihaz yok.</td></tr>`; }
    else body.innerHTML = res.items.map((d) => {
      const approve = d.registry_status === "quarantined" ? `<button class="btn sm warn" data-approve="${esc(d.sn)}">Onayla</button>` : "";
      const pwr = d.active_power_kw;
      return `<tr data-sn="${esc(d.sn)}">
        <td>${onlineDot(d.online)}</td>
        <td class="mono">${esc(d.sn)}</td>
        <td>${esc(d.label || "—")} ${d.registry_status === "quarantined" ? statusPill("quarantined") : ""}</td>
        <td>${modelCell(d.model)}</td>
        <td>${esc(d.customer_name || "—")}${d.city ? `<span class="muted"> · ${esc(d.city)}</span>` : ""}</td>
        <td class="num">${d.voltage_v != null ? nf(d.voltage_v, 1) : "—"}</td>
        <td class="num">${d.current_a != null ? nf(d.current_a, 2) : "—"}</td>
        <td class="num">${pwr != null ? nf(pwr, 2) : "—"}</td>
        <td class="num">${d.power_factor != null ? nf(d.power_factor, 2) : "—"}</td>
        <td class="num">${d.energy_import_kwh != null ? nf(d.energy_import_kwh, 1) : "—"}</td>
        <td>${switchPill(d.switch_state)}</td>
        <td>${signalBars(d.rssi)}</td>
        <td class="muted nowrap">${timeAgo(d.last_seen_at)}</td>
        <td><div class="row-actions">${approve}<button class="btn sm" data-detail="${esc(d.sn)}">Detay</button></div></td>
      </tr>`;
    }).join("");

    $$("tr[data-sn]", body).forEach((tr) => tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-approve]")) return;
      navigate(`#/device/${encodeURIComponent(tr.dataset.sn)}`);
    }));
    $$("[data-approve]", body).forEach((b) => b.addEventListener("click", async (e) => {
      e.stopPropagation();
      await approveDevice(b.dataset.approve, () => loadDevices(true));
    }));

    const pager = $("#devPager");
    if (pager) {
      const from = res.total ? devicesState.page * devicesState.pageSize + 1 : 0;
      const to = Math.min((devicesState.page + 1) * devicesState.pageSize, res.total);
      const maxPage = Math.max(0, Math.ceil(res.total / devicesState.pageSize) - 1);
      pager.innerHTML = `<span>${from}–${to} / ${nf(res.total)}</span>
        <button class="btn sm" ${devicesState.page <= 0 ? "disabled" : ""} id="pgPrev">← Önceki</button>
        <button class="btn sm" ${devicesState.page >= maxPage ? "disabled" : ""} id="pgNext">Sonraki →</button>`;
      const prev = $("#pgPrev"), next = $("#pgNext");
      if (prev) prev.addEventListener("click", () => { devicesState.page--; loadDevices(); });
      if (next) next.addEventListener("click", () => { devicesState.page++; loadDevices(); });
    }
  }

  async function exportDevicesCsv() {
    try {
      const all = [];
      let offset = 0;
      const p = new URLSearchParams();
      if (devicesState.q) p.set("q", devicesState.q);
      if (devicesState.status) p.set("status", devicesState.status);
      if (devicesState.online) p.set("online", devicesState.online);
      p.set("window", state.settings.onlineWindowSec);
      p.set("limit", "500");
      for (;;) {
        p.set("offset", offset);
        const res = await api("GET", `/fleet/devices?${p.toString()}`);
        all.push(...res.items);
        if (all.length >= res.total || res.items.length === 0) break;
        offset += 500;
        if (offset > 50000) break;
      }
      const cols = ["sn", "label", "customer_name", "city", "registry_status", "online", "voltage_v", "current_a", "active_power_kw", "power_factor", "energy_import_kwh", "balance", "switch_state", "rssi", "last_seen_at"];
      const csv = [cols.join(",")].concat(all.map((d) => cols.map((c) => csvCell(d[c])).join(","))).join("\n");
      downloadFile(`volt4amper-cihazlar-${new Date().toISOString().slice(0, 10)}.csv`, csv);
      toast("Dışa aktarıldı", `${all.length} cihaz CSV olarak indirildi`, "success");
    } catch (e) { toast("Dışa aktarma hatası", e.message, "error"); }
  }
  const csvCell = (v) => { if (v == null) return ""; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  function downloadFile(name, content) {
    const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ================================================================ DEVICE DETAIL
  const deviceState = { sn: null, range: "24h", presenceHours: 24 };

  // builders for the live (auto-refreshed) regions — kept separate so silent refresh updates
  // only these slots and never disturbs the trend chart or rebinds static controls.
  function relayHtml(sw) {
    const cls = sw === "on" ? "on" : sw === "off" ? "off" : "unknown";
    const txt = sw === "on" ? "AÇIK" : sw === "off" ? "KAPALI" : "BİLİNMİYOR";
    return `<div class="relay-badge ${cls}"><div class="rb-state">${txt}</div><div class="rb-sub">röle (decode)</div></div>`;
  }
  // Bounded 3-cycle command model: the reconciler drives at most CYCLE_COUNT cycles, then marks
  // the desired state `needs_attention` and raises a COMMAND_CONFIRMATION_TIMEOUT alarm.
  const CYCLE_COUNT = 3;
  function desiredHtml(cv) {
    const d = cv && cv.desired;
    const alarms = (cv && cv.alarms) || [];
    const alarmsBlock = alarms.length
      ? `<div style="margin-top:12px">${alarms.map(alarmRow).join("")}</div>`
      : "";
    if (!d) {
      return `<div class="muted" style="margin-top:14px">Aktif irade yok — röle bildirilen durumda.</div>${alarmsBlock}`;
    }
    const needsAttention = d.reconcile_status === "needs_attention";
    const cls = cmdClass(d.reconcile_status);
    const cycleNo = Number(d.cycle_no) || 0;
    const banner = needsAttention
      ? `<div class="fault-banner">⚠ DİKKAT GEREKİYOR: ${CYCLE_COUNT} tur denendi, cihaz röleyi hedeflenen duruma geçirmedi. Hedef korunuyor; cihaz yanıt verene kadar müdahale gerekebilir.</div>`
      : "";
    const cycleRow = cycleNo > 0 && !needsAttention
      ? `<dt>Tur</dt><dd>${cycleNo}/${CYCLE_COUNT}</dd>`
      : "";
    return `${banner}<div class="kv" style="margin-top:14px">
        <dt>İrade durumu</dt><dd><span class="pill ${cls}">${esc(reconcileLabel(d.reconcile_status))}</span></dd>
        <dt>Hedef</dt><dd class="mono">${esc(JSON.stringify(d.desired_value))}</dd>
        ${cycleRow}
        <dt>Deneme</dt><dd>${nf(d.attempt_count)}</dd>
      </div>${alarmsBlock}`;
  }
  function gaugesHtml(m) {
    return gauge({ value: m.voltage_v, min: 180, max: 260, unit: "V", label: "Gerilim", digits: 0, zones: [{ to: 0.18, color: "var(--bad)" }, { to: 0.32, color: "var(--warn)" }, { to: 0.85, color: "var(--on)" }, { to: 1, color: "var(--warn)" }] })
      + gauge({ value: m.current_a, min: 0, max: gaugeMax(m.current_a, 40), unit: "A", label: "Akım", digits: 2 })
      + gauge({ value: m.active_power_kw, min: 0, max: gaugeMax(m.active_power_kw, 10), unit: "kW", label: "Güç", digits: 2 })
      + gauge({ value: m.power_factor, min: 0, max: 1, unit: "", label: "Güç Faktörü", digits: 2, zones: [{ to: 0.8, color: "var(--warn)" }, { to: 1, color: "var(--on)" }] });
  }
  function metricsHtml(m) {
    const owe = m.owe_money;
    return `<div class="metric"><div class="m-label">Enerji (kWh)</div><div class="m-val">${m.energy_import_kwh != null ? nf(m.energy_import_kwh, 2) : "—"}</div></div>
      <div class="metric"><div class="m-label">Bakiye</div><div class="m-val">${m.balance != null ? nf(m.balance, 2) : "—"}<small>₺</small></div></div>
      <div class="metric"><div class="m-label">Borç durumu</div><div class="m-val" style="color:${owe > 0 ? "var(--bad-text)" : "var(--on-text)"}">${owe == null ? "—" : owe > 0 ? "Borçlu" : "Yok"}</div></div>
      <div class="metric"><div class="m-label">Reaktif (kVAr)</div><div class="m-val">${m.reactive_power_kvar != null ? nf(m.reactive_power_kvar, 2) : "—"}</div></div>`;
  }
  function threePhaseHtml(m) {
    const cell = (v, d, u) => v != null ? `${nf(v, d)}<small>${u || ""}</small>` : "—";
    const pa = m.active_power_a_kw != null ? m.active_power_a_kw : m.active_power_kw;
    const pfa = m.power_factor_a != null ? m.power_factor_a : m.power_factor;
    const rows = [
      { ph: "L1", v: m.voltage_v, i: m.current_a, p: pa, pf: pfa },
      { ph: "L2", v: m.voltage_b_v, i: m.current_b_a, p: m.active_power_b_kw, pf: m.power_factor_b },
      { ph: "L3", v: m.voltage_c_v, i: m.current_c_a, p: m.active_power_c_kw, pf: m.power_factor_c }
    ];
    const hasPhase = rows.some((r) => r.v != null || r.i != null || r.p != null);
    const tariff = [
      { k: "Puant", v: m.energy_peak_kwh },
      { k: "Gündüz", v: m.energy_flat_kwh },
      { k: "Gece", v: m.energy_valley_kwh },
      { k: "Sivri", v: m.energy_sharp_kwh }
    ];
    const hasTariff = tariff.some((t) => t.v != null);
    if (!hasPhase && !hasTariff && m.max_demand_kw == null) {
      return `<div class="empty">Bu cihazdan henüz faz/tarife verisi gelmedi. Enerji analiz modunda <code>data/up update</code> mesajı geldikçe dolar.</div>`;
    }
    const phaseTable = `<table class="phase-tbl">
      <thead><tr><th>Faz</th><th>Gerilim</th><th>Akım</th><th>Güç</th><th>PF</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><th>${r.ph}</th><td>${cell(r.v, 1, " V")}</td><td>${cell(r.i, 2, " A")}</td><td>${cell(r.p, 2, " kW")}</td><td>${cell(r.pf, 2, "")}</td></tr>`).join("")}</tbody>
    </table>`;
    const tariffCards = hasTariff ? `<div class="metric-cards" style="margin-top:14px">
      ${tariff.map((t) => `<div class="metric"><div class="m-label">${t.k} (kWh)</div><div class="m-val">${t.v != null ? nf(t.v, 2) : "—"}</div></div>`).join("")}
      ${m.max_demand_kw != null ? `<div class="metric"><div class="m-label">Maks. Talep</div><div class="m-val">${nf(m.max_demand_kw, 2)}<small>kW</small></div></div>` : ""}
    </div>` : (m.max_demand_kw != null ? `<div class="metric-cards" style="margin-top:14px"><div class="metric"><div class="m-label">Maks. Talep</div><div class="m-val">${nf(m.max_demand_kw, 2)}<small>kW</small></div></div></div>` : "");
    return phaseTable + tariffCards;
  }
  function connHtml(m, cv, online, lastSeen) {
    const cad = cv && cv.cadence, at = cv && cv.adaptiveTiming;
    return `<dt>Durum</dt><dd>${onlineDot(online)}</dd>
      <dt>Son görülme</dt><dd>${timeAgo(lastSeen)}</dd>
      <dt>Son zaman</dt><dd>${fmtDateTime(lastSeen)}</dd>
      <dt>Sinyal</dt><dd>${signalBars(m.rssi)} <span class="muted">${m.rssi != null ? m.rssi : ""}</span></dd>
      <dt>MAC</dt><dd class="mono">${esc(m.mac_address || "—")}</dd>
      ${cad ? `<dt>Ritim (EWMA)</dt><dd>${cad.ewmaReconnectSec != null ? nf(cad.ewmaReconnectSec, 0) + "s" : "—"} <span class="muted">(${nf(cad.sampleCount)} örnek)</span></dd>` : ""}
      ${at ? `<dt>Gating penceresi</dt><dd>${nf(at.gatingWindowSec)}s</dd><dt>Komut TTL/ACK/retry</dt><dd>${at.commandTtlSec}/${at.ackTimeoutSec}/${at.retryIntervalSec}s</dd>` : ""}`;
  }
  function pillsHtml(online, m, reg, cv) {
    const owe = m.owe_money, alarmFlag = (m.alarm_a && m.alarm_a > 0) || (m.alarm_b && m.alarm_b > 0);
    const d = cv && cv.desired;
    const needsAttention = !!(d && d.reconcile_status === "needs_attention");
    const cmdAlarm = !!(cv && cv.alarms && cv.alarms.length);
    const attentionPill = (needsAttention || cmdAlarm)
      ? `<span class="pill bad"><span class="pdot"></span>DİKKAT</span>`
      : "";
    return `${reg ? statusPill(reg.registry_status) : ""}${onlinePill(online)}${attentionPill}${alarmFlag ? `<span class="pill bad"><span class="pdot"></span>ALARM</span>` : ""}${owe > 0 ? `<span class="pill warn"><span class="pdot"></span>BORÇLU</span>` : ""}`;
  }

  function applyDeviceDynamic(tel, cv, reg) {
    const m = tel || {};
    const sw = cv ? cv.switchDecoded : (m.switch_state === 1 ? "on" : m.switch_state === 0 ? "off" : "unknown");
    const lastSeen = (cv && cv.lastSeen) || m.last_seen_at || (reg && reg.last_seen_at) || null;
    const online = cv ? cv.onlineFresh : (lastSeen ? (Date.now() - new Date(lastSeen).getTime() < state.settings.onlineWindowSec * 1000) : false);
    const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    set("hdrPills", pillsHtml(online, m, reg, cv));
    set("relaySlot", relayHtml(sw));
    set("desiredSlot", desiredHtml(cv));
    set("gaugeSlot", gaugesHtml(m));
    set("metricSlot", metricsHtml(m));
    set("phaseSlot", threePhaseHtml(m));
    set("connSlot", connHtml(m, cv, online, lastSeen));
    set("cmdSlot", commandTimeline(cv && cv.recentCommands));
    const method = document.getElementById("lastMethodTag");
    if (method) method.textContent = cv && cv.lastMethod ? "yöntem: " + cv.lastMethod : "";
    syncActiveCmd(deviceState.sn, cv);
  }

  async function renderDevice(sn, silent) {
    deviceState.sn = sn;
    const reuse = silent && view.getAttribute("data-device") === sn;
    if (!silent) view.innerHTML = `<div class="loading">${esc(sn)} yükleniyor…</div>`;
    let tel, cv, reg;
    try {
      [tel, cv, reg] = await Promise.all([
        api("GET", `/devices/${encodeURIComponent(sn)}/telemetry`).catch(() => null),
        api("GET", `/devices/${encodeURIComponent(sn)}/control-view`).catch(() => null),
        api("GET", `/registry/devices/${encodeURIComponent(sn)}`).catch(() => null)
      ]);
    } catch (e) { if (!silent) view.innerHTML = errorBox(e); return; }
    if (!tel && !cv && !reg) { view.innerHTML = errorBox({ message: "Cihaz bulunamadı." }); return; }

    if (reuse && view.getAttribute("data-device") === sn) {
      applyDeviceDynamic(tel, cv, reg);
      state.refresher = () => renderDevice(sn, true);
      return;
    }

    // full skeleton build (static controls + live slots)
    const _ph = reg ? phaseInfo(reg.model) : null;
    const is3ph = !!(_ph && _ph.n === 3);
    view.innerHTML = `
      <div class="page-head">
        <div>
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            <button class="btn sm ghost" id="devBack">← Cihazlar</button>
            <h1 style="font-size:20px">${esc((reg && reg.label) || sn)}</h1>
            <span id="hdrPills" style="display:inline-flex;gap:8px;flex-wrap:wrap"></span>
            ${reg && reg.model ? `<span class="pill info" title="Model / faz">${esc(reg.model)}${phaseInfo(reg.model) ? ` · ${phaseInfo(reg.model).label}` : ""}</span>` : ""}
          </div>
          <div class="sub mono">${esc(sn)}${reg && reg.customer_name ? ` · ${esc(reg.customer_name)}` : ""}${reg && (reg.address_line || reg.city) ? ` · ${esc([reg.address_line, reg.district, reg.city].filter(Boolean).join(", "))}` : ""}</div>
        </div>
        <div class="head-actions">
          <button class="btn" id="devRefreshCmd"><svg viewBox="0 0 24 24" class="ic"><path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v5h-5"/></svg>Yenile (refresh)</button>
          ${reg ? `<button class="btn" id="devEdit">Meta düzenle</button>` : ""}
        </div>
      </div>

      <div class="grid-2">
        <div class="ov-col">
          <div class="panel panel-pad">
            <div class="switch-hero">
              <div id="relaySlot"></div>
              <div class="switch-actions">
                <div class="row">
                  <button class="btn success" id="btnOn">AÇ</button>
                  <button class="btn danger" id="btnOff">KAPAT</button>
                </div>
                <button class="btn ghost block" id="btnClear">İradeyi temizle</button>
                <div id="desiredSlot"></div>
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="panel-head"><h2>Anlık Elektriksel Değerler</h2><div class="panel-actions muted" id="lastMethodTag" style="font-size:12px"></div></div>
            <div class="panel-pad"><div class="gauges" id="gaugeSlot"></div></div>
          </div>

          <div class="panel">
            <div class="panel-head"><h2>Trend</h2>
              <div class="panel-actions"><div class="seg" id="rangeSeg">
                ${["1h", "6h", "24h", "7d", "30d"].map((r) => `<button data-v="${r}" class="${r === deviceState.range ? "active" : ""}">${r}</button>`).join("")}
              </div></div>
            </div>
            <div class="panel-pad" id="chartArea"><div class="loading">Grafik yükleniyor…</div></div>
          </div>

          <div class="panel">
            <div class="panel-head"><h2>Çevrimiçi / Çevrimdışı Geçmişi</h2>
              <div class="panel-actions"><div class="seg" id="presSeg">
                ${[["24", "24s"], ["72", "3g"], ["168", "7g"], ["720", "30g"]].map(([v, l]) => `<button data-v="${v}" class="${String(v) === String(deviceState.presenceHours) ? "active" : ""}">${l}</button>`).join("")}
              </div></div>
            </div>
            <div class="panel-pad" id="presenceArea"><div class="loading">Yükleniyor…</div></div>
          </div>

          <div class="panel">
            <div class="panel-head"><h2>Komut Geçmişi (gönderim → ACK)</h2></div>
            <div class="panel-pad" id="cmdSlot"></div>
          </div>
        </div>

        <div class="ov-col">
          <div class="panel">
            <div class="panel-head"><h2>Sayaç & Bakiye</h2></div>
            <div class="panel-pad"><div class="metric-cards" id="metricSlot"></div></div>
          </div>

          ${is3ph ? `<div class="panel">
            <div class="panel-head"><h2>3 Faz Detay</h2><div class="panel-actions muted" style="font-size:12px">L1 / L2 / L3</div></div>
            <div class="panel-pad" id="phaseSlot"></div>
          </div>` : ""}

          <div class="panel">
            <div class="panel-head"><h2>Bağlantı & Sinyal</h2></div>
            <div class="panel-pad"><dl class="kv" id="connSlot"></dl></div>
          </div>

          ${reg ? `<div class="panel">
            <div class="panel-head"><h2>Kayıt Bilgileri</h2><div class="panel-actions"><button class="btn sm ghost" id="devEdit2">Düzenle</button></div></div>
            <div class="panel-pad">
              <dl class="kv">
                <dt>Müşteri</dt><dd>${esc(reg.customer_name || "—")}</dd>
                <dt>Yerleşke / Bina</dt><dd>${esc([reg.site_name, reg.project_name].filter(Boolean).join(" / ") || "—")}</dd>
                <dt>Abone No</dt><dd>${esc(reg.subscriber_no || "—")}</dd>
                <dt>Mülk tipi</dt><dd>${esc(reg.property_type_label || "—")}</dd>
                <dt>Adres</dt><dd>${esc([reg.address_line, reg.district, reg.city].filter(Boolean).join(", ") || "—")}</dd>
                <dt>Tarife</dt><dd>${esc(reg.tariff || "—")}</dd>
                <dt>Bölge / Bayi</dt><dd>${esc([reg.region, reg.dealer].filter(Boolean).join(" / ") || "—")}</dd>
                <dt>Model / Faz</dt><dd>${esc(reg.model || "—")}${phaseInfo(reg.model) ? ` · ${phaseInfo(reg.model).label}` : ""}</dd>
                <dt>İzleme tipi</dt><dd>${esc(telemetryModeLabel(reg.telemetry_mode))}</dd>
                <dt>Yaşam döngüsü</dt><dd><span class="pill neutral">${esc(reg.lifecycle_status)}</span></dd>
                <dt>Ürün anahtarı</dt><dd class="mono">${esc(reg.product_key || "—")}</dd>
              </dl>
              <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
                ${reg.registry_status === "quarantined" ? `<button class="btn sm warn" id="lcApprove">Onayla (whitelist)</button>` : ""}
                <button class="btn sm ghost" id="lcDecom">Devre dışı bırak</button>
              </div>
            </div>
          </div>` : ""}
        </div>
      </div>`;
    view.setAttribute("data-device", sn);

    applyDeviceDynamic(tel, cv, reg);

    // bind static controls once
    $("#devBack").addEventListener("click", () => navigate("#/devices"));
    $("#btnOn").addEventListener("click", () => switchAction(sn, 1));
    $("#btnOff").addEventListener("click", () => switchAction(sn, 0));
    $("#btnClear").addEventListener("click", () => clearDesired(sn));
    $("#devRefreshCmd").addEventListener("click", () => refreshCmd(sn));
    // Delegated: acknowledge buttons live inside the auto-refreshed desired slot.
    const dslot = $("#desiredSlot");
    if (dslot) dslot.addEventListener("click", (e) => {
      const b = e.target.closest("[data-ack]"); if (!b) return;
      ackAlarm(b.getAttribute("data-ack"), sn);
    });
    if (reg) { const open = () => openRegisterModal(reg); const e1 = $("#devEdit"), e2 = $("#devEdit2"); if (e1) e1.addEventListener("click", open); if (e2) e2.addEventListener("click", open); }
    const ap = $("#lcApprove"); if (ap) ap.addEventListener("click", () => approveDevice(sn, () => { view.removeAttribute("data-device"); renderDevice(sn); }));
    const dc = $("#lcDecom"); if (dc) dc.addEventListener("click", async () => { if (!confirm("Cihaz devre dışı bırakılsın mı?")) return; try { await api("POST", `/registry/devices/${encodeURIComponent(sn)}/lifecycle`, { lifecycle: "decommissioned" }); toast("Güncellendi", "", "success"); view.removeAttribute("data-device"); renderDevice(sn); } catch (e) { toast("Hata", e.message, "error"); } });
    $$("#rangeSeg button", view).forEach((b) => b.addEventListener("click", () => {
      $$("#rangeSeg button", view).forEach((x) => x.classList.remove("active")); b.classList.add("active");
      deviceState.range = b.dataset.v; loadSeries(sn);
    }));
    $$("#presSeg button", view).forEach((b) => b.addEventListener("click", () => {
      $$("#presSeg button", view).forEach((x) => x.classList.remove("active")); b.classList.add("active");
      deviceState.presenceHours = Number(b.dataset.v); loadPresence(sn);
    }));

    loadSeries(sn);
    loadPresence(sn);
    state.refresher = () => renderDevice(sn, true);
  }

  function onlinePill(on) { return `<span class="pill ${on ? "on" : "off"}"><span class="pdot"></span>${on ? "Çevrimiçi" : "Çevrimdışı"}</span>`; }
  // Phase count derived from the model family (ADL3xx / DTS* meters are three-phase).
  function phaseInfo(model) {
    if (!model) return null;
    const m = String(model).toUpperCase();
    const threePhase = /^ADL3\d/.test(m) || /^DTS/.test(m) || /^DTZ/.test(m);
    return threePhase ? { n: 3, label: "3 Faz" } : { n: 1, label: "1 Faz" };
  }
  // Compact model cell for the device list: model code + a phase tag (1F / 3F).
  function modelCell(model) {
    if (!model) return `<span class="muted">—</span>`;
    const ph = phaseInfo(model);
    const tag = ph ? `<span class="phase-tag ph${ph.n}">${ph.n}F</span>` : "";
    return `<span class="mono">${esc(model)}</span>${tag}`;
  }
  function telemetryModeLabel(mode) {
    if (mode === "consumption") return "Tüketim izleme";
    if (mode === "analysis") return "Enerji analiz";
    return "—";
  }
  function gaugeMax(v, base) { if (v == null) return base; const n = Number(v); return n > base * 0.9 ? Math.ceil(n * 1.3) : base; }

  function commandTimeline(cmds) {
    if (!cmds || !cmds.length) return `<div class="empty">Henüz komut yok.</div>`;
    return `<div class="timeline">` + cmds.map((c) => {
      const cls = cmdClass(c.status);
      return `<div class="tl-item ${cls}">
        <div class="tl-rail"><div class="tl-dot"></div><div class="tl-line"></div></div>
        <div class="tl-body">
          <div class="tl-title">${esc(c.command_type)} <span class="pill ${cls}" style="font-size:10px">${esc(c.status)}</span></div>
          <div class="tl-meta">#${esc(String(c.id)).slice(0, 8)} · oluştur ${fmtTime(c.created_at)} · publish ${fmtTime(c.published_at)} · ACK ${fmtTime(c.ack_at)}${c.ack_latency_ms != null ? ` (${nf(c.ack_latency_ms)}ms)` : ""} · deneme ${nf(c.attempt_count)}</div>
        </div></div>`;
    }).join("") + `</div>`;
  }

  async function loadSeries(sn) {
    const area = $("#chartArea"); if (!area) return;
    let data;
    try { data = await api("GET", `/devices/${encodeURIComponent(sn)}/telemetry/series?range=${deviceState.range}`); }
    catch (e) { area.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const pts = data.points || [];
    if (!pts.length) { area.innerHTML = `<div class="empty">Bu aralıkta telemetri örneği yok. Cihaz <code>data/up update</code> mesajı gönderdikçe burada güç/gerilim trendi belirir.</div>`; return; }
    const toMs = (p) => new Date(p.t).getTime();
    const powerCur = lineChart([
      { name: "Güç (kW)", color: "var(--brand)", axis: "l", area: true, points: pts.map((p) => ({ t: toMs(p), y: p.active_power_kw })) },
      { name: "Akım (A)", color: "var(--warn)", axis: "r", points: pts.map((p) => ({ t: toMs(p), y: p.current_a })) }
    ], { height: 210 });
    const volt = lineChart([
      { name: "Gerilim (V)", color: "var(--info)", axis: "l", area: true, points: pts.map((p) => ({ t: toMs(p), y: p.voltage_v })) },
      { name: "PF", color: "var(--on)", axis: "r", points: pts.map((p) => ({ t: toMs(p), y: p.power_factor })) }
    ], { height: 180 });
    let html = `<div style="margin-bottom:6px;font-size:12px;color:var(--muted)">Güç & Akım</div>${powerCur}
      <div style="margin:14px 0 6px;font-size:12px;color:var(--muted)">Gerilim & Güç Faktörü</div>${volt}`;

    // Three-phase trend: only render the per-phase charts when L2/L3 data actually arrived
    // (analysis-mode ADL300 etc.). Single-phase devices keep the compact view above.
    const hasPhase = pts.some((p) => p.voltage_b_v != null || p.voltage_c_v != null || p.current_b_a != null || p.current_c_a != null);
    if (hasPhase) {
      const phaseVolt = lineChart([
        { name: "L1 (V)", color: "var(--info)", axis: "l", points: pts.map((p) => ({ t: toMs(p), y: p.voltage_v })) },
        { name: "L2 (V)", color: "var(--warn)", axis: "l", points: pts.map((p) => ({ t: toMs(p), y: p.voltage_b_v })) },
        { name: "L3 (V)", color: "var(--on)", axis: "l", points: pts.map((p) => ({ t: toMs(p), y: p.voltage_c_v })) }
      ], { height: 180 });
      const phaseCur = lineChart([
        { name: "L1 (A)", color: "var(--info)", axis: "l", points: pts.map((p) => ({ t: toMs(p), y: p.current_a })) },
        { name: "L2 (A)", color: "var(--warn)", axis: "l", points: pts.map((p) => ({ t: toMs(p), y: p.current_b_a })) },
        { name: "L3 (A)", color: "var(--on)", axis: "l", points: pts.map((p) => ({ t: toMs(p), y: p.current_c_a })) }
      ], { height: 180 });
      html += `<div style="margin:14px 0 6px;font-size:12px;color:var(--muted)">Faz Gerilimleri (L1 / L2 / L3)</div>${phaseVolt}
        <div style="margin:14px 0 6px;font-size:12px;color:var(--muted)">Faz Akımları (L1 / L2 / L3)</div>${phaseCur}`;
    }
    area.innerHTML = html;
  }

  async function loadPresence(sn) {
    const area = $("#presenceArea"); if (!area) return;
    let data;
    try { data = await api("GET", `/devices/${encodeURIComponent(sn)}/presence-history?hours=${deviceState.presenceHours}&window=${state.settings.onlineWindowSec}`); }
    catch (e) { area.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    area.innerHTML = presenceTimeline(data);
    // Cursor-following tooltip for segments.
    const tip = $("#presTip", area);
    $$(".pt-seg", area).forEach((seg) => {
      seg.addEventListener("mousemove", (e) => {
        if (!tip) return;
        tip.textContent = seg.dataset.tip || "";
        tip.style.display = "block";
        const r = area.getBoundingClientRect();
        tip.style.left = (e.clientX - r.left) + "px";
        tip.style.top = (e.clientY - r.top - 10) + "px";
      });
      seg.addEventListener("mouseleave", () => { if (tip) tip.style.display = "none"; });
    });
  }

  // Build an uptime timeline (status strip) from presence transitions. Green = online,
  // red = offline, gray = unknown (before the first recorded event).
  function presenceTimeline(data) {
    const start = new Date(data.since).getTime();
    const end = new Date(data.now).getTime();
    const span = Math.max(end - start, 1);
    const evs = (data.events || [])
      .map((e) => ({ status: e.status, t: new Date(e.eventAt).getTime(), source: e.source }))
      .filter((e) => e.t >= start && e.t <= end)
      .sort((a, b) => a.t - b.t);
    // Assemble [from,to,status] segments across the window.
    const segs = [];
    let cur = data.priorStatus || (evs.length ? (evs[0].status === "online" ? "offline" : "online") : "unknown");
    if (!data.priorStatus && !evs.length) cur = "unknown";
    let mark = start;
    for (const e of evs) {
      if (e.t > mark) segs.push({ from: mark, to: e.t, status: cur });
      cur = e.status; mark = e.t;
    }
    segs.push({ from: mark, to: end, status: cur });

    const fmt = (ms) => new Date(ms).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    const dur = (ms) => {
      const m = Math.round(ms / 60000);
      if (m < 60) return `${m} dk`;
      const h = Math.floor(m / 60), mm = m % 60;
      if (h < 24) return `${h} sa${mm ? " " + mm + " dk" : ""}`;
      const d = Math.floor(h / 24), hh = h % 24;
      return `${d} gün${hh ? " " + hh + " sa" : ""}`;
    };
    const stLabel = { online: "Çevrimiçi", offline: "Çevrimdışı", unknown: "Bilinmiyor" };
    let onlineMs = 0, knownMs = 0;
    const rects = segs.map((s) => {
      const w = ((s.to - s.from) / span) * 100;
      const x = ((s.from - start) / span) * 100;
      if (s.status !== "unknown") { knownMs += (s.to - s.from); if (s.status === "online") onlineMs += (s.to - s.from); }
      const tip = `${stLabel[s.status]} · ${dur(s.to - s.from)}\n${fmt(s.from)} → ${fmt(s.to)}`;
      return `<div class="pt-seg ${s.status}" style="left:${x}%;width:${w}%" data-tip="${esc(tip)}"></div>`;
    }).join("");

    // A few evenly spaced time ticks.
    const TICKS = 5;
    const ticks = Array.from({ length: TICKS + 1 }).map((_, i) => {
      const ms = start + (span * i) / TICKS;
      const lbl = span <= 36 * 3600e3
        ? new Date(ms).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })
        : new Date(ms).toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit" });
      return `<span style="flex:1;text-align:${i === 0 ? "left" : i === TICKS ? "right" : "center"}">${lbl}</span>`;
    }).join("");

    const uptime = knownMs > 0 ? Math.round((onlineMs / knownMs) * 100) : null;
    const transitions = evs.length;
    const live = !!data.online;
    const liveIco = live
      ? `<svg viewBox="0 0 24 24" class="pt-wifi"><path class="w3" d="M2.5 8.5a15 15 0 0 1 19 0"/><path class="w2" d="M5.5 12a10.5 10.5 0 0 1 13 0"/><path class="w1" d="M8.5 15.5a6 6 0 0 1 7 0"/><circle class="w0" cx="12" cy="19" r="1.4"/></svg>`
      : `<svg viewBox="0 0 24 24" class="pt-wifi"><path d="M8.5 15.5a6 6 0 0 1 7 0"/><circle cx="12" cy="19" r="1.4"/><path d="M3 3l18 18"/></svg>`;
    return `
      <div class="pt-summary">
        <span class="pt-now ${live ? "on" : "off"}">${liveIco}Şu an: ${live ? "Çevrimiçi" : "Çevrimdışı"}</span>
        <span class="pt-badge on">Çevrimiçi ${uptime != null ? "%" + uptime : "—"}</span>
        <span class="muted">${nf(transitions)} durum değişimi · son ${deviceState.presenceHours >= 24 ? (deviceState.presenceHours / 24) + " gün" : deviceState.presenceHours + " saat"}</span>
      </div>
      <div class="pt-wrap">
        <div class="pt-bar">${rects}</div>
        <div class="pt-tip" id="presTip" style="display:none"></div>
      </div>
      <div class="pt-axis">${ticks}</div>
      <div class="pt-legend">
        <span><i class="pt-dot online"></i>Çevrimiçi</span>
        <span><i class="pt-dot offline"></i>Çevrimdışı</span>
        <span><i class="pt-dot unknown"></i>Bilinmiyor</span>
      </div>
      ${transitions === 0 && !data.priorStatus ? `<div class="muted" style="margin-top:10px;font-size:12px">Bu cihaz için henüz kayıtlı durum değişimi yok. Cihaz online/offline oldukça geçmiş burada birikir.</div>` : ""}`;
  }

  async function switchAction(sn, val) {
    if (!confirm(`Cihaz ${sn} rölesi ${val ? "AÇILACAK" : "KAPATILACAK"}.\nBu fiziksel bir işlemdir. Devam edilsin mi?`)) return;
    try {
      await api("POST", `/devices/${encodeURIComponent(sn)}/commands/force-switch-${val}`);
      toast("Komut kuyruğa alındı", `Röle ${val ? "AÇ" : "KAPAT"} iradesi kaydedildi; uzlaştırıcı onay alana dek sürdürür.`, "success");
      state.activeCmd = { sn, deadline: Date.now() + commandSettleWindowMs(null) };
      lastRefreshAt = 0; // force the next tick (<=1s) into the fast cadence right away
      setTimeout(() => renderDevice(sn, true), 600);
    } catch (e) { toast("Komut hatası", e.message, "error"); }
  }
  async function clearDesired(sn) {
    try { await api("DELETE", `/devices/${encodeURIComponent(sn)}/desired/switch`); toast("İrade temizlendi", "", "success"); renderDevice(sn, true); }
    catch (e) { toast("Hata", e.message, "error"); }
  }
  async function ackAlarm(id, afterSn) {
    try {
      await api("POST", `/alarms/${encodeURIComponent(id)}/acknowledge`);
      toast("Alarm onaylandı", "", "success");
      if (afterSn) renderDevice(afterSn, true); else reloadCurrentView();
    } catch (e) { toast("Hata", e.message, "error"); }
  }
  async function refreshCmd(sn) {
    try { await api("POST", `/devices/${encodeURIComponent(sn)}/commands/refresh`); toast("Yenileme istendi", "Cihazdan güncel durum talep edildi.", "success"); state.activeCmd = { sn, deadline: Date.now() + commandSettleWindowMs(null) }; lastRefreshAt = 0; setTimeout(() => renderDevice(sn, true), 600); }
    catch (e) { toast("Hata", e.message, "error"); }
  }

  // ================================================================ CUSTOMERS
  // How a customer is connected: "panel" (uses our UI), "api" (their software via a key), or both.
  function connBadges(c) {
    const recent = c.last_api_used_at && (Date.now() - new Date(c.last_api_used_at).getTime() < 7 * 864e5);
    const out = [];
    if (c.panel_enabled) out.push(`<span class="conn-badge panel">Panel</span>`);
    if (c.active_key_count > 0) out.push(`<span class="conn-badge api ${recent ? "live" : ""}">API${recent ? " · aktif" : ""}</span>`);
    if (!out.length) out.push(`<span class="conn-badge none">Bağlı değil</span>`);
    return out.join("");
  }

  async function renderCustomers(silent) {
    let res;
    try { res = await api("GET", `/customers/overview?window=${state.settings.onlineWindowSec}`); }
    catch (e) { if (!silent) view.innerHTML = errorBox(e); return; }
    const items = res.items || [];
    const total = items.length;
    const apiCount = items.filter((c) => c.active_key_count > 0).length;
    const panelCount = items.filter((c) => c.panel_enabled).length;
    view.innerHTML = `
      <div class="page-head">
        <div><h1>Müşteriler</h1><div class="sub">${nf(total)} müşteri · ${nf(panelCount)} panel · ${nf(apiCount)} API entegrasyonu</div></div>
        <div class="head-actions"><button class="btn primary" id="cuNew"><svg viewBox="0 0 24 24" class="ic"><path d="M12 5v14M5 12h14"/></svg>Yeni müşteri</button></div>
      </div>
      <div class="panel"><div class="table-wrap"><table class="data cust-acct-table">
        <thead><tr>
          <th>Müşteri</th><th>İletişim</th><th>Kullanıcı</th><th>Kayıt</th><th>Aktivasyon</th>
          <th class="num">Sayaç</th><th class="num">Çevrimiçi</th><th>Bağlantı</th><th></th>
        </tr></thead>
        <tbody>${total ? items.map((c) => `
          <tr data-cust="${esc(c.id)}">
            <td><b>${esc(c.name)}</b></td>
            <td class="mono">${esc(c.phone || "—")}</td>
            <td class="mono">${esc(c.panel_username || "—")}</td>
            <td class="muted">${fmtDate(c.created_at)}</td>
            <td class="muted">${c.activated_at ? fmtDate(c.activated_at) : `<span class="pill off sm">bekliyor</span>`}</td>
            <td class="num">${nf(c.device_count)}</td>
            <td class="num">${c.device_count ? nf(c.online_count) : "—"}</td>
            <td>${connBadges(c)}</td>
            <td class="row-actions">
              <button class="btn sm" data-keys="${esc(c.id)}">API anahtarları${c.active_key_count ? ` (${nf(c.active_key_count)})` : ""}</button>
              <button class="btn sm ghost" data-devs="${esc(c.id)}" data-name="${esc(c.name)}">Cihazlar →</button>
            </td>
          </tr>`).join("") : `<tr><td colspan="9" class="empty">Henüz müşteri yok. “Yeni müşteri” ile ekleyin.</td></tr>`}</tbody>
      </table></div></div>`;

    $("#cuNew").addEventListener("click", openCustomerModal);
    $$("[data-keys]", view).forEach((b) => b.addEventListener("click", () => {
      const c = items.find((x) => String(x.id) === b.dataset.keys);
      if (c) openApiKeysModal(c);
    }));
    $$("[data-devs]", view).forEach((b) => b.addEventListener("click", () => {
      devicesState.project = ""; devicesState.q = ""; devicesState.status = ""; devicesState.online = ""; devicesState.page = 0;
      devicesState.customer = b.dataset.devs; devicesState.customerLabel = b.dataset.name || "";
      navigate("#/devices");
    }));
    state.refresher = renderCustomers;
  }

  function openCustomerModal() {
    modalMount.innerHTML = `
      <div class="modal-backdrop"><div class="modal lg">
        <h3>Yeni müşteri hesabı</h3>
        <p class="muted" style="margin:0 0 14px">Zorunlu alanlar (*) ile işaretlidir. Kayıt tarihi otomatik atanır; aktivasyon tarihi ilk sayaç devreye girdiğinde oluşur.</p>
        <div class="form-section-h">Müşteri bilgileri</div>
        <div class="form-grid">
          <label class="full">Ad / Unvan *<input id="cuName" placeholder="Örn. Ahmet Yılmaz veya Volt Enerji A.Ş." autocomplete="off" /></label>
          <label>İletişim numarası *<input id="cuPhone" type="tel" placeholder="05xx xxx xx xx" autocomplete="tel" /></label>
          <label>E-posta <input id="cuEmail" type="email" placeholder="(opsiyonel)" autocomplete="email" /></label>
        </div>
        <div class="form-section-h">Panel giriş hesabı</div>
        <div class="form-grid">
          <label class="check full"><input type="checkbox" id="cuPanel" checked /> <span>Müşteri panelden giriş yapacak</span></label>
          <label>Kullanıcı adı *<input id="cuUser" placeholder="örn. ahmet.yilmaz" autocomplete="off" /></label>
          <label>Parola *<input id="cuPass" type="password" placeholder="en az 8 karakter" autocomplete="new-password" /></label>
          <label>Parola (tekrar) *<input id="cuPass2" type="password" autocomplete="new-password" /></label>
        </div>
        <div class="bl-hint">Kayıt tarihi: bugün · Aktivasyon: ilk sayaç aktif olunca otomatik</div>
        <div class="modal-actions"><button class="btn" id="cuCancel">Vazgeç</button><button class="btn primary" id="cuSave">Hesabı oluştur</button></div>
      </div></div>`;
    const panelCb = $("#cuPanel");
    const panelFields = () => {
      const on = panelCb.checked;
      ["cuUser", "cuPass", "cuPass2"].forEach((id) => { const el = $("#" + id); if (el) el.closest("label").style.opacity = on ? "1" : ".45"; });
    };
    panelCb.addEventListener("change", panelFields);
    panelFields();
    $("#cuCancel").addEventListener("click", closeModal);
    $("#cuSave").addEventListener("click", async () => {
      const name = $("#cuName").value.trim();
      const phone = $("#cuPhone").value.trim();
      const panelOn = panelCb.checked;
      const username = $("#cuUser").value.trim();
      const pass = $("#cuPass").value;
      const pass2 = $("#cuPass2").value;
      if (!name) { toast("Eksik", "Ad / unvan zorunlu", "error"); return; }
      if (!phone || phone.replace(/\D/g, "").length < 10) { toast("Eksik", "Geçerli iletişim numarası zorunlu", "error"); return; }
      if (panelOn) {
        if (!username || username.length < 3) { toast("Eksik", "Kullanıcı adı zorunlu (min 3 karakter)", "error"); return; }
        if (pass.length < 8) { toast("Eksik", "Parola en az 8 karakter olmalı", "error"); return; }
        if (pass !== pass2) { toast("Eksik", "Parolalar eşleşmiyor", "error"); return; }
      }
      try {
        await api("POST", "/customers", {
          name,
          phone,
          email: $("#cuEmail").value.trim() || null,
          panelEnabled: panelOn,
          username: panelOn ? username : undefined,
          password: panelOn ? pass : undefined
        });
        toast("Müşteri oluşturuldu", name, "success");
        closeModal(); renderCustomers();
      } catch (e) {
        const map = {
          name_required: "Ad / unvan zorunlu.",
          phone_required: "Geçerli iletişim numarası zorunlu.",
          invalid_username: "Kullanıcı adı 3–32 karakter (harf, rakam, . _ -).",
          weak_password: "Parola en az 8 karakter olmalı.",
          username_taken: "Bu kullanıcı adı zaten kullanılıyor."
        };
        toast("Hata", map[e.message] || e.message, "error");
      }
    });
  }

  async function openApiKeysModal(customer) {
    const render = (keys, freshKey) => {
      modalMount.innerHTML = `
        <div class="modal-backdrop"><div class="modal lg">
          <h3>API anahtarları · ${esc(customer.name)}</h3>
          <p class="muted">Müşteri kendi yazılımını bu anahtarla bağlar. Anahtar yalnızca <strong>oluşturma anında bir kez</strong> gösterilir; sistemde yalnızca özeti (hash) saklanır.</p>
          ${freshKey ? `<div class="key-reveal">
            <div class="key-reveal-head">✓ Yeni anahtar oluşturuldu — şimdi kopyalayın, tekrar gösterilmez</div>
            <div class="key-reveal-row"><code id="freshKey">${esc(freshKey)}</code><button class="btn sm primary" id="copyKey">Kopyala</button></div>
          </div>` : ""}
          <div class="panel-inset"><div class="form-grid two">
            <label>Etiket <input id="kLabel" placeholder="Örn. Üretim entegrasyonu" /></label>
            <button class="btn primary" id="kCreate" style="align-self:end">+ Anahtar oluştur</button>
          </div></div>
          <div class="table-wrap"><table class="data">
            <thead><tr><th>Etiket</th><th>Önek</th><th>Durum</th><th>Son kullanım</th><th>Oluşturulma</th><th></th></tr></thead>
            <tbody>${keys.length ? keys.map((k) => `<tr>
              <td>${esc(k.label || "—")}</td>
              <td class="mono">${esc(k.key_prefix)}…</td>
              <td>${k.is_active ? `<span class="pill on"><span class="pdot"></span>Aktif</span>` : `<span class="pill off"><span class="pdot"></span>İptal</span>`}</td>
              <td class="muted">${k.last_used_at ? timeAgo(k.last_used_at) : "hiç"}</td>
              <td class="muted">${timeAgo(k.created_at)}</td>
              <td class="row-actions">${k.is_active ? `<button class="btn sm danger" data-revoke="${esc(k.id)}">İptal et</button>` : ""}</td>
            </tr>`).join("") : `<tr><td colspan="6" class="empty">Henüz anahtar yok.</td></tr>`}</tbody>
          </table></div>
          <div class="modal-actions"><button class="btn" id="kClose">Kapat</button></div>
        </div></div>`;
      $("#kClose").addEventListener("click", () => { closeModal(); renderCustomers(); });
      const copyBtn = $("#copyKey");
      if (copyBtn) copyBtn.addEventListener("click", () => {
        const t = $("#freshKey").textContent;
        navigator.clipboard?.writeText(t).then(() => toast("Kopyalandı", "Anahtar panoya kopyalandı", "success"))
          .catch(() => toast("Kopyalanamadı", "Elle seçip kopyalayın", "error"));
      });
      $("#kCreate").addEventListener("click", async () => {
        const label = $("#kLabel").value.trim() || null;
        try {
          const created = await api("POST", `/customers/${encodeURIComponent(customer.id)}/api-keys`, { label });
          const list = await api("GET", `/customers/${encodeURIComponent(customer.id)}/api-keys`);
          render(list.items || [], created.key);
        } catch (e) { toast("Hata", e.message, "error"); }
      });
      $$("[data-revoke]", modalMount).forEach((b) => b.addEventListener("click", async () => {
        if (!confirm("Bu anahtar iptal edilsin mi? Bu anahtarı kullanan entegrasyon erişimini kaybeder.")) return;
        try {
          await api("POST", `/api-keys/${encodeURIComponent(b.dataset.revoke)}/revoke`);
          const list = await api("GET", `/customers/${encodeURIComponent(customer.id)}/api-keys`);
          toast("İptal edildi", "Anahtar devre dışı", "success");
          render(list.items || [], null);
        } catch (e) { toast("Hata", e.message, "error"); }
      }));
    };
    try {
      const list = await api("GET", `/customers/${encodeURIComponent(customer.id)}/api-keys`);
      render(list.items || [], null);
    } catch (e) { toast("Hata", e.message, "error"); }
  }

  // ================================================================ BILLING (cost chargeback)
  const CUR_SYM = { USD: "$", EUR: "€", TRY: "₺" };
  function curSym() { return CUR_SYM[state.settings.billing.currency] || ""; }
  function money(n) {
    const v = Number.isFinite(n) ? n : 0;
    return `${curSym()}${v.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  function fmtBytes(n) {
    const v = Number.isFinite(n) ? n : 0;
    if (v < 1024) return `${Math.round(v)} B`;
    const u = ["KB", "MB", "GB", "TB"];
    let x = v / 1024, i = 0;
    while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
    return `${x.toLocaleString("tr-TR", { maximumFractionDigits: x < 10 ? 1 : 0 })} ${u[i]}`;
  }
  function defaultPeriod() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  const TELE_MODE_LABEL = { consumption: "Tüketim", analysis: "Analiz" };
  const billingState = { period: defaultPeriod() };

  async function renderBilling(silent) {
    if (!isAdmin()) {
      view.innerHTML = `<div class="page-head"><div><h1>Maliyet & Faturalandırma</h1></div></div>
        <div class="panel"><div class="empty">Bu sayfa yalnızca yöneticiler içindir.</div></div>`;
      return;
    }
    let cfg, aws;
    try {
      cfg = await api("GET", "/billing/config").catch(() => state.settings.billing);
    } catch (e) { if (!silent) view.innerHTML = errorBox(e); return; }
    // Config lives server-side now (shared across devices); cache locally for instant first paint.
    const b = Object.assign({}, state.settings.billing, cfg || {});
    state.settings.billing = b; saveSettings();
    const winDays = Number(b.usageWindowDays) || 7;
    let usage;
    try {
      [usage, aws] = await Promise.all([
        api("GET", `/fleet/billing/usage?days=${winDays}&window=${state.settings.onlineWindowSec}`),
        api("GET", "/billing/aws-cost").catch(() => null)
      ]);
    } catch (e) { if (!silent) view.innerHTML = errorBox(e); return; }

    const margin = Number(b.marginPct) || 0;
    const manualCost = Number(b.monthlyCost) || 0;
    const awsOk = !!aws;
    const mtd = awsOk ? Number(aws.monthToDate) || 0 : null;
    const forecast = awsOk && aws.forecastMonthEnd != null ? Number(aws.forecastMonthEnd) : null;
    // Resolve the active basis, gracefully degrading to manual when an AWS figure is unavailable.
    let basis = b.costBasis || "manual";
    if ((basis === "actual" && mtd == null) || (basis === "forecast" && forecast == null)) basis = "manual";
    const baseFor = (bs) => bs === "actual" ? (mtd ?? manualCost) : bs === "forecast" ? (forecast ?? manualCost) : manualCost;
    const baseCost = baseFor(basis);
    const totalCharge = baseCost * (1 + margin / 100);
    const basisLabel = { manual: "Elle tanımlı", actual: "Şu an ödenecek (AWS)", forecast: "Bu ay tahmini (AWS)" };

    // Usage-weighted allocation: share ∝ monthly data volume (frequency × payload). Falls back to an
    // equal split when there's no telemetry yet, so a fresh fleet still shows sensible numbers.
    const dev = usage.items || [];
    const totalDevices = usage.totalDevices || dev.length;
    const noTraffic = usage.noTraffic || usage.totalBytes === 0;
    const weightOf = (d) => noTraffic ? 1 : (d.monthlyBytes > 0 ? d.monthlyBytes : 0);
    let sumW = dev.reduce((a, d) => a + weightOf(d), 0);
    if (sumW <= 0) sumW = dev.length || 1; // all-zero guard → equal split
    const eqW = noTraffic || dev.every((d) => weightOf(d) === 0);
    const devRows = dev.map((d) => {
      const w = eqW ? 1 : weightOf(d);
      const share = (eqW ? (dev.length ? 1 / dev.length : 0) : w / sumW);
      const costShare = baseCost * share;
      return { ...d, share, costShare, charge: costShare * (1 + margin / 100) };
    }).sort((a, c) => c.charge - a.charge);

    // Roll device rows up to project (customer + project) for the per-project table.
    const pmap = new Map();
    devRows.forEach((d) => {
      const key = (d.customerName || "~") + "||" + (d.projectName || "~");
      const p = pmap.get(key) || { customerName: d.customerName, projectName: d.projectName, devices: 0, online: 0, monthlyMsgs: 0, monthlyBytes: 0, costShare: 0, charge: 0 };
      p.devices += 1; p.online += d.online ? 1 : 0; p.monthlyMsgs += d.monthlyMsgs; p.monthlyBytes += d.monthlyBytes;
      p.costShare += d.costShare; p.charge += d.charge;
      pmap.set(key, p);
    });
    const projRows = Array.from(pmap.values()).map((p) => ({ ...p, share: baseCost > 0 ? p.costShare / baseCost : 0 })).sort((a, c) => c.charge - a.charge);

    const perDevAvg = totalDevices > 0 ? totalCharge / totalDevices : 0;
    const basisOpt = (id, label, val, enabled) => `<button data-basis="${id}" class="${basis === id ? "active" : ""}" ${enabled ? "" : "disabled"} title="${enabled ? "" : "AWS yapılandırılmamış"}">${label}<b>${val == null ? "—" : money(val)}</b></button>`;

    view.innerHTML = `
      <div class="page-head">
        <div><h1>Maliyet & Faturalandırma</h1><div class="sub">Altyapı maliyeti, her cihazın gerçek veri hacmine (yazma sıklığı × boyut) göre dağıtılır · son ${nf(winDays)} gün ölçümü · ${nf(totalDevices)} faturalanabilir cihaz</div></div>
        <div class="head-actions"><button class="btn" id="blExport"><svg viewBox="0 0 24 24" class="ic"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/></svg>CSV indir</button></div>
      </div>

      <div class="panel bl-config">
        <div class="bl-basis-row">
          <div class="bl-basis-label">Maliyet temeli</div>
          <div class="seg basis-seg" id="blBasis">
            ${basisOpt("actual", "Şu an ödenecek", mtd, awsOk)}
            ${basisOpt("forecast", "Bu ay tahmini", forecast, awsOk && forecast != null)}
            ${basisOpt("manual", "Elle", manualCost, true)}
          </div>
          <button class="btn sm ghost" id="blAws" title="AWS Cost Explorer'dan tazele"><svg viewBox="0 0 24 24" class="ic"><path d="M21 12a9 9 0 1 1-3-6.7M21 4v4h-4"/></svg>AWS tazele</button>
        </div>
        ${!awsOk ? `<div class="bl-hint">AWS rakamları için sunucuda anahtar tanımlı değil — şimdilik "Elle" kullanılıyor. <span class="muted">(.env.production)</span></div>` : `<div class="bl-hint">Kaynak: AWS Cost Explorer${aws.period ? ` · dönem ${esc(aws.period.start)} → ${esc(aws.period.end)}` : ""}. "Şu an ödenecek" = ay başından bugüne gerçekleşen; "Bu ay tahmini" = AWS ay-sonu projeksiyonu.</div>`}
        <div class="form-grid four">
          <label>Elle aylık maliyet
            <div class="in-affix"><span>${curSym()}</span><input id="blCost" type="number" min="0" step="1" value="${esc(manualCost)}" /></div>
          </label>
          <label>Kâr marjı (%)
            <input id="blMargin" type="number" min="0" step="1" value="${esc(margin)}" />
          </label>
          <label>Para birimi
            <select id="blCur">
              ${["USD", "EUR", "TRY"].map((c) => `<option value="${c}" ${b.currency === c ? "selected" : ""}>${c} (${CUR_SYM[c]})</option>`).join("")}
            </select>
          </label>
          <label>Ölçüm penceresi (gün)
            <input id="blWin" type="number" min="1" max="90" step="1" value="${esc(winDays)}" />
          </label>
        </div>
      </div>

      <div class="kpi-grid">
        <div class="kpi"><div class="kpi-top">Maliyet temeli</div><div class="kpi-val">${money(baseCost)}</div><div class="kpi-sub">${basisLabel[basis]}</div></div>
        <div class="kpi info accent"><div class="kpi-top">Toplam talep</div><div class="kpi-val accent">${money(totalCharge)}</div><div class="kpi-sub">marj %${nf(margin)} dahil</div></div>
        <div class="kpi"><div class="kpi-top">Cihaz başı (ort.)</div><div class="kpi-val">${money(perDevAvg)}</div><div class="kpi-sub">aylık ortalama</div></div>
        <div class="kpi"><div class="kpi-top">Aylık veri</div><div class="kpi-val">${fmtBytes(devRows.reduce((a, d) => a + d.monthlyBytes, 0))}</div><div class="kpi-sub">${nf(devRows.reduce((a, d) => a + d.monthlyMsgs, 0))} mesaj / ay</div></div>
      </div>

      ${eqW ? `<div class="bl-hint warn">Seçilen pencerede telemetri verisi yok — maliyet şimdilik cihazlara eşit dağıtıldı. Cihazlar veri yazmaya başlayınca dağıtım otomatik gerçek hacme göre yapılacak.</div>` : ""}

      <div class="panel">
        <div class="panel-head"><h2>Proje başına dağıtım</h2><span class="muted">${esc(billingState.period)}</span></div>
        <div class="table-wrap"><table class="data">
          <thead><tr>
            <th>Müşteri</th><th>Proje / Bina</th><th class="num">Cihaz</th><th class="num">Aylık mesaj</th><th class="num">Aylık veri</th>
            <th class="num">Pay</th><th class="num">Maliyet payı</th><th class="num">Talep tutarı</th>
          </tr></thead>
          <tbody>${projRows.length ? projRows.map((r) => `
            <tr>
              <td><b>${esc(r.customerName || "—")}</b></td>
              <td>${esc(r.projectName || "(proje atanmamış)")}</td>
              <td class="num">${nf(r.devices)}</td>
              <td class="num muted">${nf(r.monthlyMsgs)}</td>
              <td class="num muted">${fmtBytes(r.monthlyBytes)}</td>
              <td class="num">${(r.share * 100).toFixed(1)}%</td>
              <td class="num muted">${money(r.costShare)}</td>
              <td class="num"><b>${money(r.charge)}</b></td>
            </tr>`).join("") : `<tr><td colspan="8" class="empty">Faturalanabilir cihaz yok.</td></tr>`}</tbody>
          <tfoot><tr>
            <td><b>Toplam</b></td><td></td>
            <td class="num"><b>${nf(totalDevices)}</b></td>
            <td class="num"><b>${nf(projRows.reduce((a, r) => a + r.monthlyMsgs, 0))}</b></td>
            <td class="num"><b>${fmtBytes(projRows.reduce((a, r) => a + r.monthlyBytes, 0))}</b></td>
            <td class="num"><b>100%</b></td>
            <td class="num"><b>${money(baseCost)}</b></td>
            <td class="num accent"><b>${money(totalCharge)}</b></td>
          </tr></tfoot>
        </table></div>
      </div>

      <div class="panel">
        <div class="panel-head"><h2>Cihaz başına birim maliyet</h2><span class="muted">gerçek veri hacmine göre · son ${nf(winDays)} gün</span></div>
        <div class="table-wrap"><table class="data">
          <thead><tr>
            <th>Cihaz</th><th>Model</th><th>Mod</th><th class="num">Aylık mesaj</th><th class="num">Aylık veri</th>
            <th class="num">Pay</th><th class="num">Birim maliyet</th>
          </tr></thead>
          <tbody>${devRows.length ? devRows.map((d) => `
            <tr data-sn="${esc(d.sn)}">
              <td><b>${esc(d.label || d.sn)}</b>${d.label ? `<span class="mono sub-sn">${esc(d.sn)}</span>` : ""}${d.online ? `<span class="doton" title="çevrimiçi"></span>` : ""}</td>
              <td>${esc(d.model || "—")}</td>
              <td>${d.telemetryMode ? `<span class="pill sm">${esc(TELE_MODE_LABEL[d.telemetryMode] || d.telemetryMode)}</span>` : `<span class="muted">—</span>`}</td>
              <td class="num muted">${nf(d.monthlyMsgs)}</td>
              <td class="num muted">${fmtBytes(d.monthlyBytes)}</td>
              <td class="num">${(d.share * 100).toFixed(1)}%</td>
              <td class="num"><b>${money(d.charge)}</b></td>
            </tr>`).join("") : `<tr><td colspan="7" class="empty">Cihaz yok.</td></tr>`}</tbody>
        </table></div>
      </div>`;

    const saveCfg = async (patch) => {
      const next = Object.assign({}, b, patch);
      state.settings.billing = next; saveSettings();
      try { state.settings.billing = await api("PUT", "/billing/config", next); saveSettings(); }
      catch (e) { toast("Kaydedilemedi", e.message || "Sunucuya yazılamadı", "error"); }
      renderBilling(true);
    };
    $$("#blBasis [data-basis]", view).forEach((el) => el.addEventListener("click", () => {
      if (el.disabled) return;
      saveCfg({ costBasis: el.dataset.basis });
    }));
    $("#blCost").addEventListener("change", (e) => saveCfg({ monthlyCost: Math.max(0, Number(e.target.value) || 0) }));
    $("#blMargin").addEventListener("change", (e) => saveCfg({ marginPct: Math.max(0, Number(e.target.value) || 0) }));
    $("#blCur").addEventListener("change", (e) => saveCfg({ currency: e.target.value }));
    $("#blWin").addEventListener("change", (e) => saveCfg({ usageWindowDays: Math.min(90, Math.max(1, Math.round(Number(e.target.value) || 7))) }));
    $$("[data-sn]", view).forEach((el) => el.addEventListener("click", () => navigate(`#/device/${encodeURIComponent(el.dataset.sn)}`)));
    $("#blExport").addEventListener("click", () => {
      const cols = ["donem", "sn", "etiket", "model", "mod", "musteri", "proje", "aylik_mesaj", "aylik_bayt", "pay_yuzde", "maliyet_payi", "birim_maliyet", "para_birimi"];
      const lines = [cols.join(",")].concat(devRows.map((d) => [
        billingState.period, csvCell(d.sn), csvCell(d.label || ""), csvCell(d.model || ""), csvCell(d.telemetryMode || ""),
        csvCell(d.customerName || ""), csvCell(d.projectName || ""), d.monthlyMsgs, d.monthlyBytes,
        (d.share * 100).toFixed(2), d.costShare.toFixed(2), d.charge.toFixed(2), b.currency
      ].join(",")));
      lines.push(["", "TOPLAM", "", "", "", "", "", devRows.reduce((a, d) => a + d.monthlyMsgs, 0), devRows.reduce((a, d) => a + d.monthlyBytes, 0), "100.00", baseCost.toFixed(2), totalCharge.toFixed(2), b.currency].join(","));
      downloadFile(`volt4amper-birim-maliyet-${billingState.period}.csv`, lines.join("\n"));
      toast("Dışa aktarıldı", `${devRows.length} cihaz · ${billingState.period}`, "success");
    });
    $("#blAws").addEventListener("click", async () => {
      const btn = $("#blAws"); btn.disabled = true;
      try {
        const c = await api("GET", "/billing/aws-cost");
        const fc = c.forecastMonthEnd != null ? ` · ay sonu tahmini ${money(c.forecastMonthEnd)}` : "";
        toast("AWS maliyeti güncellendi", `Şu an ödenecek ${money(c.monthToDate)}${fc}`, "success", 5000);
        renderBilling(true);
      } catch (e) {
        btn.disabled = false;
        if (e.status === 503) toast("AWS yapılandırılmamış", "Sunucuda AWS anahtarı tanımlı değil (.env.production).", "warn", 6000);
        else toast("AWS'den alınamadı", (e.body && e.body.detail) || e.message || "Bilinmeyen hata", "error", 6000);
      }
    });
    state.refresher = renderBilling;
  }

  // ================================================================ ALARMS
  const alarmsState = { filter: "all" };
  async function renderAlarms(silent) {
    if (!silent) view.innerHTML = `
      <div class="page-head"><div><h1>Alarmlar & Olaylar</h1><div class="sub">komut alarmları (dikkat gerekiyor), çevrimdışı, alarm bayrağı ve borçlu sayaçlar</div></div></div>
      <div class="toolbar"><div class="seg" id="alSeg">
        <button data-v="all" class="active">Tümü</button><button data-v="cmd">Komut</button><button data-v="offline">Çevrimdışı</button>
        <button data-v="alarm">Alarm</button><button data-v="owing">Borçlu</button>
      </div></div>
      <div class="panel"><div id="alList"><div class="loading">Yükleniyor…</div></div></div>`;
    const list = $("#alList"); if (!list) return;
    let offline, alarm, owing, cmd;
    try {
      [offline, alarm, owing, cmd] = await Promise.all([
        api("GET", `/fleet/devices?online=false&limit=200&window=${state.settings.onlineWindowSec}`),
        api("GET", `/fleet/devices?alarm=true&limit=200`),
        api("GET", `/fleet/devices?owing=true&limit=200`),
        api("GET", `/alarms?status=open&limit=200`).catch(() => ({ items: [] }))
      ]);
    } catch (e) { list.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }

    const items = [];
    // Command-confirmation alarms from the device_alarms ledger (highest priority).
    (cmd.items || []).forEach((a) => items.push({
      d: { sn: a.sn, label: a.label, customer_name: a.customer_name, city: null, last_seen_at: a.raised_at },
      sev: alarmSevClass(a.severity),
      reason: alarmTypeLabel(a.alarm_type) + (a.message ? " — " + a.message : ""),
      kind: "cmd",
      alarm: a
    }));
    (alarm.items || []).forEach((d) => items.push({ d, sev: "bad", reason: "Cihaz alarm bayrağı (alarm_a/b)", kind: "alarm" }));
    (owing.items || []).forEach((d) => items.push({ d, sev: "warn", reason: "Bakiye borçlu (owe_money)", kind: "owing" }));
    (offline.items || []).forEach((d) => { if (d.registry_status !== "quarantined") items.push({ d, sev: "info", reason: `Çevrimdışı (>${state.settings.onlineWindowSec}s)`, kind: "offline" }); });

    const ICO_OFF = `<svg viewBox="0 0 24 24" class="ic"><path d="M18.4 5.6 5.6 18.4"/></svg>`;
    const ICO_AL = `<svg viewBox="0 0 24 24" class="ic"><path d="M12 9v4m0 4h.01"/></svg>`;
    const ICO_MN = `<svg viewBox="0 0 24 24" class="ic"><path d="M12 2v20"/></svg>`;

    const renderList = () => {
      const f = alarmsState.filter;
      const shown = items.filter((x) => f === "all" || x.kind === f);
      $$("#alSeg button", view).forEach((b) => b.classList.toggle("active", b.dataset.v === f));
      if (!shown.length) { list.innerHTML = `<div class="empty">Bu kategoride alarm yok. 👍</div>`; return; }
      list.innerHTML = shown.map((x) => `
        <div class="alarm-item sev-${x.sev}" data-sn="${esc(x.d.sn)}">
          <div class="a-ic">${x.kind === "offline" ? ICO_OFF : x.kind === "owing" ? ICO_MN : ICO_AL}</div>
          <div class="a-main"><div class="a-title">${esc(x.d.label || x.d.sn)}</div>
            <div class="a-sub">${esc(x.reason)} · <span class="mono">${esc(x.d.sn)}</span>${x.d.customer_name ? " · " + esc(x.d.customer_name) : ""}${x.d.city ? " · " + esc(x.d.city) : ""}</div></div>
          ${x.kind === "cmd" ? `<button class="btn xs ghost" data-ack="${esc(x.alarm.id)}">Onayla</button>` : ""}
          <div class="a-time">${timeAgo(x.d.last_seen_at)}</div>
        </div>`).join("");
      $$(".alarm-item", list).forEach((el) => el.addEventListener("click", (e) => {
        if (e.target.closest("[data-ack]")) return;
        navigate(`#/device/${encodeURIComponent(el.dataset.sn)}`);
      }));
      $$("[data-ack]", list).forEach((b) => b.addEventListener("click", (e) => {
        e.stopPropagation(); ackAlarm(b.getAttribute("data-ack"));
      }));
    };
    if (!silent) $("#alSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; alarmsState.filter = b.dataset.v; renderList(); });
    renderList();
    setAlarmBadge((cmd.items || []).length + (alarm.items || []).length + (owing.items || []).length);
    state.refresher = renderAlarms;
  }

  // ================================================================ REGISTRY HUB
  async function renderRegistry(silent) {
    await ensureLookups(true);
    view.innerHTML = `
      <div class="page-head"><div><h1>Kayıt / Filo Yönetimi</h1><div class="sub">sayaç kaydı, toplu içe aktarma, müşteri ve mülk tipleri</div></div>
        <div class="head-actions">
          <button class="btn" id="rgImport"><svg viewBox="0 0 24 24" class="ic"><path d="M12 15V3m0 0 4 4m-4-4-4 4M5 21h14"/></svg>CSV içe aktar</button>
          <button class="btn primary" id="rgNew"><svg viewBox="0 0 24 24" class="ic"><path d="M12 5v14M5 12h14"/></svg>Yeni sayaç kaydet</button>
          <button class="btn" id="rgDevices">Cihaz tablosu →</button>
        </div>
      </div>
      <div class="grid-2">
        <div class="panel">
          <div class="panel-head"><h2>Müşteriler</h2><div class="panel-actions"><button class="btn sm" id="cuAdd">+ Müşteri</button></div></div>
          <div class="table-wrap"><table class="data"><thead><tr><th>Ad</th><th>Telefon</th><th>E-posta</th></tr></thead>
          <tbody>${state.lookups.customers.length ? state.lookups.customers.map((c) => `<tr style="cursor:default"><td>${esc(c.name)}</td><td class="muted">${esc(c.phone || "—")}</td><td class="muted">${esc(c.email || "—")}</td></tr>`).join("") : `<tr><td colspan="3" class="empty">Müşteri yok.</td></tr>`}</tbody></table></div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Mülk Tipleri</h2><div class="panel-actions"><button class="btn sm" id="ptAdd">+ Tip</button></div></div>
          <div class="table-wrap"><table class="data"><thead><tr><th>Kod</th><th>Etiket</th></tr></thead>
          <tbody>${state.lookups.propertyTypes.length ? state.lookups.propertyTypes.map((p) => `<tr style="cursor:default"><td class="mono">${esc(p.code)}</td><td>${esc(p.label)}</td></tr>`).join("") : `<tr><td colspan="2" class="empty">Tip yok.</td></tr>`}</tbody></table></div>
        </div>
      </div>`;
    $("#rgNew").addEventListener("click", () => openRegisterModal(null));
    $("#rgImport").addEventListener("click", openImportModal);
    $("#rgDevices").addEventListener("click", () => navigate("#/devices"));
    $("#cuAdd").addEventListener("click", async () => {
      const name = prompt("Müşteri adı / unvanı:"); if (!name) return;
      try { await api("POST", "/customers", { name }); toast("Müşteri eklendi", name, "success"); renderRegistry(); } catch (e) { toast("Hata", e.message, "error"); }
    });
    $("#ptAdd").addEventListener("click", async () => {
      const code = prompt("Mülk tipi kodu (örn. daire):"); if (!code) return;
      const label = prompt("Etiket (örn. Daire):"); if (!label) return;
      try { await api("POST", "/property-types", { code, label }); toast("Tip eklendi", label, "success"); renderRegistry(); } catch (e) { toast("Hata", e.message, "error"); }
    });
    state.refresher = null;
  }

  // ================================================================ SETTINGS
  async function renderSettings() {
    let health = null; try { health = await api("GET", "/health"); } catch { /* */ }
    view.innerHTML = `
      <div class="page-head"><div><h1>Ayarlar</h1><div class="sub">panel tercihleri (bu tarayıcıda saklanır)</div></div></div>
      <div class="grid-2">
        <div class="panel">
          <div class="panel-head"><h2>Görünüm & Yenileme</h2></div>
          <div class="panel-pad" style="display:flex;flex-direction:column;gap:14px">
            <div class="field"><label>Tema</label>
              <div class="seg" id="setTheme"><button data-v="dark" class="${state.settings.theme === "dark" ? "active" : ""}">Koyu</button><button data-v="light" class="${state.settings.theme === "light" ? "active" : ""}">Açık</button></div>
            </div>
            <div class="field"><label>Otomatik yenileme aralığı (boştayken)</label>
              <select id="setRefresh">
                ${[10000, 30000, 60000, 120000, 300000].map((v) => `<option value="${v}" ${state.settings.refreshMs === v ? "selected" : ""}>${fmtInterval(v)}</option>`).join("")}
              </select>
              <div class="hint">Komut (aç/kapat/yenile) verildiğinde onay gelene dek otomatik olarak ${fmtInterval(FAST_REFRESH_MS)}'de bir yenilenir.</div>
            </div>
            <div class="field"><label>Çevrimiçi eşiği (saniye)</label>
              <input id="setWindow" type="number" min="30" max="3600" value="${state.settings.onlineWindowSec}" />
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Hesap & Sistem</h2></div>
          <div class="panel-pad" style="display:flex;flex-direction:column;gap:14px">
            <div class="field"><label>Oturum</label>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <span class="pill on"><span class="pdot"></span>${esc(state.user ? state.user.username : "—")}</span>
                <span class="pill">${esc(state.user ? (ROLE_LABELS[state.user.role] || state.user.role) : "")}</span>
                <button class="btn sm" id="setChangePw">Parolamı değiştir</button>
                <button class="btn sm ghost" id="setLogout">Çıkış yap</button>
              </div>
            </div>
            <div class="field"><label>API sağlığı</label>
              <div>${health ? `<span class="pill on"><span class="pdot"></span>${esc(health.status)} · ${esc(health.service)}</span>` : `<span class="pill bad"><span class="pdot"></span>erişilemiyor</span>`}</div>
            </div>
            <div class="field"><label>Klasik araçlar</label>
              <div style="display:flex;gap:10px;flex-wrap:wrap">
                <a class="btn sm ghost" href="control.html">Tekil kontrol paneli ↗</a>
                <a class="btn sm ghost" href="devices.html">Eski sayaç yönetimi ↗</a>
              </div>
            </div>
          </div>
        </div>
        ${isAdmin() ? `
        <div class="panel" style="grid-column:1/-1">
          <div class="panel-head"><h2>Kullanıcılar</h2><button class="btn sm primary" id="usrNew">+ Kullanıcı ekle</button></div>
          <div class="panel-pad"><div id="usrList" class="usr-list"><div class="loading">Yükleniyor…</div></div></div>
        </div>` : ""}
      </div>`;
    $("#setTheme").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; applyTheme(b.dataset.v); renderSettings(); });
    $("#setRefresh").addEventListener("change", (e) => { state.settings.refreshMs = Number(e.target.value); saveSettings(); toast("Kaydedildi", "Yenileme aralığı güncellendi", "success"); });
    $("#setWindow").addEventListener("change", (e) => { state.settings.onlineWindowSec = clamp(Number(e.target.value) || 300, 30, 3600); saveSettings(); toast("Kaydedildi", "Çevrimiçi eşiği güncellendi", "success"); });
    $("#setLogout").addEventListener("click", () => { if (confirm("Oturumu kapatmak istiyor musunuz?")) logout(); });
    $("#setChangePw").addEventListener("click", () => openChangePwModal());
    if (isAdmin()) { $("#usrNew").addEventListener("click", () => openUserModal(null)); loadUsers(); }
    state.refresher = null;
  }

  // ---------------------------------------------------------------- admin: users
  async function loadUsers() {
    const mount = $("#usrList"); if (!mount) return;
    try {
      const { users } = await api("GET", "/admin/users");
      if (!users.length) { mount.innerHTML = `<div class="muted">Kayıtlı kullanıcı yok.</div>`; return; }
      mount.innerHTML = `<table class="usr-tbl"><thead><tr><th>Kullanıcı</th><th>Rol</th><th>Durum</th><th>Son giriş</th><th></th></tr></thead><tbody>${
        users.map((u) => `<tr data-id="${esc(u.id)}">
          <td><strong>${esc(u.username)}</strong>${state.user && state.user.id === u.id ? ` <span class="pill sm">siz</span>` : ""}</td>
          <td>${esc(ROLE_LABELS[u.role] || u.role)}</td>
          <td>${u.is_active ? `<span class="pill on sm"><span class="pdot"></span>aktif</span>` : `<span class="pill warn sm"><span class="pdot"></span>pasif</span>`}</td>
          <td class="muted">${u.last_login_at ? timeAgo(u.last_login_at) : "—"}</td>
          <td style="text-align:right;white-space:nowrap">
            <button class="btn xs" data-act="edit">Düzenle</button>
            <button class="btn xs ghost" data-act="toggle">${u.is_active ? "Pasifleştir" : "Aktifleştir"}</button>
          </td>
        </tr>`).join("")
      }</tbody></table>`;
      mount.querySelectorAll("button[data-act]").forEach((b) => b.addEventListener("click", async (e) => {
        const tr = e.target.closest("tr"); const id = tr.dataset.id;
        const u = users.find((x) => x.id === id); if (!u) return;
        if (e.target.dataset.act === "edit") { openUserModal(u); return; }
        if (e.target.dataset.act === "toggle") {
          try { await api("PATCH", `/admin/users/${id}`, { isActive: !u.is_active }); toast("Güncellendi", u.username, "success"); loadUsers(); }
          catch (err) { toast("Hata", err.body && err.body.detail ? err.body.detail : err.message, "error"); }
        }
      }));
    } catch (e) {
      mount.innerHTML = `<div class="muted">Kullanıcılar yüklenemedi: ${esc(e.message)}</div>`;
    }
  }

  function openUserModal(u) {
    const editing = !!u;
    modalMount.innerHTML = `
      <div class="modal-backdrop"><div class="modal">
        <h3>${editing ? "Kullanıcıyı düzenle" : "Yeni kullanıcı"}</h3>
        <div class="field"><label>Kullanıcı adı</label>
          <input id="umUser" type="text" value="${editing ? esc(u.username) : ""}" ${editing ? "disabled" : ""} placeholder="3-32 karakter: harf, rakam, . _ -" autocomplete="off" />
        </div>
        <div class="field"><label>Rol</label>
          <select id="umRole">
            ${["admin", "operator", "viewer"].map((r) => `<option value="${r}" ${editing && u.role === r ? "selected" : ""}>${ROLE_LABELS[r]}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>${editing ? "Yeni parola (boş bırak = değişmez)" : "Parola"}</label>
          <input id="umPass" type="password" placeholder="en az 8 karakter" autocomplete="new-password" />
        </div>
        <div class="modal-actions"><button class="btn ghost" id="umCancel">Vazgeç</button><button class="btn primary" id="umSave">Kaydet</button></div>
      </div></div>`;
    $("#umCancel").addEventListener("click", closeModal);
    $("#umSave").addEventListener("click", async () => {
      const role = $("#umRole").value;
      const pass = $("#umPass").value;
      try {
        if (editing) {
          const patch = { role };
          if (pass) patch.password = pass;
          await api("PATCH", `/admin/users/${u.id}`, patch);
          toast("Güncellendi", u.username, "success");
        } else {
          const username = $("#umUser").value.trim();
          if (!username) { toast("Eksik", "Kullanıcı adı gerekli", "warn"); return; }
          if (!pass || pass.length < 8) { toast("Zayıf parola", "En az 8 karakter", "warn"); return; }
          await api("POST", "/admin/users", { username, password: pass, role });
          toast("Kullanıcı eklendi", username, "success");
        }
        closeModal(); loadUsers();
      } catch (err) {
        const map = { username_taken: "Bu kullanıcı adı zaten var.", invalid_username: "Geçersiz kullanıcı adı.", weak_password: "Parola en az 8 karakter olmalı.", last_admin: "Son aktif yöneticiyi değiştiremezsiniz." };
        toast("Hata", map[err.body && err.body.error] || (err.body && err.body.detail) || err.message, "error");
      }
    });
  }

  function openChangePwModal() {
    modalMount.innerHTML = `
      <div class="modal-backdrop"><div class="modal">
        <h3>Parolamı değiştir</h3>
        <div class="field"><label>Mevcut parola</label><input id="cpCur" type="password" autocomplete="current-password" /></div>
        <div class="field"><label>Yeni parola</label><input id="cpPass" type="password" placeholder="en az 8 karakter" autocomplete="new-password" /></div>
        <div class="field"><label>Yeni parola (tekrar)</label><input id="cpPass2" type="password" autocomplete="new-password" /></div>
        <div class="modal-actions"><button class="btn ghost" id="cpCancel">Vazgeç</button><button class="btn primary" id="cpSave">Kaydet</button></div>
      </div></div>`;
    $("#cpCancel").addEventListener("click", closeModal);
    $("#cpSave").addEventListener("click", async () => {
      const cur = $("#cpCur").value, p1 = $("#cpPass").value, p2 = $("#cpPass2").value;
      if (!cur) { toast("Eksik", "Mevcut parola gerekli", "warn"); return; }
      if (!p1 || p1.length < 8) { toast("Zayıf parola", "En az 8 karakter", "warn"); return; }
      if (p1 !== p2) { toast("Eşleşmiyor", "Parolalar aynı değil", "warn"); return; }
      try {
        await api("POST", "/auth/password", { currentPassword: cur, newPassword: p1 });
        toast("Parola güncellendi", "Bir sonraki girişte geçerli", "success");
        closeModal();
      } catch (err) {
        const map = { invalid_current_password: "Mevcut parola hatalı.", weak_password: "Parola en az 8 karakter olmalı." };
        toast("Hata", map[err.body && err.body.error] || err.message, "error");
      }
    });
  }

  function setAlarmBadge(n) {
    const b = $("#navAlarmBadge"); if (!b) return;
    if (n > 0) { b.hidden = false; b.textContent = n > 99 ? "99+" : String(n); } else b.hidden = true;
  }

  // ================================================================ FORMS (modals)
  const modalMount = $("#modalMount");
  function closeModal() { modalMount.innerHTML = ""; }
  modalMount.addEventListener("click", (e) => { if (e.target.classList.contains("modal-backdrop")) closeModal(); });

  async function approveDevice(sn, after) {
    try {
      await api("POST", `/registry/devices/${encodeURIComponent(sn)}/approve`);
      toast("Onaylandı", `${sn} whitelist'e alındı`, "success");
      if (after) after();
    } catch (err) {
      if (err.status === 422 && err.body && Array.isArray(err.body.missing)) {
        toast("Onay engellendi", `${err.body.message || "Zorunlu bilgiler eksik."} Eksik: ${err.body.missing.join(", ")}`, "error");
        const reg = await api("GET", `/registry/devices/${encodeURIComponent(sn)}`).catch(() => null);
        openRegisterModal(reg || { sn });
      } else {
        toast("Onay hatası", err.message, "error");
      }
    }
  }

  async function openRegisterModal(row) {
    await ensureLookups();
    const editing = !!row;
    const cuOpts = `<option value="">— yok —</option>` + state.lookups.customers.map((c) => `<option value="${esc(c.id)}" ${row && row.customer_id == c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
    const ptOpts = `<option value="">— seçin —</option>` + state.lookups.propertyTypes.map((p) => `<option value="${esc(p.id)}" ${row && row.property_type_id == p.id ? "selected" : ""}>${esc(p.label)}</option>`).join("");
    const tmCur = (row && row.telemetry_mode) ? row.telemetry_mode : "consumption";
    const tmOpts = [["consumption", "Tüketim izleme (voltaj · akım · enerji)"], ["analysis", "Enerji analiz (+ güç · güç faktörü)"]]
      .map(([val, lbl]) => `<option value="${val}" ${tmCur === val ? "selected" : ""}>${lbl}</option>`).join("");
    const v = (k) => esc((row && row[k] != null) ? row[k] : "");
    modalMount.innerHTML = `
      <div class="modal-backdrop"><div class="modal lg">
        <h3>${editing ? "Sayaç düzenle: " + esc(row.sn) : "Yeni sayaç kaydet"}</h3>
        <p class="muted">Kayıtlı (registered) cihazlar whitelist'e girer ve yönetilir. Yalnızca dolu alanlar güncellenir. <strong>*</strong> ile işaretli alanlar cihaz <strong>onaylanmadan</strong> önce zorunludur.</p>
        <div class="form-grid">
          <div class="field"><label>SN *</label><input id="rf_sn" value="${v("sn")}" ${editing ? "disabled" : ""} /></div>
          <div class="field"><label>Etiket / Ad</label><input id="rf_label" value="${v("label")}" /></div>
          <div class="field"><label>Yerleşke</label><input id="rf_site_name" value="${v("site_name")}" placeholder="örn. Mavişehir Sitesi" /></div>
          <div class="field"><label>Bina / Proje adı</label><input id="rf_project_name" value="${v("project_name")}" placeholder="örn. A Blok / SavasEvi" /></div>
          <div class="field"><label>Abone / Sözleşme No *</label><input id="rf_subscriber_no" value="${v("subscriber_no")}" /></div>
          <div class="field"><label>Müşteri (kimin adına) *</label><select id="rf_customer_id">${cuOpts}</select></div>
          <div class="field"><label>Mülk tipi *</label><select id="rf_property_type_id">${ptOpts}</select></div>
          <div class="field"><label>İzleme tipi</label><select id="rf_telemetry_mode">${tmOpts}</select></div>
          <div class="field"><label>Ürün anahtarı</label><input id="rf_product_key" value="${v("product_key")}" /></div>
          <div class="field"><label>Tarife</label><input id="rf_tariff" value="${v("tariff")}" /></div>
          <div class="field"><label>Bölge</label><input id="rf_region" value="${v("region")}" /></div>
          <div class="field"><label>Bayi</label><input id="rf_dealer" value="${v("dealer")}" /></div>
          <div class="field full"><label>Adres</label><input id="rf_address_line" value="${v("address_line")}" /></div>
          <div class="field"><label>İlçe</label><input id="rf_district" value="${v("district")}" /></div>
          <div class="field"><label>İl *</label><input id="rf_city" value="${v("city")}" /></div>
          <div class="field"><label>Kurulum tarihi</label><input id="rf_install_date" type="date" value="${row && row.install_date ? String(row.install_date).slice(0, 10) : ""}" /></div>
          <div class="field"><label>Enlem</label><input id="rf_lat" type="number" step="any" value="${v("lat")}" /></div>
          <div class="field"><label>Boylam</label><input id="rf_lng" type="number" step="any" value="${v("lng")}" /></div>
          <div class="field full"><label>Not</label><textarea id="rf_notes" rows="2">${v("notes")}</textarea></div>
        </div>
        <div class="modal-actions"><button class="btn ghost" id="rfCancel">Vazgeç</button><button class="btn primary" id="rfSave">Kaydet</button></div>
      </div></div>`;
    $("#rfCancel").addEventListener("click", closeModal);
    $("#rfSave").addEventListener("click", async () => {
      const t = (id) => { const el = $("#" + id); const s = (el.value || "").trim(); return s === "" ? undefined : s; };
      const num = (id) => { const s = t(id); return s === undefined ? undefined : Number(s); };
      const sn = ($("#rf_sn").value || "").trim();
      if (!sn) { toast("SN gerekli", "", "warn"); return; }
      const bodyObj = {
        sn, label: t("rf_label"), project_name: t("rf_project_name"), site_name: t("rf_site_name"), subscriber_no: t("rf_subscriber_no"),
        customer_id: t("rf_customer_id"), property_type_id: num("rf_property_type_id"),
        product_key: t("rf_product_key"), telemetry_mode: t("rf_telemetry_mode"),
        tariff: t("rf_tariff"), region: t("rf_region"), dealer: t("rf_dealer"),
        address_line: t("rf_address_line"), district: t("rf_district"), city: t("rf_city"),
        install_date: t("rf_install_date"), lat: num("rf_lat"), lng: num("rf_lng"), notes: t("rf_notes")
      };
      try {
        if (editing) await api("PATCH", `/registry/devices/${encodeURIComponent(sn)}`, bodyObj);
        else await api("POST", "/registry/devices", bodyObj);
        toast("Kaydedildi", sn, "success"); closeModal(); reloadCurrentView();
      } catch (e) { toast("Kayıt hatası", e.message, "error"); }
    });
  }

  function openImportModal() {
    modalMount.innerHTML = `
      <div class="modal-backdrop"><div class="modal lg">
        <h3>CSV içe aktarma</h3>
        <p class="muted">Başlık satırı zorunlu. Kolonlar: <code>sn</code> (zorunlu), <code>label</code>, <code>site_name</code> (yerleşke), <code>project_name</code> (bina), <code>subscriber_no</code>, <code>property_type_code</code> (ev/daire/yurt/dukkan/ofis/fabrika/diger), <code>customer_id</code>, <code>address_line</code>, <code>district</code>, <code>city</code>, <code>tariff</code>, <code>region</code>, <code>dealer</code>, <code>install_date</code>, <code>notes</code>.</p>
        <textarea id="imText" rows="8" style="width:100%" placeholder="sn,label,subscriber_no,property_type_code&#10;24042809890002,Daire 3,ABN-1001,daire"></textarea>
        <div style="display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap">
          <input id="imFile" type="file" accept=".csv,text/csv" />
          <span class="muted" id="imResult"></span>
        </div>
        <div class="modal-actions"><button class="btn ghost" id="imCancel">Kapat</button><button class="btn primary" id="imDo">İçe aktar</button></div>
      </div></div>`;
    $("#imCancel").addEventListener("click", closeModal);
    $("#imFile").addEventListener("change", async (e) => { const f = e.target.files[0]; if (f) $("#imText").value = await f.text(); });
    $("#imDo").addEventListener("click", async () => {
      const text = ($("#imText").value || "").trim(); if (!text) { toast("CSV boş", "", "warn"); return; }
      try {
        const r = await api("POST", "/registry/devices/import", text, { asText: true });
        $("#imResult").textContent = `Toplam ${r.total}, başarılı ${r.ok}, hatalı ${(r.rejected || r.failed || []).length}`;
        toast("İçe aktarıldı", `${r.ok}/${r.total} başarılı`, "success");
        reloadCurrentView();
      } catch (e) { toast("İçe aktarma hatası", e.message, "error"); }
    });
  }

  function errorBox(e) {
    const unauth = e && e.status === 401;
    const forbidden = e && e.status === 403;
    const title = unauth ? "Oturum gerekli" : forbidden ? "Yetki yok" : "Bir şeyler ters gitti";
    const msg = unauth ? "Lütfen giriş yapın." : forbidden ? "Bu işlem için yetkiniz yok." : ((e && e.message) || "Bilinmeyen hata");
    return `<div class="panel panel-pad" style="text-align:center">
      <h2 style="margin:0 0 8px">${title}</h2>
      <p class="muted">${esc(msg)}</p>
    </div>`;
  }

  // ================================================================ ROUTER
  function parseHash() {
    const raw = (location.hash || "#/overview").replace(/^#\/?/, "");
    const parts = raw.split("/").filter(Boolean);
    const name = parts.shift() || "overview";
    return { name, param: parts.length ? decodeURIComponent(parts.join("/")) : null, query: {} };
  }
  function navigate(hash) { if (location.hash === hash) router(); else location.hash = hash; }
  function reloadCurrentView() { router(); }

  const NAV = { overview: "overview", devices: "devices", device: "devices", customers: "customers", billing: "billing", alarms: "alarms", registry: "registry", settings: "settings" };
  function setNavActive(name) {
    const target = NAV[name] || "overview";
    $$(".nav-item").forEach((a) => a.classList.toggle("active", a.dataset.route === target));
  }

  async function router() {
    const r = parseHash();
    state.route = r;
    state.refresher = null;
    // Leaving the device that has a fast-polling command in flight → drop back to idle cadence.
    if (state.activeCmd && !(r.name === "device" && r.param === state.activeCmd.sn)) state.activeCmd = null;
    setNavActive(r.name);
    // play the enter transition only on real navigation (not silent auto-refresh)
    view.classList.add("route-enter");
    clearTimeout(routeAnimTimer);
    routeAnimTimer = setTimeout(() => view.classList.remove("route-enter"), 420);
    try {
      switch (r.name) {
        case "overview": await renderOverview(); break;
        case "devices": await renderDevices(); break;
        case "customers": await renderCustomers(); break;
        case "billing": await renderBilling(); break;
        case "device": if (r.param) await renderDevice(r.param); else navigate("#/devices"); break;
        case "alarms": await renderAlarms(); break;
        case "registry": await renderRegistry(); break;
        case "settings": await renderSettings(); break;
        default: navigate("#/overview");
      }
    } catch (e) {
      if (e && e.status === 401) view.innerHTML = errorBox(e);
      else view.innerHTML = errorBox(e || { message: "Beklenmeyen hata" });
    }
  }
  window.addEventListener("hashchange", router);

  // -------- self-scheduling auto refresh (respects current settings + tab visibility)
  // Fixed 1s tick that only actually refreshes when the per-view cadence (idle vs. fast burst)
  // says it is due. Keeping the timer granularity decoupled from the cadence lets a freshly
  // issued command speed things up immediately instead of waiting out a long idle interval.
  (function scheduleRefresh() {
    setTimeout(async () => {
      const now = Date.now();
      if (document.visibilityState === "visible" && typeof state.refresher === "function"
        && now - lastRefreshAt >= currentRefreshMs()) {
        lastRefreshAt = now;
        try { await state.refresher(true); } catch { /* ignore transient */ }
      }
      scheduleRefresh();
    }, 1000);
  })();

  // -------- topbar interactions
  $("#refreshBtn").addEventListener("click", () => { router(); toast("Yenilendi", "", "success", 1500); });
  const globalSearch = $("#globalSearch");
  if (globalSearch) {
    globalSearch.addEventListener("input", debounce((e) => {
      const q = e.target.value.trim();
      devicesState.q = q; devicesState.page = 0;
      if (state.route.name !== "devices") navigate("#/devices");
      else { const ds = $("#devSearch"); if (ds) ds.value = q; loadDevices(); }
    }, 350));
    globalSearch.addEventListener("keydown", (e) => { if (e.key === "Enter" && state.route.name !== "devices") navigate("#/devices"); });
  }

  // -------- iPad-style floating dock nav (toggled from the topbar; stays open across tabs)
  const sidebar = $("#sidebar");
  const menuToggle = $("#menuToggle");
  function setMenu(open) {
    sidebar.classList.toggle("open", open);
    document.body.classList.toggle("dock-open", open);
    menuToggle.classList.toggle("active", open);
    menuToggle.setAttribute("aria-expanded", open ? "true" : "false");
    menuToggle.textContent = open ? "✕" : "☰";
  }
  function closeSidebar() { setMenu(false); }
  menuToggle.addEventListener("click", () => setMenu(!sidebar.classList.contains("open")));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSidebar(); });

  // -------- session bootstrap
  async function ensureAuth() {
    if (!state.token) { showLogin(); return false; }
    try {
      const me = await api("GET", "/auth/me", undefined, { silent401: true });
      setSession(state.token, { id: me.id, username: me.username, role: me.role });
      hideLogin();
      return true;
    } catch {
      clearSession();
      showLogin();
      return false;
    }
  }

  // -------- boot
  (async () => {
    renderUserChip();
    setConn(false, "bağlanıyor…");
    if (!location.hash) location.hash = "#/overview";
    if (await ensureAuth()) router();
  })();
})();

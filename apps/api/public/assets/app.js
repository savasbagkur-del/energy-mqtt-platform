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
  const defaultSettings = { refreshMs: 5000, onlineWindowSec: 300, theme: "light", offlineAlarmMin: 15, themeRev: THEME_REV };

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
    lookups: { customers: [], propertyTypes: [], loaded: false },
    lastOverview: null
  };

  function loadSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      const merged = Object.assign({}, defaultSettings, raw);
      // One-time migration: snap to the new light default if the saved prefs predate it.
      if (merged.themeRev !== THEME_REV) { merged.theme = "light"; merged.themeRev = THEME_REV; }
      return merged;
    } catch { return Object.assign({}, defaultSettings); }
  }
  function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); }

  // ---------------------------------------------------------------- dom utils
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const view = $("#view");

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
    loginScreen.hidden = false;
    $("#userChip").hidden = true;
    setTimeout(() => { const u = $("#loginUser"); if (u) u.focus(); }, 40);
  }
  function hideLogin() { loginScreen.hidden = true; }

  function renderUserChip() {
    const chip = $("#userChip");
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
    const ok = ["verified_success", "verified_success_with_late_confirmation"];
    const bad = ["failed", "delivery_timeout", "expired", "verified_mismatch", "cancelled"];
    if (ok.includes(status)) return "ok";
    if (bad.includes(status)) return "bad";
    return "pend";
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
  async function renderOverview(silent) {
    if (!silent) view.innerHTML = `<div class="loading">Filo özeti yükleniyor…</div>`;
    let ov, offline, alarms, owing;
    try {
      [ov, offline, alarms, owing] = await Promise.all([
        api("GET", `/fleet/overview?window=${state.settings.onlineWindowSec}`),
        api("GET", `/fleet/devices?online=false&limit=6&window=${state.settings.onlineWindowSec}`).catch(() => ({ items: [] })),
        api("GET", `/fleet/devices?alarm=true&limit=6`).catch(() => ({ items: [] })),
        api("GET", `/fleet/devices?owing=true&limit=6`).catch(() => ({ items: [] }))
      ]);
    } catch (e) { if (!silent) view.innerHTML = errorBox(e); return; }
    state.lastOverview = ov;
    setAlarmBadge(ov.alarms + ov.owing);

    const kpi = (cls, ic, label, val, unitTxt, sub) => `
      <div class="kpi ${cls}">
        <div class="kpi-top"><span>${label}</span><span class="kpi-ic">${ic}</span></div>
        <div class="kpi-val">${val}${unitTxt ? `<small>${unitTxt}</small>` : ""}</div>
        <div class="kpi-sub">${sub || ""}</div>
      </div>`;
    const ICO = {
      meter: `<svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="12" r="9"/><path d="M12 12 8 8"/></svg>`,
      online: `<svg viewBox="0 0 24 24" class="ic"><path d="M5 12.5 9 16l10-9"/></svg>`,
      offline: `<svg viewBox="0 0 24 24" class="ic"><path d="M18.4 5.6 5.6 18.4M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z"/></svg>`,
      bolt: `<svg viewBox="0 0 24 24" class="ic"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>`,
      energy: `<svg viewBox="0 0 24 24" class="ic"><path d="M3 17l5-6 4 3 5-7M3 21h18"/></svg>`,
      alarm: `<svg viewBox="0 0 24 24" class="ic"><path d="M12 9v4m0 4h.01M10.3 4.3 2.4 18a1 1 0 0 0 .9 1.5h17.4a1 1 0 0 0 .9-1.5L13.7 4.3a1 1 0 0 0-1.7 0Z"/></svg>`,
      money: `<svg viewBox="0 0 24 24" class="ic"><path d="M12 2v20M16 6.5C16 5 14.2 4 12 4S8 5 8 6.7s1.8 2.3 4 2.8 4 1.3 4 3-1.8 2.7-4 2.7-4-1-4-2.5"/></svg>`,
      shield: `<svg viewBox="0 0 24 24" class="ic"><path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3Z"/></svg>`
    };
    const pctOnline = ov.managed ? Math.round((ov.online / ov.managed) * 100) : 0;

    const kpis = [
      kpi("accent", ICO.meter, "Toplam Sayaç", nf(ov.total), "", `${nf(ov.managed)} yönetilen · ${nf(ov.new24h)} yeni (24s)`),
      kpi("good", ICO.online, "Çevrimiçi", nf(ov.online), "", `yönetilenlerin %${pctOnline}'i`),
      kpi(ov.offline ? "bad" : "", ICO.offline, "Çevrimdışı", nf(ov.offline), "", `${state.settings.onlineWindowSec}s eşik`),
      kpi("accent", ICO.bolt, "Anlık Toplam Güç", nf(ov.totalActivePowerKw, 2), "kW", `çevrimiçi sayaçlar`),
      kpi("accent", ICO.energy, "Toplam Enerji", nf(ov.totalEnergyKwh, 1), "kWh", `kümülatif endeks`),
      kpi(ov.alarms ? "warn" : "", ICO.alarm, "Aktif Alarm", nf(ov.alarms), "", `cihazda alarm bayrağı`),
      kpi(ov.owing ? "warn" : "", ICO.money, "Borçlu Sayaç", nf(ov.owing), "", `bakiye < 0`),
      kpi(ov.quarantined ? "bad" : "", ICO.shield, "Karantina", nf(ov.quarantined), "", `onay bekliyor`)
    ].join("");

    // attention list (dedup by sn, severity-ordered)
    const att = new Map();
    (alarms.items || []).forEach((d) => att.set(d.sn, { d, sev: "bad", reason: "Alarm bayrağı" }));
    (owing.items || []).forEach((d) => { if (!att.has(d.sn)) att.set(d.sn, { d, sev: "warn", reason: "Bakiye borçlu" }); });
    (offline.items || []).forEach((d) => { if (!att.has(d.sn) && d.registry_status !== "quarantined") att.set(d.sn, { d, sev: "info", reason: "Çevrimdışı" }); });
    const attArr = Array.from(att.values()).slice(0, 8);
    const attHtml = attArr.length ? attArr.map((a) => `
      <div class="alarm-item sev-${a.sev}" data-sn="${esc(a.d.sn)}">
        <div class="a-ic">${a.sev === "bad" ? ICO.alarm : a.sev === "warn" ? ICO.money : ICO.offline}</div>
        <div class="a-main"><div class="a-title">${esc(a.d.label || a.d.sn)}</div>
          <div class="a-sub">${esc(a.reason)} · <span class="mono">${esc(a.d.sn)}</span>${a.d.city ? " · " + esc(a.d.city) : ""}</div></div>
        <div class="a-time">${timeAgo(a.d.last_seen_at)}</div>
      </div>`).join("") : `<div class="empty">Her şey yolunda — dikkat gerektiren cihaz yok.</div>`;

    const segs = [
      { label: "Çevrimiçi", value: ov.online, color: "var(--on)" },
      { label: "Çevrimdışı", value: ov.offline, color: "var(--off)" },
      { label: "Karantina", value: ov.quarantined, color: "var(--bad)" }
    ];
    const legend = segs.map((s) => `<div class="dl"><i style="background:${s.color}"></i>${s.label}<b>${nf(s.value)}</b></div>`).join("");

    view.innerHTML = `
      <div class="page-head">
        <div><h1>Genel Bakış</h1><div class="sub">Filo komuta merkezi · canlı durum (${state.settings.refreshMs / 1000}s yenileme)</div></div>
        <div class="head-actions"><button class="btn" data-go="devices">Tüm cihazlar</button></div>
      </div>
      <div class="kpi-grid">${kpis}</div>
      <div class="grid-2">
        <div class="panel">
          <div class="panel-head"><h2>Filo Durumu</h2><div class="panel-actions"><span class="pill ${ov.alarms ? "warn" : "on"}"><span class="pdot"></span>${ov.alarms ? "alarm var" : "stabil"}</span></div></div>
          <div class="panel-pad">
            <div class="donut-wrap">
              ${donut(segs, ov.total)}
              <div class="donut-legend">${legend}
                <div class="dl" style="margin-top:6px;border-top:1px solid var(--line);padding-top:8px"><i style="background:var(--brand)"></i>Röle açık<b>${nf(ov.switchOn)}</b></div>
                <div class="dl"><i style="background:var(--off)"></i>Röle kapalı<b>${nf(ov.switchOff)}</b></div>
                <div class="dl"><i style="background:var(--info)"></i>Ort. sinyal<b>${ov.avgRssi != null ? nf(ov.avgRssi, 0) : "—"}</b></div>
              </div>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Dikkat Gerektirenler</h2><div class="panel-actions"><button class="btn sm ghost" data-go="alarms">Tümü →</button></div></div>
          <div>${attHtml}</div>
        </div>
      </div>`;

    $$("[data-sn]", view).forEach((el) => el.addEventListener("click", () => navigate(`#/device/${encodeURIComponent(el.dataset.sn)}`)));
    $$("[data-go]", view).forEach((el) => el.addEventListener("click", () => navigate(`#/${el.dataset.go}`)));
    state.refresher = renderOverview;
  }

  // ================================================================ DEVICES TABLE
  const devicesState = { q: "", status: "", online: "", page: 0, pageSize: 50, total: 0 };

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
          <div class="spacer"></div>
          <input id="devSearch" placeholder="SN / etiket / müşteri / şehir ara…" style="width:280px" value="${esc(devicesState.q)}" />
        </div>
        <div class="panel"><div class="table-wrap"><table class="data" id="devTable">
          <thead><tr>
            <th>Durum</th><th>SN</th><th>Etiket</th><th>Müşteri / Konum</th>
            <th class="num">Gerilim</th><th class="num">Akım</th><th class="num">Güç</th><th class="num">PF</th>
            <th class="num">Enerji</th><th>Röle</th><th>Sinyal</th><th>Son görülme</th><th></th>
          </tr></thead>
          <tbody id="devBody"><tr><td colspan="13" class="empty">Yükleniyor…</td></tr></tbody>
        </table></div><div class="pager" id="devPager"></div></div>`;

      $("#statusSeg").addEventListener("click", (e) => segPick(e, "status"));
      $("#onlineSeg").addEventListener("click", (e) => segPick(e, "online"));
      $("#devSearch").addEventListener("input", debounce((e) => { devicesState.q = e.target.value.trim(); devicesState.page = 0; loadDevices(); }, 300));
      $("#devNew").addEventListener("click", () => openRegisterModal(null));
      $("#devImport").addEventListener("click", openImportModal);
      $("#devExport").addEventListener("click", exportDevicesCsv);
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
    p.set("window", state.settings.onlineWindowSec);
    p.set("limit", devicesState.pageSize);
    p.set("offset", devicesState.page * devicesState.pageSize);
    return p.toString();
  }

  async function loadDevices(silent) {
    const body = $("#devBody"); if (!body) return;
    let res;
    try { res = await api("GET", `/fleet/devices?${buildDevicesQuery()}`); }
    catch (e) { body.innerHTML = `<tr><td colspan="13" class="empty">${esc(e.message)}</td></tr>`; return; }
    devicesState.total = res.total;
    const cnt = $("#devCount"); if (cnt) cnt.textContent = `${nf(res.total)} cihaz`;
    if (!res.items.length) { body.innerHTML = `<tr><td colspan="13" class="empty">Eşleşen cihaz yok.</td></tr>`; }
    else body.innerHTML = res.items.map((d) => {
      const approve = d.registry_status === "quarantined" ? `<button class="btn sm warn" data-approve="${esc(d.sn)}">Onayla</button>` : "";
      const pwr = d.active_power_kw;
      return `<tr data-sn="${esc(d.sn)}">
        <td>${onlineDot(d.online)}</td>
        <td class="mono">${esc(d.sn)}</td>
        <td>${esc(d.label || "—")} ${d.registry_status === "quarantined" ? statusPill("quarantined") : ""}</td>
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
      try { await api("POST", `/registry/devices/${encodeURIComponent(b.dataset.approve)}/approve`); toast("Onaylandı", `${b.dataset.approve} whitelist'e alındı`, "success"); loadDevices(true); }
      catch (err) { toast("Onay hatası", err.message, "error"); }
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
  const deviceState = { sn: null, range: "24h" };

  // builders for the live (auto-refreshed) regions — kept separate so silent refresh updates
  // only these slots and never disturbs the trend chart or rebinds static controls.
  function relayHtml(sw) {
    const cls = sw === "on" ? "on" : sw === "off" ? "off" : "unknown";
    const txt = sw === "on" ? "AÇIK" : sw === "off" ? "KAPALI" : "BİLİNMİYOR";
    return `<div class="relay-badge ${cls}"><div class="rb-state">${txt}</div><div class="rb-sub">röle (decode)</div></div>`;
  }
  function desiredHtml(cv) {
    const d = cv && cv.desired;
    return d ? `<div class="kv" style="margin-top:14px">
        <dt>İrade durumu</dt><dd><span class="pill ${cmdClass(d.reconcile_status)}">${esc(d.reconcile_status)}</span></dd>
        <dt>Hedef</dt><dd class="mono">${esc(JSON.stringify(d.desired_value))}</dd>
        <dt>Deneme</dt><dd>${nf(d.attempt_count)}</dd>
      </div>` : `<div class="muted" style="margin-top:14px">Aktif irade yok — röle bildirilen durumda.</div>`;
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
  function pillsHtml(online, m, reg) {
    const owe = m.owe_money, alarmFlag = (m.alarm_a && m.alarm_a > 0) || (m.alarm_b && m.alarm_b > 0);
    return `${reg ? statusPill(reg.registry_status) : ""}${onlinePill(online)}${alarmFlag ? `<span class="pill bad"><span class="pdot"></span>ALARM</span>` : ""}${owe > 0 ? `<span class="pill warn"><span class="pdot"></span>BORÇLU</span>` : ""}`;
  }

  function applyDeviceDynamic(tel, cv, reg) {
    const m = tel || {};
    const sw = cv ? cv.switchDecoded : (m.switch_state === 1 ? "on" : m.switch_state === 0 ? "off" : "unknown");
    const lastSeen = (cv && cv.lastSeen) || m.last_seen_at || (reg && reg.last_seen_at) || null;
    const online = cv ? cv.onlineFresh : (lastSeen ? (Date.now() - new Date(lastSeen).getTime() < state.settings.onlineWindowSec * 1000) : false);
    const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    set("hdrPills", pillsHtml(online, m, reg));
    set("relaySlot", relayHtml(sw));
    set("desiredSlot", desiredHtml(cv));
    set("gaugeSlot", gaugesHtml(m));
    set("metricSlot", metricsHtml(m));
    set("connSlot", connHtml(m, cv, online, lastSeen));
    set("cmdSlot", commandTimeline(cv && cv.recentCommands));
    const method = document.getElementById("lastMethodTag");
    if (method) method.textContent = cv && cv.lastMethod ? "yöntem: " + cv.lastMethod : "";
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
    view.innerHTML = `
      <div class="page-head">
        <div>
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            <button class="btn sm ghost" id="devBack">← Cihazlar</button>
            <h1 style="font-size:20px">${esc((reg && reg.label) || sn)}</h1>
            <span id="hdrPills" style="display:inline-flex;gap:8px;flex-wrap:wrap"></span>
          </div>
          <div class="sub mono">${esc(sn)}${reg && reg.customer_name ? ` · ${esc(reg.customer_name)}` : ""}${reg && (reg.address_line || reg.city) ? ` · ${esc([reg.address_line, reg.district, reg.city].filter(Boolean).join(", "))}` : ""}</div>
        </div>
        <div class="head-actions">
          <button class="btn" id="devRefreshCmd"><svg viewBox="0 0 24 24" class="ic"><path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v5h-5"/></svg>Yenile (refresh)</button>
          ${reg ? `<button class="btn" id="devEdit">Meta düzenle</button>` : ""}
        </div>
      </div>

      <div class="grid-2">
        <div style="display:flex;flex-direction:column;gap:16px">
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
            <div class="panel-head"><h2>Komut Geçmişi (gönderim → ACK)</h2></div>
            <div class="panel-pad" id="cmdSlot"></div>
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:16px">
          <div class="panel">
            <div class="panel-head"><h2>Sayaç & Bakiye</h2></div>
            <div class="panel-pad"><div class="metric-cards" id="metricSlot"></div></div>
          </div>

          <div class="panel">
            <div class="panel-head"><h2>Bağlantı & Sinyal</h2></div>
            <div class="panel-pad"><dl class="kv" id="connSlot"></dl></div>
          </div>

          ${reg ? `<div class="panel">
            <div class="panel-head"><h2>Kayıt Bilgileri</h2><div class="panel-actions"><button class="btn sm ghost" id="devEdit2">Düzenle</button></div></div>
            <div class="panel-pad">
              <dl class="kv">
                <dt>Müşteri</dt><dd>${esc(reg.customer_name || "—")}</dd>
                <dt>Abone No</dt><dd>${esc(reg.subscriber_no || "—")}</dd>
                <dt>Mülk tipi</dt><dd>${esc(reg.property_type_label || "—")}</dd>
                <dt>Adres</dt><dd>${esc([reg.address_line, reg.district, reg.city].filter(Boolean).join(", ") || "—")}</dd>
                <dt>Tarife</dt><dd>${esc(reg.tariff || "—")}</dd>
                <dt>Bölge / Bayi</dt><dd>${esc([reg.region, reg.dealer].filter(Boolean).join(" / ") || "—")}</dd>
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
    if (reg) { const open = () => openRegisterModal(reg); const e1 = $("#devEdit"), e2 = $("#devEdit2"); if (e1) e1.addEventListener("click", open); if (e2) e2.addEventListener("click", open); }
    const ap = $("#lcApprove"); if (ap) ap.addEventListener("click", async () => { try { await api("POST", `/registry/devices/${encodeURIComponent(sn)}/approve`); toast("Onaylandı", "", "success"); view.removeAttribute("data-device"); renderDevice(sn); } catch (e) { toast("Hata", e.message, "error"); } });
    const dc = $("#lcDecom"); if (dc) dc.addEventListener("click", async () => { if (!confirm("Cihaz devre dışı bırakılsın mı?")) return; try { await api("POST", `/registry/devices/${encodeURIComponent(sn)}/lifecycle`, { lifecycle: "decommissioned" }); toast("Güncellendi", "", "success"); view.removeAttribute("data-device"); renderDevice(sn); } catch (e) { toast("Hata", e.message, "error"); } });
    $$("#rangeSeg button", view).forEach((b) => b.addEventListener("click", () => {
      $$("#rangeSeg button", view).forEach((x) => x.classList.remove("active")); b.classList.add("active");
      deviceState.range = b.dataset.v; loadSeries(sn);
    }));

    loadSeries(sn);
    state.refresher = () => renderDevice(sn, true);
  }

  function onlinePill(on) { return `<span class="pill ${on ? "on" : "off"}"><span class="pdot"></span>${on ? "Çevrimiçi" : "Çevrimdışı"}</span>`; }
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
    area.innerHTML = `<div style="margin-bottom:6px;font-size:12px;color:var(--muted)">Güç & Akım</div>${powerCur}
      <div style="margin:14px 0 6px;font-size:12px;color:var(--muted)">Gerilim & Güç Faktörü</div>${volt}`;
  }

  async function switchAction(sn, val) {
    if (!confirm(`Cihaz ${sn} rölesi ${val ? "AÇILACAK" : "KAPATILACAK"}.\nBu fiziksel bir işlemdir. Devam edilsin mi?`)) return;
    try {
      await api("POST", `/devices/${encodeURIComponent(sn)}/commands/force-switch-${val}`);
      toast("Komut kuyruğa alındı", `Röle ${val ? "AÇ" : "KAPAT"} iradesi kaydedildi; uzlaştırıcı onay alana dek sürdürür.`, "success");
      setTimeout(() => renderDevice(sn, true), 600);
    } catch (e) { toast("Komut hatası", e.message, "error"); }
  }
  async function clearDesired(sn) {
    try { await api("DELETE", `/devices/${encodeURIComponent(sn)}/desired/switch`); toast("İrade temizlendi", "", "success"); renderDevice(sn, true); }
    catch (e) { toast("Hata", e.message, "error"); }
  }
  async function refreshCmd(sn) {
    try { await api("POST", `/devices/${encodeURIComponent(sn)}/commands/refresh`); toast("Yenileme istendi", "Cihazdan güncel durum talep edildi.", "success"); setTimeout(() => renderDevice(sn, true), 600); }
    catch (e) { toast("Hata", e.message, "error"); }
  }

  // ================================================================ ALARMS
  const alarmsState = { filter: "all" };
  async function renderAlarms(silent) {
    if (!silent) view.innerHTML = `
      <div class="page-head"><div><h1>Alarmlar & Olaylar</h1><div class="sub">çevrimdışı, alarm bayrağı ve borçlu sayaçlar</div></div></div>
      <div class="toolbar"><div class="seg" id="alSeg">
        <button data-v="all" class="active">Tümü</button><button data-v="offline">Çevrimdışı</button>
        <button data-v="alarm">Alarm</button><button data-v="owing">Borçlu</button>
      </div></div>
      <div class="panel"><div id="alList"><div class="loading">Yükleniyor…</div></div></div>`;
    const list = $("#alList"); if (!list) return;
    let offline, alarm, owing;
    try {
      [offline, alarm, owing] = await Promise.all([
        api("GET", `/fleet/devices?online=false&limit=200&window=${state.settings.onlineWindowSec}`),
        api("GET", `/fleet/devices?alarm=true&limit=200`),
        api("GET", `/fleet/devices?owing=true&limit=200`)
      ]);
    } catch (e) { list.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }

    const items = [];
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
          <div class="a-time">${timeAgo(x.d.last_seen_at)}</div>
        </div>`).join("");
      $$("[data-sn]", list).forEach((el) => el.addEventListener("click", () => navigate(`#/device/${encodeURIComponent(el.dataset.sn)}`)));
    };
    if (!silent) $("#alSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; alarmsState.filter = b.dataset.v; renderList(); });
    renderList();
    setAlarmBadge((alarm.items || []).length + (owing.items || []).length);
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
            <div class="field"><label>Otomatik yenileme aralığı</label>
              <select id="setRefresh">
                ${[2000, 5000, 10000, 30000, 60000].map((v) => `<option value="${v}" ${state.settings.refreshMs === v ? "selected" : ""}>${v / 1000} saniye</option>`).join("")}
              </select>
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

  async function openRegisterModal(row) {
    await ensureLookups();
    const editing = !!row;
    const cuOpts = `<option value="">— yok —</option>` + state.lookups.customers.map((c) => `<option value="${esc(c.id)}" ${row && row.customer_id == c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
    const ptOpts = `<option value="">— seçin —</option>` + state.lookups.propertyTypes.map((p) => `<option value="${esc(p.id)}" ${row && row.property_type_id == p.id ? "selected" : ""}>${esc(p.label)}</option>`).join("");
    const v = (k) => esc((row && row[k] != null) ? row[k] : "");
    modalMount.innerHTML = `
      <div class="modal-backdrop"><div class="modal lg">
        <h3>${editing ? "Sayaç düzenle: " + esc(row.sn) : "Yeni sayaç kaydet"}</h3>
        <p class="muted">Kayıtlı (registered) cihazlar whitelist'e girer ve yönetilir. Yalnızca dolu alanlar güncellenir.</p>
        <div class="form-grid">
          <div class="field"><label>SN *</label><input id="rf_sn" value="${v("sn")}" ${editing ? "disabled" : ""} /></div>
          <div class="field"><label>Etiket / Ad</label><input id="rf_label" value="${v("label")}" /></div>
          <div class="field"><label>Abone / Sözleşme No</label><input id="rf_subscriber_no" value="${v("subscriber_no")}" /></div>
          <div class="field"><label>Müşteri</label><select id="rf_customer_id">${cuOpts}</select></div>
          <div class="field"><label>Mülk tipi</label><select id="rf_property_type_id">${ptOpts}</select></div>
          <div class="field"><label>Ürün anahtarı</label><input id="rf_product_key" value="${v("product_key")}" /></div>
          <div class="field"><label>Tarife</label><input id="rf_tariff" value="${v("tariff")}" /></div>
          <div class="field"><label>Bölge</label><input id="rf_region" value="${v("region")}" /></div>
          <div class="field"><label>Bayi</label><input id="rf_dealer" value="${v("dealer")}" /></div>
          <div class="field full"><label>Adres</label><input id="rf_address_line" value="${v("address_line")}" /></div>
          <div class="field"><label>İlçe</label><input id="rf_district" value="${v("district")}" /></div>
          <div class="field"><label>İl</label><input id="rf_city" value="${v("city")}" /></div>
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
        sn, label: t("rf_label"), subscriber_no: t("rf_subscriber_no"),
        customer_id: t("rf_customer_id"), property_type_id: num("rf_property_type_id"),
        product_key: t("rf_product_key"), tariff: t("rf_tariff"), region: t("rf_region"), dealer: t("rf_dealer"),
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
        <p class="muted">Başlık satırı zorunlu. Kolonlar: <code>sn</code> (zorunlu), <code>label</code>, <code>subscriber_no</code>, <code>property_type_code</code> (ev/daire/yurt/dukkan/ofis/fabrika/diger), <code>customer_id</code>, <code>address_line</code>, <code>district</code>, <code>city</code>, <code>tariff</code>, <code>region</code>, <code>dealer</code>, <code>install_date</code>, <code>notes</code>.</p>
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

  const NAV = { overview: "overview", devices: "devices", device: "devices", alarms: "alarms", registry: "registry", settings: "settings" };
  function setNavActive(name) {
    const target = NAV[name] || "overview";
    $$(".nav-item").forEach((a) => a.classList.toggle("active", a.dataset.route === target));
  }

  async function router() {
    const r = parseHash();
    state.route = r;
    state.refresher = null;
    setNavActive(r.name);
    closeSidebar();
    try {
      switch (r.name) {
        case "overview": await renderOverview(); break;
        case "devices": await renderDevices(); break;
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
  (function scheduleRefresh() {
    setTimeout(async () => {
      if (document.visibilityState === "visible" && typeof state.refresher === "function") {
        try { await state.refresher(true); } catch { /* ignore transient */ }
      }
      scheduleRefresh();
    }, Math.max(2000, state.settings.refreshMs));
  })();

  // -------- topbar interactions
  $("#refreshBtn").addEventListener("click", () => { router(); toast("Yenilendi", "", "success", 1500); });
  $("#globalSearch").addEventListener("input", debounce((e) => {
    const q = e.target.value.trim();
    devicesState.q = q; devicesState.page = 0;
    if (state.route.name !== "devices") navigate("#/devices");
    else { const ds = $("#devSearch"); if (ds) ds.value = q; loadDevices(); }
  }, 350));
  $("#globalSearch").addEventListener("keydown", (e) => { if (e.key === "Enter" && state.route.name !== "devices") navigate("#/devices"); });

  // -------- mobile sidebar
  const sidebar = $("#sidebar");
  function closeSidebar() { sidebar.classList.remove("open"); }
  $("#menuToggle").addEventListener("click", () => sidebar.classList.toggle("open"));
  document.addEventListener("click", (e) => {
    if (window.innerWidth <= 900 && sidebar.classList.contains("open") && !sidebar.contains(e.target) && !e.target.closest("#menuToggle")) closeSidebar();
  });

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

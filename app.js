/* ============ TICKR — paper trading desk ============ */
(function () {
  "use strict";

  // ---------- Constants ----------
  const STORE_KEY = "tickr-data-v1";
  const START_CASH = 10000;
  const SEED = 0x710c27a4;
  const TICK_MS = 2000;
  const MAX_TXNS = 120;

  const STOCKS = [
    { sym: "NOVA", name: "Novaxis Aerospace", sector: "Aerospace", base: 184.2, vol: 0.030 },
    { sym: "HLX",  name: "Helixion Biotech",  sector: "Healthcare", base: 92.4,  vol: 0.034 },
    { sym: "QNT",  name: "Quantia Semiconductors", sector: "Technology", base: 267.8, vol: 0.036 },
    { sym: "ORBT", name: "Orbital Freight",   sector: "Logistics", base: 45.6,  vol: 0.024 },
    { sym: "VELD", name: "Velcore Energy",    sector: "Energy", base: 61.3,    vol: 0.028 },
    { sym: "MIRA", name: "Mirador Media",     sector: "Media", base: 128.9,   vol: 0.022 },
    { sym: "AXIO", name: "Axion Robotics",    sector: "Industrials", base: 76.5, vol: 0.032 },
    { sym: "LUME", name: "Lumefield Materials", sector: "Materials", base: 212.7, vol: 0.026 },
    { sym: "CRVE", name: "Curve Financial",   sector: "Financials", base: 33.8, vol: 0.038 },
    { sym: "TERR", name: "TerraNova Foods",   sector: "Consumer", base: 54.1,  vol: 0.018 },
    { sym: "ZEN",  name: "Zenith Cloud",      sector: "Technology", base: 158.2, vol: 0.031 },
    { sym: "PYRA", name: "Pyralis Gaming",    sector: "Entertainment", base: 88.6, vol: 0.040 },
  ];

  const TIMEFRAMES = {
    "1D": { bars: 78, stepVol: 0.0035, interval: 5 * 60 * 1000,          label: "intraday 5-minute bars" },
    "1W": { bars: 35, stepVol: 0.008,  interval: 6 * 60 * 60 * 1000,     label: "6-hour bars" },
    "1M": { bars: 30, stepVol: 0.014,  interval: 24 * 60 * 60 * 1000,    label: "daily bars" },
    "3M": { bars: 65, stepVol: 0.019,  interval: 24 * 60 * 60 * 1000,    label: "daily bars" },
    "1Y": { bars: 52, stepVol: 0.028,  interval: 7 * 24 * 60 * 60 * 1000, label: "weekly bars" },
  };

  // ---------- Deterministic PRNG ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // ---------- Market engine ----------
  // Current price per stock: deterministic from seed, identical on every visit.
  const stockBy = {};
  for (const s of STOCKS) stockBy[s.sym] = s;

  const currentPrices = {};
  for (const s of STOCKS) {
    const rng = mulberry32((SEED ^ hashStr(s.sym)) >>> 0);
    currentPrices[s.sym] = Math.round(s.base * (0.82 + rng() * 0.36) * 100) / 100;
  }

  const seriesCache = new Map();

  // Bars are generated BACKWARDS from the current price so the last bar always
  // closes at the live price, keeping every timeframe coherent.
  function barsFor(sym, tf) {
    const key = sym + "|" + tf;
    if (seriesCache.has(key)) return seriesCache.get(key);
    const cfg = TIMEFRAMES[tf];
    const stock = stockBy[sym];
    const rng = mulberry32((SEED ^ hashStr(key)) >>> 0);
    const volScale = stock.vol / 0.03;

    const closes = new Array(cfg.bars);
    closes[cfg.bars - 1] = currentPrices[sym];
    for (let i = cfg.bars - 2; i >= 0; i--) {
      const drift = (rng() - 0.5) * 2 * cfg.stepVol * volScale;
      closes[i] = Math.max(1, closes[i + 1] * (1 - drift));
    }

    const now = Date.now();
    // 1D bars follow a market session: 09:30 -> 15:55 local (78 x 5 min).
    const dayStart = new Date();
    dayStart.setHours(9, 30, 0, 0);
    const intradayBase = dayStart.getTime();
    const bars = [];
    for (let i = 0; i < cfg.bars; i++) {
      const t = tf === "1D"
        ? intradayBase + i * 5 * 60 * 1000
        : now - (cfg.bars - 1 - i) * cfg.interval;
      const close = closes[i];
      const open = i === 0 ? close * (1 + (rng() - 0.5) * cfg.stepVol * volScale) : closes[i - 1];
      const hi = Math.max(open, close) * (1 + rng() * cfg.stepVol * volScale * 0.8);
      const lo = Math.min(open, close) * (1 - rng() * cfg.stepVol * volScale * 0.8);
      const volume = Math.round((0.45 + rng() * 1.6) * 900000 * (0.6 + volScale * 0.7));
      bars.push({
        t,
        o: round2(open), h: round2(hi), l: round2(lo), c: round2(close), v: volume,
      });
    }
    seriesCache.set(key, bars);
    return bars;
  }

  // Previous close = the 1D series opens from it (first bar open).
  function prevCloseFor(sym) {
    return barsFor(sym, "1D")[0].o;
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  // ---------- State ----------
  const state = {
    cash: START_CASH,
    positions: {},            // sym -> { shares, cost }
    txns: [],                 // { id, side, sym, shares, price, total, ts }
    stars: ["NOVA", "QNT", "ZEN", "PYRA"],
    selected: "NOVA",
    timeframe: "1D",
    side: "buy",
    query: "",
    confirmOrder: null,
    resetArmed: false,
    resetTimer: null,
  };

  // Live (non-persisted) prices: start from the deterministic values, then jitter.
  const live = Object.assign({}, currentPrices);

  // ---------- DOM ----------
  const els = {};
  function cacheElements() {
    const ids = [
      "search", "cash-value", "tape", "kpis", "wl-rows", "wl-count",
      "sym-name", "sym-meta", "sym-price", "sym-change", "tf-row",
      "chart", "chart-wrap", "chart-tip", "chart-price", "chart-stats",
      "trade-sym", "trade-quote", "shares-input", "shares-minus", "shares-plus",
      "quick-row", "order-summary", "place-order", "trade-hint",
      "pos-body", "pos-note", "pos-empty", "txn-list", "txn-note", "txn-empty",
      "reset-btn", "confirm-dialog", "confirm-grid", "confirm-note",
      "confirm-cancel", "confirm-go", "toast", "live",
    ];
    for (const id of ids) els[id] = document.getElementById(id);
    els.tfBtns = Array.from(els["tf-row"].querySelectorAll(".tf-btn"));
    els.sideTabs = Array.from(document.querySelectorAll(".trade-tab"));
  }

  // ---------- Formatting ----------
  function fmtMoney(n) {
    const sign = n < 0 ? "-" : "";
    return sign + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPct(n) { return (n >= 0 ? "+" : "") + (n * 100).toFixed(2) + "%"; }
  function fmtSigned(n) { return (n >= 0 ? "+" : "-") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtVol(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
    return String(n);
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  function dayChange(sym) {
    const pc = prevCloseFor(sym);
    return (live[sym] - pc) / pc;
  }

  // ---------- Persistence ----------
  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (typeof data.cash !== "number" || typeof data.positions !== "object" || !Array.isArray(data.txns)) return false;
      state.cash = Math.max(0, data.cash);
      state.positions = {};
      for (const [sym, pos] of Object.entries(data.positions)) {
        if (stockBy[sym] && pos && Number.isFinite(pos.shares) && pos.shares > 0 && Number.isFinite(pos.cost) && pos.cost >= 0) {
          state.positions[sym] = { shares: Math.floor(pos.shares), cost: pos.cost };
        }
      }
      state.txns = data.txns.filter(t => t && stockBy[t.sym] && (t.side === "buy" || t.side === "sell")).slice(0, MAX_TXNS);
      if (Array.isArray(data.stars)) {
        state.stars = data.stars.filter(s => stockBy[s]);
      }
      if (stockBy[data.selected]) state.selected = data.selected;
      return true;
    } catch { return false; }
  }
  function persist() {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      cash: state.cash,
      positions: state.positions,
      txns: state.txns,
      stars: state.stars,
      selected: state.selected,
    }));
  }

  // ---------- Toast / live region ----------
  let toastTimer = null;
  function toast(msg) {
    els.toast.innerHTML = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2600);
  }
  function announce(msg) { els.live.textContent = msg; }

  // ---------- Market math ----------
  function positionValue() {
    let v = 0;
    for (const [sym, pos] of Object.entries(state.positions)) v += pos.shares * live[sym];
    return v;
  }
  function equity() { return state.cash + positionValue(); }
  function totalPL() {
    let pl = 0;
    for (const [sym, pos] of Object.entries(state.positions)) pl += pos.shares * live[sym] - pos.cost;
    return pl;
  }
  function dayPL() {
    let pl = 0;
    for (const [sym, pos] of Object.entries(state.positions)) pl += pos.shares * (live[sym] - prevCloseFor(sym));
    return pl;
  }
  function investedCost() {
    let c = 0;
    for (const pos of Object.values(state.positions)) c += pos.cost;
    return c;
  }

  // ---------- KPIs ----------
  function renderKPIs() {
    const eq = equity();
    const dpl = dayPL();
    const tpl = totalPL();
    const cost = investedCost();
    const tplPct = cost > 0 ? tpl / cost : 0;
    const cards = [
      { label: "Total equity", value: fmtMoney(eq), cls: "", sub: `Cash <b>${fmtMoney(state.cash)}</b> · Stock <b>${fmtMoney(positionValue())}</b>` },
      { label: "Day's P/L", value: fmtSigned(dpl), cls: dpl >= 0 ? "pos" : "neg", sub: "since previous close" },
      { label: "Total P/L", value: fmtSigned(tpl), cls: tpl >= 0 ? "pos" : "neg", sub: cost > 0 ? `<b>${fmtPct(tplPct)}</b> on ${fmtMoney(cost)} invested` : "open a position to start" },
      { label: "Buying power", value: fmtMoney(state.cash), cls: "", sub: "market orders · $0 fee" },
    ];
    els.kpis.innerHTML = cards.map(c => `
      <div class="kpi">
        <span class="kpi-label">${c.label}</span>
        <span class="kpi-value ${c.cls}">${c.value}</span>
        <span class="kpi-sub">${c.sub}</span>
      </div>`).join("");
    els["cash-value"].textContent = fmtMoney(state.cash);
  }

  // ---------- Ticker tape ----------
  function renderTape() {
    const items = STOCKS.map(s => {
      const chg = dayChange(s.sym);
      const cls = chg >= 0 ? "up" : "down";
      return `<span class="tape-item"><span class="tape-sym">${s.sym}</span><span class="tape-price">${live[s.sym].toFixed(2)}</span><span class="tape-chg ${cls}">${fmtPct(chg)}</span></span>`;
    }).join("");
    // Duplicated once for the seamless marquee loop.
    els.tape.innerHTML = items + items;
  }

  // ---------- Watchlist ----------
  function sparkline(sym) {
    const closes = barsFor(sym, "1D").map(b => b.c);
    const step = Math.max(1, Math.floor(closes.length / 30));
    const pts = [];
    for (let i = 0; i < closes.length; i += step) pts.push(closes[i]);
    if (pts[pts.length - 1] !== closes[closes.length - 1]) pts.push(closes[closes.length - 1]);
    const min = Math.min(...pts), max = Math.max(...pts);
    const range = max - min || 1;
    const w = 54, h = 22;
    const path = pts.map((p, i) =>
      `${(i / (pts.length - 1)) * w},${h - 2 - ((p - min) / range) * (h - 4)}`
    ).join(" ");
    const up = pts[pts.length - 1] >= pts[0];
    return `<svg class="wl-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${path}" fill="none" stroke="${up ? "#34d399" : "#fb7185"}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }

  function matchesQuery(s) {
    if (!state.query) return true;
    const q = state.query.toLowerCase();
    return s.sym.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || s.sector.toLowerCase().includes(q);
  }

  function renderWatchlist() {
    const shown = STOCKS.filter(matchesQuery);
    els["wl-count"].textContent = shown.length + (shown.length === 1 ? " symbol" : " symbols");
    if (!shown.length) {
      els["wl-rows"].innerHTML = `<div class="wl-empty">No symbols match “${escapeHTML(state.query)}”.</div>`;
      return;
    }
    els["wl-rows"].innerHTML = shown.map(s => {
      const chg = dayChange(s.sym);
      const cls = chg >= 0 ? "up" : "down";
      const active = s.sym === state.selected ? " is-active" : "";
      const starred = state.stars.includes(s.sym);
      return `
        <div class="wl-row${active}" role="option" aria-selected="${s.sym === state.selected}" data-sym="${s.sym}" tabindex="0">
          <span class="wl-sym-block">
            <span class="wl-sym">${s.sym}
              <button class="wl-star${starred ? " on" : ""}" type="button" data-star="${s.sym}" aria-label="${starred ? "Unstar" : "Star"} ${s.sym}" title="${starred ? "Remove from starred" : "Add to starred"}">
                <svg viewBox="0 0 24 24" fill="${starred ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.3-5.7-3.1-5.7 3.1 1.2-6.3L2.8 9.5l6.4-.8z"/></svg>
              </button>
            </span>
            <span class="wl-name">${s.name}</span>
          </span>
          ${sparkline(s.sym)}
          <span class="wl-quote">
            <span class="wl-price">${live[s.sym].toFixed(2)}</span>
            <span class="wl-chg ${cls}">${fmtPct(chg)}</span>
          </span>
        </div>`;
    }).join("");
  }

  function updateWatchlistPrices() {
    for (const row of els["wl-rows"].querySelectorAll(".wl-row")) {
      const sym = row.dataset.sym;
      const priceEl = row.querySelector(".wl-price");
      const chgEl = row.querySelector(".wl-chg");
      if (!priceEl || !chgEl) continue;
      const chg = dayChange(sym);
      priceEl.textContent = live[sym].toFixed(2);
      chgEl.textContent = fmtPct(chg);
      chgEl.className = "wl-chg " + (chg >= 0 ? "up" : "down");
    }
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- Symbol header ----------
  function renderSymHead() {
    const s = stockBy[state.selected];
    const chg = dayChange(s.sym);
    const chgAbs = live[s.sym] - prevCloseFor(s.sym);
    els["sym-name"].innerHTML = `${s.sym} <span class="sym-sector">${s.sector}</span>`;
    els["sym-meta"].textContent = `${s.name} · ${TIMEFRAMES[state.timeframe].label}`;
    els["sym-price"].textContent = fmtMoney(live[s.sym]);
    const cls = chg >= 0 ? "up" : "down";
    els["sym-change"].className = "sym-change " + cls;
    els["sym-change"].textContent = `${fmtSigned(chgAbs)} (${fmtPct(chg)}) today`;
  }

  // ---------- Chart ----------
  let chartGeom = null; // { padL, padR, padT, padB, volH, w, h, x(i), y(price) }

  function renderChart() {
    const svg = els.chart;
    const bars = barsFor(state.selected, state.timeframe).slice();
    // Splice the live price into the final bar so the chart breathes with the tape.
    const last = bars[bars.length - 1];
    last.c = round2(live[state.selected]);
    last.h = Math.max(last.h, last.c);
    last.l = Math.min(last.l, last.c);

    const wrap = els["chart-wrap"];
    const W = Math.max(280, wrap.clientWidth - 8);
    const H = Math.max(240, wrap.clientHeight || 340);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);

    const padR = 58, padT = 12, padB = 22, volH = Math.round(H * 0.18);
    const plotW = W - padR - 8;
    const plotH = H - padT - padB - volH - 6;

    let minP = Infinity, maxP = -Infinity, maxV = 0;
    for (const b of bars) {
      if (b.l < minP) minP = b.l;
      if (b.h > maxP) maxP = b.h;
      if (b.v > maxV) maxV = b.v;
    }
    const pad = (maxP - minP) * 0.06 || 1;
    minP -= pad; maxP += pad;

    const x = i => 8 + (i + 0.5) * (plotW / bars.length);
    const y = p => padT + (1 - (p - minP) / (maxP - minP)) * plotH;
    const bw = Math.max(2, Math.min(11, (plotW / bars.length) * 0.62));
    chartGeom = { x, y, minP, maxP, bars, W, H, padR, padT, plotH };

    const parts = [];

    // Horizontal grid + right-side price labels.
    for (let g = 0; g <= 4; g++) {
      const p = minP + ((maxP - minP) * g) / 4;
      const gy = y(p);
      parts.push(`<line x1="8" y1="${gy}" x2="${8 + plotW}" y2="${gy}" stroke="#182230" stroke-width="1" />`);
      parts.push(`<text x="${W - padR + 8}" y="${gy + 3.5}" fill="#5c6b7d" font-size="10.5" font-family="ui-monospace, Menlo, Consolas, monospace">${p.toFixed(p >= 100 ? 0 : 1)}</text>`);
    }

    // Volume bars.
    const volTop = padT + plotH + 8;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const vh = (b.v / maxV) * (volH - 4);
      const up = b.c >= b.o;
      parts.push(`<rect x="${x(i) - bw / 2}" y="${volTop + (volH - 4 - vh)}" width="${bw}" height="${Math.max(1, vh)}" fill="${up ? "#34d399" : "#fb7185"}" opacity="0.22" />`);
    }

    // Candles.
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const up = b.c >= b.o;
      const col = up ? "#34d399" : "#fb7185";
      const cx = x(i);
      const yo = y(b.o), yc = y(b.c);
      const top = Math.min(yo, yc);
      const hgt = Math.max(1.5, Math.abs(yc - yo));
      parts.push(`<line x1="${cx}" y1="${y(b.h)}" x2="${cx}" y2="${y(b.l)}" stroke="${col}" stroke-width="1" opacity="0.75" />`);
      parts.push(`<rect x="${cx - bw / 2}" y="${top}" width="${bw}" height="${hgt}" fill="${up ? col : col}" opacity="${up ? 0.9 : 0.85}" rx="0.5" />`);
    }

    // Last price dashed line + pill.
    const lp = live[state.selected];
    if (lp >= minP && lp <= maxP) {
      const ly = y(lp);
      const up = lp >= prevCloseFor(state.selected);
      parts.push(`<line x1="8" y1="${ly}" x2="${8 + plotW}" y2="${ly}" stroke="${up ? "#34d399" : "#fb7185"}" stroke-width="1" stroke-dasharray="3 4" opacity="0.7" />`);
    }

    // X axis time labels.
    const labels = xLabels(bars);
    for (const { i, text } of labels) {
      parts.push(`<text x="${x(i)}" y="${H - 6}" fill="#5c6b7d" font-size="10" text-anchor="middle" font-family="ui-monospace, Menlo, Consolas, monospace">${text}</text>`);
    }

    svg.innerHTML = parts.join("");
    renderLastPricePill();
    renderChartStats(bars);
  }

  function xLabels(bars) {
    const n = bars.length;
    const want = 5;
    const out = [];
    for (let k = 0; k < want; k++) {
      const i = Math.round((k / (want - 1)) * (n - 1));
      const d = new Date(bars[i].t);
      let text;
      if (state.timeframe === "1D") text = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
      else if (state.timeframe === "1W") text = d.toLocaleDateString("en-US", { weekday: "short" });
      else if (state.timeframe === "1Y") text = d.toLocaleDateString("en-US", { month: "short" });
      else text = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      out.push({ i, text });
    }
    return out;
  }

  function renderLastPricePill() {
    const svg = els.chart;
    const lp = live[state.selected];
    if (!chartGeom || lp < chartGeom.minP || lp > chartGeom.maxP) { els["chart-price"].hidden = true; return; }
    const ly = chartGeom.y(lp);
    if (ly < 0 || ly > chartGeom.H) { els["chart-price"].hidden = true; return; }
    const up = lp >= prevCloseFor(state.selected);
    const pill = els["chart-price"];
    pill.hidden = false;
    pill.textContent = lp.toFixed(2);
    pill.className = "chart-price " + (up ? "up" : "down");
    pill.style.top = ly + "px";
    // Position inside the SVG's coordinate space (svg starts at wrap top).
    pill.style.left = (chartGeom.W - chartGeom.padR + 2) + "px";
    void svg;
  }

  function renderChartStats(bars) {
    const b = bars[bars.length - 1];
    const first = bars[0];
    const rangeChg = (b.c - first.o) / first.o;
    const totalV = bars.reduce((a, x) => a + x.v, 0);
    const stats = [
      { l: "Open", v: b.o.toFixed(2) },
      { l: "High", v: b.h.toFixed(2) },
      { l: "Low", v: b.l.toFixed(2) },
      { l: "Close", v: b.c.toFixed(2) },
      { l: "Volume", v: fmtVol(totalV) },
      { l: "Range", v: `<span class="${rangeChg >= 0 ? "up" : "down"}">${fmtPct(rangeChg)}</span>`, html: true },
    ];
    els["chart-stats"].innerHTML = stats.map(s =>
      `<div class="stat"><div class="stat-label">${s.l}</div><div class="stat-value">${s.html ? s.v : s.v}</div></div>`
    ).join("");
  }

  // Crosshair tooltip.
  function chartPointer(ev) {
    if (!chartGeom) return;
    const rect = els.chart.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const { bars } = chartGeom;
    const plotW = chartGeom.W - chartGeom.padR - 8;
    const idx = Math.max(0, Math.min(bars.length - 1, Math.floor(((px - 8) / plotW) * bars.length)));
    const b = bars[idx];
    const up = b.c >= b.o;
    const d = new Date(b.t);
    const timeTxt = state.timeframe === "1D"
      ? d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
      : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const tip = els["chart-tip"];
    tip.hidden = false;
    tip.innerHTML = `
      <div class="tip-title">${state.selected} · ${timeTxt}</div>
      <div class="tip-row"><span>Open</span><span>${b.o.toFixed(2)}</span></div>
      <div class="tip-row"><span>High</span><span>${b.h.toFixed(2)}</span></div>
      <div class="tip-row"><span>Low</span><span>${b.l.toFixed(2)}</span></div>
      <div class="tip-row"><span>Close</span><span class="${up ? "up" : "down"}">${b.c.toFixed(2)}</span></div>
      <div class="tip-row"><span>Vol</span><span>${fmtVol(b.v)}</span></div>`;
    const tipW = tip.offsetWidth || 150;
    let left = chartGeom.x(idx) + 14;
    if (left + tipW > chartGeom.W - 8) left = chartGeom.x(idx) - tipW - 14;
    tip.style.left = Math.max(4, left) + "px";
    tip.style.top = Math.max(4, chartGeom.y(b.h) - 10) + "px";
  }
  function chartPointerLeave() {
    els["chart-tip"].hidden = true;
  }

  // ---------- Trade panel ----------
  function sharesValue() {
    const n = parseInt(els["shares-input"].value, 10);
    return Number.isFinite(n) && n >= 1 ? n : null;
  }

  function renderTradePanel() {
    const sym = state.selected;
    const price = live[sym];
    const pos = state.positions[sym];

    els["trade-sym"].innerHTML = `<span class="ts-sym">${sym}</span><span class="ts-switch">chart symbol ⇄</span>`;
    els["trade-quote"].innerHTML = `Last <b class="${dayChange(sym) >= 0 ? "up" : "down"}">${price.toFixed(2)}</b> · ${state.side === "buy" ? "you hold " + (pos ? pos.shares : 0) + " sh" : "you hold " + (pos ? pos.shares : 0) + " sh"}`;

    els["place-order"].textContent = `Place ${state.side} order`;
    els["place-order"].className = "place-btn" + (state.side === "sell" ? " sell" : "");

    const shares = sharesValue();
    const total = shares ? shares * price : 0;
    const rows = [];
    rows.push(`<div class="os-row"><dt>Shares</dt><dd>${shares ?? "—"}</dd></div>`);
    rows.push(`<div class="os-row"><dt>Price</dt><dd>${price.toFixed(2)}</dd></div>`);
    rows.push(`<div class="os-row"><dt>Est. fee</dt><dd>$0.00</dd></div>`);
    if (state.side === "buy") {
      rows.push(`<div class="os-row os-total buy"><dt>Est. total</dt><dd>${fmtMoney(total)}</dd></div>`);
    } else {
      rows.push(`<div class="os-row os-total sell"><dt>Est. proceeds</dt><dd>${fmtMoney(total)}</dd></div>`);
    }
    els["order-summary"].innerHTML = `<dl>${rows.join("")}</dl>`;

    // Validation + hint.
    const btn = els["place-order"];
    let hint = "Simulated fill at the live tape price.";
    let ok = true;
    if (!shares) { ok = false; hint = "Enter a share quantity of 1 or more."; }
    else if (state.side === "buy" && total > state.cash + 0.001) {
      ok = false;
      hint = `Not enough buying power — you have ${fmtMoney(state.cash)}.`;
    } else if (state.side === "sell" && (!pos || shares > pos.shares)) {
      ok = false;
      hint = pos ? `You only hold ${pos.shares} shares of ${sym}.` : `You don't hold any ${sym} yet.`;
    }
    btn.disabled = !ok;
    els["trade-hint"].textContent = hint;
    if (ok && shares) hint = `Simulated fill at ${price.toFixed(2)} — the live tape price.`;
    if (ok && shares) els["trade-hint"].textContent = hint;

    // Quick buttons: enable/disable by side.
    for (const q of els["quick-row"].querySelectorAll(".quick-btn")) {
      if (state.side === "buy") {
        q.disabled = state.cash < price;
      } else {
        q.disabled = !pos || pos.shares < 1;
      }
    }
  }

  // ---------- Positions ----------
  function renderPositions() {
    const syms = Object.keys(state.positions);
    els["pos-empty"].hidden = syms.length > 0;
    els["pos-note"].textContent = syms.length
      ? `${syms.length} open${syms.length === 1 ? "" : "s"} · ${fmtMoney(positionValue())}`
      : "no open positions";

    els["pos-body"].innerHTML = syms.map(sym => {
      const pos = state.positions[sym];
      const price = live[sym];
      const value = pos.shares * price;
      const pl = value - pos.cost;
      const plPct = pos.cost > 0 ? pl / pos.cost : 0;
      const day = pos.shares * (price - prevCloseFor(sym));
      return `<tr>
        <td class="pos-sym" data-sym="${sym}" tabindex="0">${sym}</td>
        <td class="num pos-num">${pos.shares}</td>
        <td class="num pos-num">${(pos.cost / pos.shares).toFixed(2)}</td>
        <td class="num pos-num">${price.toFixed(2)}</td>
        <td class="num pos-num">${fmtMoney(value)}</td>
        <td class="num pos-num ${day >= 0 ? "up" : "down"}">${fmtSigned(day)}</td>
        <td class="num pos-num ${pl >= 0 ? "up" : "down"}">${fmtSigned(pl)}<br><small style="color:inherit;opacity:.75">${fmtPct(plPct)}</small></td>
        <td class="pos-actions">
          <button class="mini-btn buy" type="button" data-quick="buy" data-sym="${sym}">BUY</button>
          <button class="mini-btn sell" type="button" data-quick="sell" data-sym="${sym}">SELL</button>
        </td>
      </tr>`;
    }).join("");
  }

  // ---------- Transactions ----------
  function renderTxns() {
    els["txn-empty"].hidden = state.txns.length > 0;
    els["txn-note"].textContent = state.txns.length + (state.txns.length === 1 ? " filled" : " filled");
    els["txn-list"].innerHTML = state.txns.map(t => `
      <div class="txn-row ${t.side}">
        <span class="txn-bar" aria-hidden="true"></span>
        <span class="txn-main">
          <span class="txn-title">${t.side === "buy" ? "Bought" : "Sold"} <b>${t.shares} ${t.sym}</b></span>
          <span class="txn-time">${fmtTime(t.ts)} · @ ${t.price.toFixed(2)}</span>
        </span>
        <span class="txn-total ${t.side === "buy" ? "up" : "down"}">${fmtMoney(t.total)}<small>${t.side === "buy" ? "spent" : "received"}</small></span>
      </div>`).join("");
  }

  // ---------- Trading ----------
  function executeOrder(order) {
    const { side, sym, shares, price } = order;
    const total = round2(shares * price);
    if (side === "buy") {
      state.cash = round2(state.cash - total);
      const pos = state.positions[sym] || { shares: 0, cost: 0 };
      pos.shares += shares;
      pos.cost = round2(pos.cost + total);
      state.positions[sym] = pos;
    } else {
      const pos = state.positions[sym];
      state.cash = round2(state.cash + total);
      pos.cost = round2(pos.cost - (pos.cost / pos.shares) * shares);
      pos.shares -= shares;
      if (pos.shares <= 0) delete state.positions[sym];
      else state.positions[sym] = pos;
    }
    state.txns.unshift({
      id: uid(), side, sym, shares, price: round2(price), total, ts: Date.now(),
    });
    if (state.txns.length > MAX_TXNS) state.txns.length = MAX_TXNS;
    persist();
    renderAll();
    const msg = `${side === "buy" ? "Bought" : "Sold"} <b>${shares} ${sym}</b> @ ${price.toFixed(2)} — ${fmtMoney(total)}`;
    toast(msg);
    announce(`${side === "buy" ? "Bought" : "Sold"} ${shares} ${sym} at ${price.toFixed(2)} for ${fmtMoney(total)}`);
  }

  function openConfirm() {
    const shares = sharesValue();
    if (!shares) return;
    const sym = state.selected;
    const price = live[sym];
    const total = round2(shares * price);
    state.confirmOrder = { side: state.side, sym, shares, price };

    const after = state.side === "buy"
      ? `Cash after: ${fmtMoney(state.cash - total)}`
      : `You'll hold ${Math.max(0, (state.positions[sym]?.shares || 0) - shares)} ${sym} after`;
    els["confirm-grid"].innerHTML = `
      <div class="cg-row"><dt>Side</dt><dd class="${state.side === "buy" ? "up" : "down"}">${state.side.toUpperCase()}</dd></div>
      <div class="cg-row"><dt>Symbol</dt><dd>${sym}</dd></div>
      <div class="cg-row"><dt>Shares</dt><dd>${shares}</dd></div>
      <div class="cg-row"><dt>Price</dt><dd>${price.toFixed(2)}</dd></div>
      <div class="cg-row cg-total"><dt>${state.side === "buy" ? "Total cost" : "Total proceeds"}</dt><dd>${fmtMoney(total)}</dd></div>`;
    els["confirm-note"].textContent = after + " · market order, fills instantly in this simulator.";
    els["confirm-go"].textContent = `Confirm ${state.side}`;
    els["confirm-go"].className = "confirm-btn" + (state.side === "sell" ? " sell" : "");
    els["confirm-dialog"].showModal();
    document.body.classList.add("modal-open");
  }

  function closeConfirm() {
    if (els["confirm-dialog"].open) els["confirm-dialog"].close();
    document.body.classList.remove("modal-open");
    state.confirmOrder = null;
  }

  // ---------- Reset ----------
  function resetPortfolio() {
    state.cash = START_CASH;
    state.positions = {};
    state.txns = [];
    state.stars = ["NOVA", "QNT", "ZEN", "PYRA"];
    persist();
    renderAll();
    toast(`Portfolio reset — cash back to <b>${fmtMoney(START_CASH)}</b>`);
    announce("Portfolio reset to ten thousand dollars");
  }

  // ---------- Render orchestration ----------
  function renderAll() {
    renderKPIs();
    renderTape();
    renderWatchlist();
    renderSymHead();
    renderChart();
    renderTradePanel();
    renderPositions();
    renderTxns();
  }

  // ---------- Live tick ----------
  function tick() {
    for (const s of STOCKS) {
      const jitter = (Math.random() - 0.5) * 2 * s.vol * 0.06;
      live[s.sym] = round2(Math.max(1, live[s.sym] * (1 + jitter)));
    }
    // Keep the tape, quotes and KPIs fresh; the chart re-render is cheap.
    renderTape();
    updateWatchlistPrices();
    renderSymHead();
    renderChart();
    renderTradePanel();
    renderKPIs();
    renderPositions();
  }

  // ---------- Events ----------
  function bindEvents() {
    els.search.addEventListener("input", () => {
      state.query = els.search.value.trim();
      renderWatchlist();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "/" && document.activeElement !== els.search && !els["confirm-dialog"].open) {
        ev.preventDefault();
        els.search.focus();
      }
    });

    // Watchlist: select, star, keyboard.
    els["wl-rows"].addEventListener("click", (ev) => {
      const star = ev.target.closest("[data-star]");
      if (star) {
        ev.stopPropagation();
        const sym = star.dataset.star;
        const i = state.stars.indexOf(sym);
        if (i >= 0) state.stars.splice(i, 1);
        else state.stars.push(sym);
        persist();
        renderWatchlist();
        return;
      }
      const row = ev.target.closest(".wl-row");
      if (!row) return;
      selectSymbol(row.dataset.sym);
    });
    els["wl-rows"].addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      const row = ev.target.closest(".wl-row");
      if (!row) return;
      ev.preventDefault();
      selectSymbol(row.dataset.sym);
    });

    // Timeframe.
    els["tf-row"].addEventListener("click", (ev) => {
      const btn = ev.target.closest(".tf-btn");
      if (!btn) return;
      state.timeframe = btn.dataset.tf;
      for (const b of els.tfBtns) b.classList.toggle("is-active", b === btn);
      renderSymHead();
      renderChart();
    });

    // Chart crosshair.
    els.chart.addEventListener("pointermove", chartPointer);
    els.chart.addEventListener("pointerleave", chartPointerLeave);

    // Side tabs.
    for (const tab of els.sideTabs) {
      tab.addEventListener("click", () => setSide(tab.dataset.side));
    }

    // Trade ticket.
    els["trade-sym"].addEventListener("click", () => {
      const row = els["wl-rows"].querySelector(`.wl-row[data-sym="${state.selected}"]`);
      if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
      els["wl-rows"].scrollTop = 0;
    });
    els["shares-input"].addEventListener("input", renderTradePanel);
    els["shares-minus"].addEventListener("click", () => stepShares(-1));
    els["shares-plus"].addEventListener("click", () => stepShares(1));
    els["quick-row"].addEventListener("click", (ev) => {
      const btn = ev.target.closest(".quick-btn");
      if (!btn || btn.disabled) return;
      const frac = Number(btn.dataset.frac);
      const price = live[state.selected];
      let n;
      if (state.side === "buy") n = Math.floor((state.cash * frac) / price);
      else n = Math.floor((state.positions[state.selected]?.shares || 0) * frac);
      n = Math.max(1, n);
      els["shares-input"].value = n;
      renderTradePanel();
    });
    els["place-order"].addEventListener("click", openConfirm);

    // Confirm dialog. Native close/cancel events are unreliable in some
    // embedded browsers, so cleanup also runs directly in closeConfirm().
    els["confirm-cancel"].addEventListener("click", closeConfirm);
    els["confirm-go"].addEventListener("click", () => {
      const order = state.confirmOrder;
      closeConfirm();
      if (order) executeOrder(order);
    });
    els["confirm-dialog"].addEventListener("cancel", (ev) => {
      ev.preventDefault();
      closeConfirm();
    });
    els["confirm-dialog"].addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); closeConfirm(); }
    });

    // Positions quick actions.
    els["pos-body"].addEventListener("click", (ev) => {
      const symEl = ev.target.closest(".pos-sym");
      if (symEl) { selectSymbol(symEl.dataset.sym); return; }
      const btn = ev.target.closest("[data-quick]");
      if (!btn) return;
      const sym = btn.dataset.sym;
      selectSymbol(sym);
      setSide(btn.dataset.quick);
      els["shares-input"].value = btn.dataset.quick === "sell"
        ? state.positions[sym]?.shares || 1
        : Math.max(1, Math.floor(state.cash / live[sym] / 2));
      renderTradePanel();
      els["shares-input"].focus();
    });
    els["pos-body"].addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      const symEl = ev.target.closest(".pos-sym");
      if (!symEl) return;
      ev.preventDefault();
      selectSymbol(symEl.dataset.sym);
    });

    // Reset (two-step).
    els["reset-btn"].addEventListener("click", () => {
      if (!state.resetArmed) {
        state.resetArmed = true;
        els["reset-btn"].textContent = "Click again to confirm";
        els["reset-btn"].classList.add("is-arming");
        clearTimeout(state.resetTimer);
        state.resetTimer = setTimeout(disarmReset, 4000);
        return;
      }
      disarmReset();
      resetPortfolio();
    });

    // Resize: re-measure chart.
    let rz;
    window.addEventListener("resize", () => {
      clearTimeout(rz);
      rz = setTimeout(renderChart, 120);
    });
  }

  function disarmReset() {
    state.resetArmed = false;
    clearTimeout(state.resetTimer);
    els["reset-btn"].textContent = "Reset portfolio";
    els["reset-btn"].classList.remove("is-arming");
  }

  function stepShares(delta) {
    const cur = sharesValue() || 0;
    const next = Math.max(1, cur + delta);
    els["shares-input"].value = next;
    renderTradePanel();
  }

  function setSide(side) {
    state.side = side;
    for (const tab of els.sideTabs) {
      const on = tab.dataset.side === side;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
    }
    renderTradePanel();
  }

  function selectSymbol(sym) {
    if (!stockBy[sym] || sym === state.selected) return;
    state.selected = sym;
    persist();
    renderWatchlist();
    renderSymHead();
    renderChart();
    renderTradePanel();
  }

  // ---------- Init ----------
  function uid() { return "T" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function init() {
    cacheElements();
    loadStore();
    for (const btn of els.tfBtns) btn.classList.toggle("is-active", btn.dataset.tf === state.timeframe);
    bindEvents();
    renderAll();
    setInterval(tick, TICK_MS);
  }

  document.addEventListener("DOMContentLoaded", init);
})();

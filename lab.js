// Claude Sinyal · Test Lab engine. Runs entirely on the phone over 494 OKX coins x 300 days of 4H candles.
// Same exit and cost model as the research: entry = next candle open; stop k*ATR; target R*stop; optional
// profit lock (after +1R, stop -> entry + min(1%, 0.5*stop distance), active from the next candle); max N candles;
// stop is assumed first when stop and target are in the same candle. Costs: 0.1% fees + 2x liquidity slippage
// (0.05/0.1/0.2/0.4% per side by 24h volume), +0.1% on stop exits. Results in $ per $100 position.
(function (G) {
  const L = {};
  // ---------- data ----------
  L.load = async function (base, onProgress) {
    const meta = await (await fetch(base + "lab-meta.json", { cache: "force-cache" })).json();
    const res = await fetch(base + "lab-data.bin", { cache: "force-cache" });
    const total = +res.headers.get("content-length") || meta.N * meta.T * 10;
    const reader = res.body.getReader(); const chunks = []; let got = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onProgress && onProgress(got / total); }
    const buf = new Uint8Array(got); let off = 0; for (const c of chunks) { buf.set(c, off); off += c.length; }
    return L.fromBuffer(meta, buf.buffer);
  };
  L.fromBuffer = function (meta, ab) {
    const { N, T } = meta, q = new Uint16Array(ab), F = ["o", "h", "l", "c", "v"], D = { meta, N, T, coins: [] };
    for (let j = 0; j < N; j++) {
      const coin = { sym: meta.syms[j] };
      for (let f = 0; f < 5; f++) {
        const a = new Float64Array(T), base = (f * N + j) * T;
        for (let t = 0; t < T; t++) {
          const x = q[base + t];
          a[t] = x === 0 ? NaN : f < 4 ? meta.pmin[j] * Math.exp((x - 1) / 65534 * meta.span[j]) : Math.expm1((x - 1) / 65534 * meta.lv);
        }
        coin[F[f]] = a;
      }
      D.coins.push(coin);
    }
    D.ts = new Float64Array(T); for (let t = 0; t < T; t++) D.ts[t] = meta.t0 + t * meta.step;
    D.btc = D.coins.findIndex((c) => c.sym === "BTC-USDT-SWAP");
    return D;
  };
  // ---------- indicators (per coin, cached) ----------
  const NaNs = (T) => new Float64Array(T).fill(NaN);
  function ema(x, n) { const T = x.length, out = NaNs(T), k = 2 / (n + 1); let e = NaN, s = 0, c = 0; for (let t = 0; t < T; t++) { const v = x[t]; if (Number.isNaN(v)) { out[t] = e; continue; } if (Number.isNaN(e)) { s += v; c++; if (c >= n) e = s / n; } else e = v * k + e * (1 - k); out[t] = e; } return out; }
  function wilder(x, n) { const T = x.length, out = NaNs(T); let p = NaN, s = 0, c = 0; for (let t = 0; t < T; t++) { const v = x[t]; if (Number.isNaN(v)) { out[t] = p; continue; } if (Number.isNaN(p)) { s += v; c++; if (c >= n) p = s / n; } else p = (p * (n - 1) + v) / n; out[t] = p; } return out; }
  function roll(x, n, f, shift = 0) { const T = x.length, out = NaNs(T); for (let t = n - 1 + shift; t < T; t++) { let a = f === "max" ? -Infinity : f === "min" ? Infinity : 0, ok = true; for (let k = t - shift - n + 1; k <= t - shift; k++) { const v = x[k]; if (Number.isNaN(v)) { ok = false; break; } a = f === "max" ? Math.max(a, v) : f === "min" ? Math.min(a, v) : a + v; } out[t] = ok ? (f === "mean" ? a / n : a) : NaN; } return out; }
  function std20(x) { const T = x.length, out = NaNs(T); for (let t = 19; t < T; t++) { let s = 0, s2 = 0, ok = true; for (let k = t - 19; k <= t; k++) { const v = x[k]; if (Number.isNaN(v)) { ok = false; break; } s += v; s2 += v * v; } if (ok) { const m = s / 20; out[t] = Math.sqrt(Math.max(0, (s2 - 20 * m * m) / 19)); } } return out; }
  function ind(D, j, name) {
    const C = D.coins[j], cache = (C._i ||= {}); if (cache[name]) return cache[name];
    const { o, h, l, c, v } = C, T = c.length; let r;
    const pc = (t) => t ? c[t - 1] : NaN;
    if (name === "atr") { const tr = NaNs(T); for (let t = 0; t < T; t++) tr[t] = t && !Number.isNaN(c[t - 1]) ? Math.max(h[t] - l[t], Math.abs(h[t] - c[t - 1]), Math.abs(l[t] - c[t - 1])) : h[t] - l[t]; r = wilder(tr, 14); }
    else if (name === "rsi") { const up = NaNs(T), dn = NaNs(T); for (let t = 1; t < T; t++) { const d = c[t] - c[t - 1]; if (!Number.isNaN(d)) { up[t] = d > 0 ? d : 0; dn[t] = d < 0 ? -d : 0; } } const au = wilder(up, 14), ad = wilder(dn, 14); r = au.map((u, t) => 100 - 100 / (1 + u / (ad[t] === 0 ? 1e-12 : ad[t]))); }
    else if (/^ema\d+$/.test(name)) r = ema(c, +name.slice(3));
    else if (name === "macd") { const a = ema(c, 12), b = ema(c, 26); r = a.map((x, t) => x - b[t]); }
    else if (name === "macds") { const m = ind(D, j, "macd"), f = m.findIndex((x) => !Number.isNaN(x)); r = NaNs(T); if (f >= 0) { const s = ema(m.slice(f), 9); for (let t = f; t < T; t++) r[t] = s[t - f]; } }
    else if (name === "sma20") r = roll(c, 20, "mean");
    else if (name === "sd20") r = std20(c);
    else if (name === "vol24") r = roll(v, 6, "sum");
    else if (name === "vavg20") r = roll(v, 20, "mean", 1);
    else if (/^hh\d+$/.test(name)) r = roll(h, +name.slice(2), "max", 1);
    else if (/^ll\d+$/.test(name)) r = roll(l, +name.slice(2), "min", 1);
    else if (name === "ret6") { r = NaNs(T); for (let t = 6; t < T; t++) r[t] = c[t] / c[t - 6] - 1; }
    else if (name === "ret42") { r = NaNs(T); for (let t = 42; t < T; t++) r[t] = c[t] / c[t - 42] - 1; }
    else if (name === "stochk") { const hh = roll(h, 14, "max"), ll = roll(l, 14, "min"), raw = c.map((x, t) => 100 * (x - ll[t]) / (hh[t] - ll[t] + 1e-12)); r = roll(raw, 3, "mean"); }
    else if (name === "stochd") r = roll(ind(D, j, "stochk"), 3, "mean");
    else if (name === "obv") { r = new Float64Array(T); let s = 0; for (let t = 1; t < T; t++) { const d = c[t] - c[t - 1]; if (!Number.isNaN(d) && !Number.isNaN(v[t])) s += (d > 0 ? 1 : d < 0 ? -1 : 0) * v[t]; r[t] = s; } }
    else if (name === "obvema") r = ema(ind(D, j, "obv"), 20);
    else if (name === "dip" || name === "dim" || name === "adx") {
      const pdm = NaNs(T), ndm = NaNs(T); for (let t = 1; t < T; t++) { const u = h[t] - h[t - 1], d = l[t - 1] - l[t]; if (Number.isNaN(u) || Number.isNaN(d)) continue; pdm[t] = u > d && u > 0 ? u : 0; ndm[t] = d > u && d > 0 ? d : 0; }
      const a = ind(D, j, "atr"), wp = wilder(pdm, 14), wn = wilder(ndm, 14), dip = wp.map((x, t) => 100 * x / a[t]), dim = wn.map((x, t) => 100 * x / a[t]);
      cache.dip = dip; cache.dim = dim; cache.adx = wilder(dip.map((x, t) => 100 * Math.abs(x - dim[t]) / (x + dim[t] + 1e-12)), 14); return cache[name];
    }
    else throw new Error("bilinmeyen gösterge " + name);
    return (cache[name] = r);
  }
  L.ind = ind;
  // ---------- condition library ----------
  // each: id, group, label, param {def,min,max,step,unit} (optional), fn(D, j, p) -> (t) => boolean
  const X = (a, t) => a[t], cross = (a, t, x, up) => up ? a[t - 1] < x && a[t] >= x : a[t - 1] > x && a[t] <= x;
  L.CONDS = [
    { id: "rsi_lt", g: "RSI (14)", label: "RSI şunun altında", p: { def: 30, min: 1, max: 99 }, fn: (D, j, p) => { const r = ind(D, j, "rsi"); return (t) => r[t] < p; } },
    { id: "rsi_gt", g: "RSI (14)", label: "RSI şunun üstünde", p: { def: 70, min: 1, max: 99 }, fn: (D, j, p) => { const r = ind(D, j, "rsi"); return (t) => r[t] > p; } },
    { id: "rsi_up", g: "RSI (14)", label: "RSI şu seviyeyi yukarı kesti", p: { def: 30, min: 1, max: 99 }, fn: (D, j, p) => { const r = ind(D, j, "rsi"); return (t) => cross(r, t, p, true); } },
    { id: "rsi_dn", g: "RSI (14)", label: "RSI şu seviyeyi aşağı kesti", p: { def: 70, min: 1, max: 99 }, fn: (D, j, p) => { const r = ind(D, j, "rsi"); return (t) => cross(r, t, p, false); } },
    { id: "ema_above", g: "Hareketli ortalama (EMA)", label: "Fiyat EMA'nın üstünde (periyot)", p: { def: 50, min: 5, max: 200 }, fn: (D, j, p) => { const e = ind(D, j, "ema" + Math.round(p)), c = D.coins[j].c; return (t) => c[t] > e[t]; } },
    { id: "ema_below", g: "Hareketli ortalama (EMA)", label: "Fiyat EMA'nın altında (periyot)", p: { def: 50, min: 5, max: 200 }, fn: (D, j, p) => { const e = ind(D, j, "ema" + Math.round(p)), c = D.coins[j].c; return (t) => c[t] < e[t]; } },
    { id: "ema_bull", g: "Hareketli ortalama (EMA)", label: "EMA20, EMA50'nin üstünde", fn: (D, j) => { const a = ind(D, j, "ema20"), b = ind(D, j, "ema50"); return (t) => a[t] > b[t]; } },
    { id: "ema_bear", g: "Hareketli ortalama (EMA)", label: "EMA20, EMA50'nin altında", fn: (D, j) => { const a = ind(D, j, "ema20"), b = ind(D, j, "ema50"); return (t) => a[t] < b[t]; } },
    { id: "ema_xup", g: "Hareketli ortalama (EMA)", label: "EMA20, EMA50'yi yukarı kesti", fn: (D, j) => { const a = ind(D, j, "ema20"), b = ind(D, j, "ema50"); return (t) => a[t - 1] <= b[t - 1] && a[t] > b[t]; } },
    { id: "ema_xdn", g: "Hareketli ortalama (EMA)", label: "EMA20, EMA50'yi aşağı kesti", fn: (D, j) => { const a = ind(D, j, "ema20"), b = ind(D, j, "ema50"); return (t) => a[t - 1] >= b[t - 1] && a[t] < b[t]; } },
    { id: "macd_bull", g: "MACD (12,26,9)", label: "MACD sinyal çizgisinin üstünde", fn: (D, j) => { const m = ind(D, j, "macd"), s = ind(D, j, "macds"); return (t) => m[t] > s[t]; } },
    { id: "macd_bear", g: "MACD (12,26,9)", label: "MACD sinyal çizgisinin altında", fn: (D, j) => { const m = ind(D, j, "macd"), s = ind(D, j, "macds"); return (t) => m[t] < s[t]; } },
    { id: "macd_xup", g: "MACD (12,26,9)", label: "MACD sinyali yukarı kesti", fn: (D, j) => { const m = ind(D, j, "macd"), s = ind(D, j, "macds"); return (t) => m[t - 1] <= s[t - 1] && m[t] > s[t]; } },
    { id: "macd_xdn", g: "MACD (12,26,9)", label: "MACD sinyali aşağı kesti", fn: (D, j) => { const m = ind(D, j, "macd"), s = ind(D, j, "macds"); return (t) => m[t - 1] >= s[t - 1] && m[t] < s[t]; } },
    { id: "bb_low", g: "Bollinger (20)", label: "Kapanış alt bandın altında (sapma)", p: { def: 2, min: 0.5, max: 4, step: 0.1 }, fn: (D, j, p) => { const m = ind(D, j, "sma20"), s = ind(D, j, "sd20"), c = D.coins[j].c; return (t) => c[t] < m[t] - p * s[t]; } },
    { id: "bb_high", g: "Bollinger (20)", label: "Kapanış üst bandın üstünde (sapma)", p: { def: 2, min: 0.5, max: 4, step: 0.1 }, fn: (D, j, p) => { const m = ind(D, j, "sma20"), s = ind(D, j, "sd20"), c = D.coins[j].c; return (t) => c[t] > m[t] + p * s[t]; } },
    { id: "vol_gt", g: "Hacim", label: "Mum hacmi 20 mum ortalamasının … katı", p: { def: 2, min: 0.5, max: 20, step: 0.1, unit: "x" }, fn: (D, j, p) => { const a = ind(D, j, "vavg20"), v = D.coins[j].v; return (t) => v[t] > p * a[t]; } },
    { id: "obv_up", g: "Hacim", label: "OBV kendi ortalamasının üstünde (para girişi)", fn: (D, j) => { const a = ind(D, j, "obv"), b = ind(D, j, "obvema"); return (t) => a[t] > b[t]; } },
    { id: "obv_dn", g: "Hacim", label: "OBV kendi ortalamasının altında (para çıkışı)", fn: (D, j) => { const a = ind(D, j, "obv"), b = ind(D, j, "obvema"); return (t) => a[t] < b[t]; } },
    { id: "green", g: "Mum", label: "Yeşil mum", fn: (D, j) => { const { o, c } = D.coins[j]; return (t) => c[t] > o[t]; } },
    { id: "red", g: "Mum", label: "Kırmızı mum", fn: (D, j) => { const { o, c } = D.coins[j]; return (t) => c[t] < o[t]; } },
    { id: "body_gt", g: "Mum", label: "Gövde, mum boyunun en az %…", p: { def: 60, min: 1, max: 100, unit: "%" }, fn: (D, j, p) => { const { o, h, l, c } = D.coins[j]; return (t) => Math.abs(c[t] - o[t]) >= p / 100 * (h[t] - l[t]); } },
    { id: "brk_hi", g: "Kırılım", label: "Kapanış son N mumun zirvesinin üstünde", p: { def: 20, min: 2, max: 120 }, fn: (D, j, p) => { const a = ind(D, j, "hh" + Math.round(p)), c = D.coins[j].c; return (t) => c[t] > a[t]; } },
    { id: "brk_lo", g: "Kırılım", label: "Kapanış son N mumun dibinin altında", p: { def: 20, min: 2, max: 120 }, fn: (D, j, p) => { const a = ind(D, j, "ll" + Math.round(p)), c = D.coins[j].c; return (t) => c[t] < a[t]; } },
    { id: "chg_gt", g: "Fiyat değişimi", label: "Son 24 saatte en az %… yükseldi", p: { def: 5, min: 0, max: 100, step: 0.5, unit: "%" }, fn: (D, j, p) => { const r = ind(D, j, "ret6"); return (t) => r[t] > p / 100; } },
    { id: "chg_lt", g: "Fiyat değişimi", label: "Son 24 saatte en az %… düştü", p: { def: 5, min: 0, max: 100, step: 0.5, unit: "%" }, fn: (D, j, p) => { const r = ind(D, j, "ret6"); return (t) => r[t] < -p / 100; } },
    { id: "wk_gt", g: "Fiyat değişimi", label: "Son 7 günde en az %… yükseldi", p: { def: 10, min: 0, max: 300, unit: "%" }, fn: (D, j, p) => { const r = ind(D, j, "ret42"); return (t) => r[t] > p / 100; } },
    { id: "wk_lt", g: "Fiyat değişimi", label: "Son 7 günde en az %… düştü", p: { def: 10, min: 0, max: 100, unit: "%" }, fn: (D, j, p) => { const r = ind(D, j, "ret42"); return (t) => r[t] < -p / 100; } },
    { id: "adx_gt", g: "Trend gücü (ADX)", label: "ADX şunun üstünde", p: { def: 25, min: 1, max: 90 }, fn: (D, j, p) => { const a = ind(D, j, "adx"); return (t) => a[t] > p; } },
    { id: "adx_lt", g: "Trend gücü (ADX)", label: "ADX şunun altında", p: { def: 20, min: 1, max: 90 }, fn: (D, j, p) => { const a = ind(D, j, "adx"); return (t) => a[t] < p; } },
    { id: "di_bull", g: "Trend gücü (ADX)", label: "Alıcılar güçlü (DI+ > DI−)", fn: (D, j) => { const a = ind(D, j, "dip"), b = ind(D, j, "dim"); return (t) => a[t] > b[t]; } },
    { id: "di_bear", g: "Trend gücü (ADX)", label: "Satıcılar güçlü (DI− > DI+)", fn: (D, j) => { const a = ind(D, j, "dip"), b = ind(D, j, "dim"); return (t) => a[t] < b[t]; } },
    { id: "st_lt", g: "Stokastik (14,3)", label: "%K şunun altında", p: { def: 20, min: 1, max: 99 }, fn: (D, j, p) => { const k = ind(D, j, "stochk"); return (t) => k[t] < p; } },
    { id: "st_gt", g: "Stokastik (14,3)", label: "%K şunun üstünde", p: { def: 80, min: 1, max: 99 }, fn: (D, j, p) => { const k = ind(D, j, "stochk"); return (t) => k[t] > p; } },
    { id: "st_xup", g: "Stokastik (14,3)", label: "%K, %D'yi yukarı kesti", fn: (D, j) => { const k = ind(D, j, "stochk"), d = ind(D, j, "stochd"); return (t) => k[t - 1] <= d[t - 1] && k[t] > d[t]; } },
    { id: "st_xdn", g: "Stokastik (14,3)", label: "%K, %D'yi aşağı kesti", fn: (D, j) => { const k = ind(D, j, "stochk"), d = ind(D, j, "stochd"); return (t) => k[t - 1] >= d[t - 1] && k[t] < d[t]; } },
    { id: "btc_up", g: "BTC", label: "BTC günlük trendi yukarı (20 günlük ortalamanın üstünde)", fn: (D) => { const e = ind(D, D.btc, "ema120"), c = D.coins[D.btc].c; return (t) => c[t] > e[t]; } },
    { id: "btc_dn", g: "BTC", label: "BTC günlük trendi aşağı (20 günlük ortalamanın altında)", fn: (D) => { const e = ind(D, D.btc, "ema120"), c = D.coins[D.btc].c; return (t) => c[t] < e[t]; } },
    { id: "btc_chg_gt", g: "BTC", label: "BTC son 24 saatte en az %… yükseldi", p: { def: 2, min: 0, max: 30, step: 0.5, unit: "%" }, fn: (D, j, p) => { const r = ind(D, D.btc, "ret6"); return (t) => r[t] > p / 100; } },
    { id: "btc_chg_lt", g: "BTC", label: "BTC son 24 saatte en az %… düştü", p: { def: 2, min: 0, max: 30, step: 0.5, unit: "%" }, fn: (D, j, p) => { const r = ind(D, D.btc, "ret6"); return (t) => r[t] < -p / 100; } },
    { id: "atr_gt", g: "Oynaklık", label: "ATR fiyatın en az %…", p: { def: 5, min: 0.1, max: 50, step: 0.1, unit: "%" }, fn: (D, j, p) => { const a = ind(D, j, "atr"), c = D.coins[j].c; return (t) => a[t] / c[t] > p / 100; } },
    { id: "atr_lt", g: "Oynaklık", label: "ATR fiyatın en fazla %…", p: { def: 3, min: 0.1, max: 50, step: 0.1, unit: "%" }, fn: (D, j, p) => { const a = ind(D, j, "atr"), c = D.coins[j].c; return (t) => a[t] / c[t] < p / 100; } },
  ];
  const byId = Object.fromEntries(L.CONDS.map((c) => [c.id, c]));
  // ---------- backtest ----------
  const slip = (v) => v >= 50e6 ? 0.0005 : v >= 10e6 ? 0.001 : v >= 2e6 ? 0.002 : 0.004;
  function trade(C, t, d, atr, cfg) {
    const T = C.c.length; if (t + 1 >= T) return null;
    const e = C.o[t + 1]; if (!(e > 0)) return null;
    const sd = cfg.k * atr; let stop = e - d * sd; const tgt = e + d * cfg.r * sd, trig = e + d * sd;
    const lockd = Math.min(0.01 * e, 0.5 * sd);
    let locked = false, out = null, stopped = false, bars = 0;
    for (let b = 0; b < cfg.hold; b++) {
      const k = t + 1 + b; if (k >= T) return null;
      const h = C.h[k], l = C.l[k]; if (Number.isNaN(h)) return null; bars = b + 1;
      if (d > 0 ? l <= stop : h >= stop) { out = d * (stop - e) / e; stopped = true; break; }
      if (d > 0 ? h >= tgt : l <= tgt) { out = d * (tgt - e) / e; break; }
      if (cfg.lock && !locked && (d > 0 ? h >= trig : l <= trig)) { locked = true; const ls = e + d * lockd; stop = d > 0 ? Math.max(stop, ls) : Math.min(stop, ls); }
    }
    if (out === null) { const k = t + cfg.hold; if (k >= T || Number.isNaN(C.c[k])) return null; out = d * (C.c[k] / e - 1); }
    return { gross: out * 100, stopped, bars };
  }
  // cfg: {side:'LONG'|'SHORT', conds:[{id,p}], k, r, hold, lock, minVol, overlap}
  L.run = function (D, cfg, onProgress) {
    const d = cfg.side === "LONG" ? 1 : -1, split = D.meta.split_ms, trades = [], rnd = [];
    let seed = 12345; const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const conds = cfg.conds.map((c) => ({ ...c, def: byId[c.id] }));
    for (let j = 0; j < D.N; j++) {
      const C = D.coins[j], atr = ind(D, j, "atr"), v24 = ind(D, j, "vol24");
      const tests = conds.map((c) => c.def.fn(D, j, c.p));
      let busyUntil = -1; const eligible = [], before = trades.length;
      for (let t = 60; t < D.T - 1; t++) {
        if (!(v24[t] >= cfg.minVol) || !(atr[t] > 0) || Number.isNaN(C.c[t])) continue;
        eligible.push(t);
        if (!cfg.overlap && t <= busyUntil) continue;
        let ok = true; for (const f of tests) if (!f(t)) { ok = false; break; }
        if (!ok) continue;
        const r = trade(C, t, d, atr[t], cfg); if (!r) continue;
        const cost = (0.001 + 2 * slip(v24[t]) + (r.stopped ? 0.001 : 0)) * 100;
        trades.push({ j, t, ts: D.ts[t], net: r.gross - cost, gross: r.gross });
        busyUntil = t + r.bars;
      }
      // random baseline: same number of trades on random eligible candles of this coin
      const nj = trades.length - before;
      for (let k = 0; k < nj * 3 && eligible.length; k++) {
        const t = eligible[Math.floor(rand() * eligible.length)], r = trade(C, t, d, atr[t], cfg); if (!r) continue;
        rnd.push({ ts: D.ts[t], net: r.gross - (0.001 + 2 * slip(v24[t]) + (r.stopped ? 0.001 : 0)) * 100 });
      }
      onProgress && j % 25 === 0 && onProgress(j / D.N);
    }
    const agg = (a) => { const n = a.length, s = a.reduce((q, x) => q + x.net, 0), w = a.filter((x) => x.net > 0).length; return { n, avg: n ? s / n : NaN, total: s, win: n ? w / n : NaN }; };
    const tr = trades.filter((x) => x.ts < split), te = trades.filter((x) => x.ts >= split);
    const res = { cfg, n: trades.length, train: agg(tr), test: agg(te), all: agg(trades), rnd_train: agg(rnd.filter((x) => x.ts < split)), rnd_test: agg(rnd.filter((x) => x.ts >= split)), split };
    // weekly cumulative and monthly
    const W = 7 * 864e5, wk = new Map(), mo = new Map();
    for (const x of trades) { const w = Math.floor((x.ts - D.meta.t0) / W); wk.set(w, (wk.get(w) || 0) + x.net); const m = new Date(x.ts).toISOString().slice(0, 7); const a = mo.get(m) || { n: 0, s: 0 }; a.n++; a.s += x.net; mo.set(m, a); }
    const nW = Math.ceil((D.ts[D.T - 1] - D.meta.t0) / W) + 1; res.weeks = []; let cum = 0;
    for (let w = 0; w < nW; w++) { cum += wk.get(w) || 0; res.weeks.push([D.meta.t0 + w * W, cum]); }
    res.months = [...mo.entries()].sort().map(([m, a]) => ({ m, n: a.n, avg: a.s / a.n, total: a.s }));
    // concentration: share of total from the best 5 candles
    const byCandle = new Map(); for (const x of trades) byCandle.set(x.ts, (byCandle.get(x.ts) || 0) + x.net);
    res.top5 = [...byCandle.values()].sort((a, b) => b - a).slice(0, 5).reduce((q, x) => q + x, 0);
    res.candles = byCandle.size;
    return res;
  };
  L.verdict = function (r) {
    const a = r.train, b = r.test;
    if (a.n < 100 || b.n < 100) return { level: "warn", text: `İşlem sayısı az (${a.n} / ${b.n}). Bu kadar az örnekle sonuç şansa çok açık; koşulları gevşet.` };
    if (a.avg > 0 && b.avg > 0 && a.avg > r.rnd_train.avg && b.avg > r.rnd_test.avg) {
      if (r.top5 > r.all.total) return { level: "warn", text: "İki dönemde de artı ama kârın tamamı en iyi 5 mumdan geliyor. Birkaç şanslı günün etkisi olabilir." };
      return { level: "ok", text: "İki dönemde de artı ve rastgele girişten iyi. Canlı takibe değer bir aday — yine de çok kural denediysen şans payı yüksek." };
    }
    if (a.avg > 0 && b.avg <= 0) return { level: "bad", text: "İlk dönemde kârlı, son 100 günde zararda: geçmişe uyan ama yeni veride tutmayan kural." };
    if (b.avg > 0 && a.avg <= 0) return { level: "warn", text: "Sadece son 100 günde kârlı. Tek dönemlik başarı çoğu zaman piyasa koşulundan gelir." };
    if (a.avg > r.rnd_train.avg && b.avg > r.rnd_test.avg) return { level: "bad", text: "Rastgele girişten iyi ama masraflardan sonra zararda: biraz bilgi taşıyor, para kazandırmıyor." };
    return { level: "bad", text: "Masraflardan sonra zararda ve rastgele girişten farksız ya da daha kötü." };
  };
  G.ClaudeLab = L;
})(typeof window !== "undefined" ? window : globalThis);

// ================== CONFIG ==================
const KST_TZ = "Asia/Seoul";
const BINANCE_REST = "https://api.binance.com/api/v3/klines";
const BINANCE_WS_BASE = "wss://stream.binance.com:9443/ws";

const EMA_FAST = 50;
const EMA_SLOW = 200;

const UI_THROTTLE_MS = 120;
const HEAVY_THROTTLE_MS = 900;

// ================== DOM ==================
const el = {
  symbol: document.getElementById("symbol"),
  tf: document.getElementById("tf"),
  limit: document.getElementById("limit"),
  reload: document.getElementById("reload"),
  auto: document.getElementById("auto"),
  badge: document.getElementById("signalBadge"),
  summary: document.getElementById("signalSummary"),
  lastPrice: document.getElementById("lastPrice"),
  trendText: document.getElementById("trendText"),
  reasons: document.getElementById("reasons"),
  entryHint: document.getElementById("entryHint"),
};

const chartEl = document.getElementById("chart");
const chartWrapEl = document.getElementById("chartWrap");
const obLayer = document.getElementById("obLayer");

// ================== UTILS ==================
const fmt = (n) => (n == null ? "-" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));

function setBadge(signal) {
  el.badge.className = "badge " + (signal === "LONG" ? "b-long" : signal === "SHORT" ? "b-short" : "b-wait");
  el.badge.textContent = signal;
}
function renderReasons(list) {
  el.reasons.innerHTML = "";
  list.slice(0, 10).forEach((t) => {
    const li = document.createElement("li");
    li.textContent = t;
    el.reasons.appendChild(li);
  });
}

function emaNext(prevEma, close, period) {
  const k = 2 / (period + 1);
  if (prevEma == null) return close;
  return close * k + prevEma * (1 - k);
}

function bodySize(c) { return Math.abs(c.close - c.open); }
function isBull(c) { return c.close >= c.open; }
function isBear(c) { return c.close < c.open; }

function inZone(price, zone) {
  if (!zone) return false;
  const lo = Math.min(zone.from, zone.to);
  const hi = Math.max(zone.from, zone.to);
  return price >= lo && price <= hi;
}

// ================== PATTERNS ==================
function swingHigh(candles, lookback = 20, endIndex = null) {
  const end = endIndex ?? candles.length - 1;
  const start = Math.max(0, end - lookback + 1);
  let m = -Infinity;
  for (let i = start; i <= end; i++) m = Math.max(m, candles[i].high);
  return m;
}
function swingLow(candles, lookback = 20, endIndex = null) {
  const end = endIndex ?? candles.length - 1;
  const start = Math.max(0, end - lookback + 1);
  let m = Infinity;
  for (let i = start; i <= end; i++) m = Math.min(m, candles[i].low);
  return m;
}

function detectFakeoutAt(candles, i, lookback = 25) {
  if (i <= 2) return null;
  const last = candles[i];
  const sh = swingHigh(candles, lookback, i - 1);
  const sl = swingLow(candles, lookback, i - 1);
  const upSweep = (last.high > sh) && (last.close < sh);
  const downSweep = (last.low < sl) && (last.close > sl);
  if (upSweep) return { type: "bear", level: sh };
  if (downSweep) return { type: "bull", level: sl };
  return null;
}

// ✅ 오더블럭(간단): 큰 임펄스 직전 마지막 반대 캔들
function detectLastOB(candles, scan = 280) {
  const start = Math.max(5, candles.length - scan);
  let last = null;

  const bodies = candles.slice(start).map(bodySize);
  const avg = bodies.reduce((a, b) => a + b, 0) / Math.max(1, bodies.length);

  for (let i = start + 2; i < candles.length; i++) {
    const cur = candles[i];
    const big = bodySize(cur) > avg * 1.6;
    if (!big) continue;

    if (isBull(cur)) {
      for (let j = i - 1; j >= start; j--) {
        if (isBear(candles[j])) { last = { type: "bull", from: candles[j].low, to: candles[j].open, i, j }; break; }
      }
    } else {
      for (let j = i - 1; j >= start; j--) {
        if (isBull(candles[j])) { last = { type: "bear", from: candles[j].open, to: candles[j].high, i, j }; break; }
      }
    }
  }
  return last;
}

// ================== CHART ==================
const chart = LightweightCharts.createChart(chartEl, {
  layout: { background: { color: "#101a2e" }, textColor: "#d7dbe7" },
  grid: { vertLines: { color: "#1e2a44" }, horzLines: { color: "#1e2a44" } },
  timeScale: { timeVisible: true, secondsVisible: true },
  rightPriceScale: { borderColor: "#223054" },
  crosshair: { mode: 1 },
  localization: {
    timeFormatter: (timeSec) => {
      const d = new Date(timeSec * 1000);
      return new Intl.DateTimeFormat("ko-KR", {
        timeZone: KST_TZ,
        year: "2-digit", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false,
      }).format(d);
    },
  },
});

// ✅ v4 방식
const candleSeries = chart.addCandlestickSeries();
const emaFastSeries = chart.addLineSeries({ lineWidth: 2 });
const emaSlowSeries = chart.addLineSeries({ lineWidth: 2 });

function updateSecondsVisible(tf) {
  const showSeconds = (tf === "1s" || tf === "1m" || tf === "3m" || tf === "5m");
  chart.applyOptions({ timeScale: { timeVisible: true, secondsVisible: showSeconds } });
}

// ================== OB BOX OVERLAY ==================
let obBoxEl = null;

function clearOBBox() {
  if (obBoxEl) {
    obBoxEl.remove();
    obBoxEl = null;
  }
}

function drawOBBox(ob, startTimeSec, endTimeSec) {
  if (!ob) { clearOBBox(); return; }

  const topPrice = Math.max(ob.from, ob.to);
  const botPrice = Math.min(ob.from, ob.to);

  const x1 = chart.timeScale().timeToCoordinate(startTimeSec);
  const x2 = chart.timeScale().timeToCoordinate(endTimeSec);
  const y1 = candleSeries.priceToCoordinate(topPrice);
  const y2 = candleSeries.priceToCoordinate(botPrice);

  if ([x1, x2, y1, y2].some(v => v == null)) return;

  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);

  if (!obBoxEl) {
    obBoxEl = document.createElement("div");
    obBoxEl.className = "ob-box";
    obLayer.appendChild(obBoxEl);
  }

  obBoxEl.classList.toggle("bear", ob.type === "bear");
  obBoxEl.style.left = `${left}px`;
  obBoxEl.style.top = `${top}px`;
  obBoxEl.style.width = `${Math.max(1, right - left)}px`;
  obBoxEl.style.height = `${Math.max(1, bottom - top)}px`;
}

// ================== STATE ==================
let candles = [];
let ws = null;
let wsWanted = true;

let emaFastPrev = null;
let emaSlowPrev = null;

let lastUIAt = 0;
let lastHeavyAt = 0;

let lastSignal = "WAIT";
let markers = [];

let lastOB = null;

// ================== REST ==================
async function fetchHistory(symbol, interval, limit) {
  const url = `${BINANCE_REST}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}&timeZone=9`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Binance REST 오류");
  const data = await res.json();
  return data.map(k => ({
    time: Math.floor(k[0] / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

function initEmaFromHistory() {
  emaFastPrev = null;
  emaSlowPrev = null;

  emaFastSeries.setData([]);
  emaSlowSeries.setData([]);

  for (const c of candles) {
    emaFastPrev = emaNext(emaFastPrev, c.close, EMA_FAST);
    emaSlowPrev = emaNext(emaSlowPrev, c.close, EMA_SLOW);
    emaFastSeries.update({ time: c.time, value: emaFastPrev });
    emaSlowSeries.update({ time: c.time, value: emaSlowPrev });
  }
}

// ================== SIGNAL ==================
function computeSignalAtClose(iClosed) {
  if (iClosed < 210) return "WAIT";

  const trendUp = emaFastPrev > emaSlowPrev;
  const fake = detectFakeoutAt(candles, iClosed, 25);

  let scoreLong = 0, scoreShort = 0;
  if (trendUp) scoreLong += 2; else scoreShort += 2;
  if (fake?.type === "bull") scoreLong += 2;
  if (fake?.type === "bear") scoreShort += 2;

  const px = candles[iClosed].close;
  if (lastOB) {
    if (lastOB.type === "bull" && inZone(px, lastOB)) scoreLong += 2;
    if (lastOB.type === "bear" && inZone(px, lastOB)) scoreShort += 2;
  }

  const diff = scoreLong - scoreShort;
  if (diff >= 2) return "LONG";
  if (diff <= -2) return "SHORT";
  return "WAIT";
}

// ================== WS ==================
function stopWS() {
  if (ws) {
    try { wsWanted = false; ws.close(); } catch {}
    ws = null;
  }
}

function startWS(symbol, interval) {
  wsWanted = true;
  const stream = `${symbol.toLowerCase()}@kline_${interval}`;
  const url = `${BINANCE_WS_BASE}/${stream}`;

  el.summary.textContent = `실시간 연결중… (${symbol} ${interval})`;

  ws = new WebSocket(url);

  ws.onopen = () => {
    el.summary.textContent = `실시간 연결됨 ✅ (${symbol} ${interval})`;
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg?.k) return;

    const k = msg.k;
    const bar = {
      time: Math.floor(k.t / 1000),
      open: Number(k.o),
      high: Number(k.h),
      low: Number(k.l),
      close: Number(k.c),
      volume: Number(k.v),
    };
    const isClosed = !!k.x;

    const last = candles[candles.length - 1];
    if (!last) return;

    // 캔들 즉시 반영(바이낸스 느낌)
    if (bar.time > last.time) {
      candles.push(bar);
      const max = Number(el.limit.value);
      if (candles.length > max) candles.shift();

      candleSeries.update(bar);

      // 확정 EMA 업데이트(새 캔들 시작)
      emaFastPrev = emaNext(emaFastPrev, bar.close, EMA_FAST);
      emaSlowPrev = emaNext(emaSlowPrev, bar.close, EMA_SLOW);
      emaFastSeries.update({ time: bar.time, value: emaFastPrev });
      emaSlowSeries.update({ time: bar.time, value: emaSlowPrev });

    } else if (bar.time === last.time) {
      candles[candles.length - 1] = bar;
      candleSeries.update(bar);

      // 표시용 EMA(진행중)
      const fastDisplay = emaNext(emaFastPrev, bar.close, EMA_FAST);
      const slowDisplay = emaNext(emaSlowPrev, bar.close, EMA_SLOW);
      emaFastSeries.update({ time: bar.time, value: fastDisplay });
      emaSlowSeries.update({ time: bar.time, value: slowDisplay });
    }

    const now = Date.now();
    if (now - lastUIAt >= UI_THROTTLE_MS) {
      lastUIAt = now;
      el.lastPrice.textContent = fmt(bar.close);

      const fastNow = emaNext(emaFastPrev, bar.close, EMA_FAST);
      const slowNow = emaNext(emaSlowPrev, bar.close, EMA_SLOW);
      el.trendText.textContent = `EMA${EMA_FAST} ${fmt(fastNow)} / EMA${EMA_SLOW} ${fmt(slowNow)}`;
    }

    // 무거운 작업은 마감에서만
    if (isClosed) {
      if (now - lastHeavyAt >= HEAVY_THROTTLE_MS) {
        lastHeavyAt = now;
        lastOB = detectLastOB(candles);

        // ✅ OB 박스 표시: OB 발생 캔들부터 ~ 최신 캔들까지
        if (lastOB) {
          const startTime = candles[lastOB.j]?.time ?? candles[lastOB.i]?.time ?? candles[0].time;
          const endTime = candles[candles.length - 1].time;
          drawOBBox(lastOB, startTime, endTime);
        } else {
          clearOBBox();
        }
      }

      const iClosed = candles.length - 1;
      const sig = computeSignalAtClose(iClosed);

      if (sig !== "WAIT" && sig !== lastSignal) {
        markers.push({
          time: candles[iClosed].time,
          position: sig === "LONG" ? "belowBar" : "aboveBar",
          shape: sig === "LONG" ? "arrowUp" : "arrowDown",
          text: sig,
        });
        candleSeries.setMarkers(markers);
      }

      lastSignal = sig;
      setBadge(sig);

      const reasons = [];
      reasons.push(emaFastPrev > emaSlowPrev ? `EMA${EMA_FAST} > EMA${EMA_SLOW} (상승 우위)` : `EMA${EMA_FAST} < EMA${EMA_SLOW} (하락 우위)`);
      if (lastOB) reasons.push(`오더블럭(박스): ${lastOB.type === "bull" ? "매수 OB" : "매도 OB"}`);
      reasons.push("마커: 신호 전환 시점만 표시");
      renderReasons(reasons);

      el.summary.textContent = sig === "LONG" ? "롱 우세" : sig === "SHORT" ? "숏 우세" : "관망";
    }
  };

  ws.onerror = () => {
    el.summary.textContent = "실시간 연결 오류 (네트워크/차단 가능)";
  };

  ws.onclose = () => {
    if (!wsWanted) return;
    el.summary.textContent = "실시간 끊김… 재연결 시도";
    setTimeout(() => {
      if (wsWanted) startWS(el.symbol.value, el.tf.value);
    }, 1200);
  };
}

// ================== HELPERS ==================
function redrawOB() {
  if (!lastOB || !candles.length) return;
  const startTime = candles[lastOB.j]?.time ?? candles[lastOB.i]?.time ?? candles[0].time;
  const endTime = candles[candles.length - 1].time;
  drawOBBox(lastOB, startTime, endTime);
}

// ================== MAIN ==================
async function fullReload() {
  const symbol = el.symbol.value;
  const tf = el.tf.value;
  const limit = Number(el.limit.value);

  updateSecondsVisible(tf);

  el.summary.textContent = "초기 데이터 불러오는 중…";
  setBadge("WAIT");

  stopWS();

  candles = await fetchHistory(symbol, tf, limit);

  candleSeries.setData(candles);
  initEmaFromHistory();

  lastOB = detectLastOB(candles);
  markers = [];
  candleSeries.setMarkers(markers);
  lastSignal = "WAIT";
  setBadge("WAIT");

  if (lastOB) {
    const startTime = candles[lastOB.j]?.time ?? candles[lastOB.i]?.time ?? candles[0].time;
    const endTime = candles[candles.length - 1].time;
    drawOBBox(lastOB, startTime, endTime);
  } else {
    clearOBBox();
  }

  chart.timeScale().fitContent();

  if (el.auto.dataset.on === "1") startWS(symbol, tf);
  else el.summary.textContent = "실시간 OFF (수동 불러오기만)";
}

// ================== EVENTS ==================
el.reload.addEventListener("click", () => {
  fullReload().catch((e) => (el.summary.textContent = "에러: " + e.message));
});

el.tf.addEventListener("change", () => fullReload().catch(e => el.summary.textContent = "에러: " + e.message));
el.symbol.addEventListener("change", () => fullReload().catch(e => el.summary.textContent = "에러: " + e.message));
el.limit.addEventListener("change", () => fullReload().catch(e => el.summary.textContent = "에러: " + e.message));

el.auto.textContent = "실시간 ON";
el.auto.dataset.on = "1";

el.auto.addEventListener("click", () => {
  const on = el.auto.dataset.on === "1";
  if (on) {
    el.auto.dataset.on = "0";
    el.auto.textContent = "실시간 OFF";
    wsWanted = false;
    stopWS();
    el.summary.textContent = "실시간 OFF (수동 불러오기만)";
  } else {
    el.auto.dataset.on = "1";
    el.auto.textContent = "실시간 ON";
    wsWanted = true;
    startWS(el.symbol.value, el.tf.value);
  }
});

// ✅ 줌/스크롤/리사이즈에도 OB 박스 따라오게
chart.timeScale().subscribeVisibleTimeRangeChange(() => redrawOB());
window.addEventListener("resize", () => setTimeout(redrawOB, 0));

// 최초 실행
fullReload().catch((e) => (el.summary.textContent = "에러: " + e.message));

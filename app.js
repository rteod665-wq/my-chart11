// ================== CONFIG ==================
const KST_TZ = "Asia/Seoul";
const BINANCE_REST = "https://api.binance.com/api/v3/klines";
const BINANCE_WS_BASE = "wss://stream.binance.com:9443/ws";

const EMA_FAST = 50;
const EMA_SLOW = 200;

// 상위 타임프레임 필터
const HTF = "15m";          // 15분봉 추세 필터
const ATR_PERIOD = 14;      // 변동성 필터
const ATR_MIN_RATIO = 0.001; // (ATR / 가격) 최소 비율, 낮으면 횡보로 간주

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

// ================== ATR ==================
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );
    sum += tr;
  }
  return sum / period;
}

// ================== PATTERNS ==================
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

// OB 안에서 반전 캔들(꼬리 + 되돌림)
function isRejectionCandle(c) {
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.close, c.open);
  const lowerWick = Math.min(c.close, c.open) - c.low;
  // 꼬리가 몸통보다 크면 거절 흔적으로 간주
  return (upperWick > body * 1.2) || (lowerWick > body * 1.2);
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

const candleSeries = chart.addCandlestickSeries();
const emaFastSeries = chart.addLineSeries({ lineWidth: 2 });
const emaSlowSeries = chart.addLineSeries({ lineWidth: 2 });

// ================== OB BOX ==================
let obBoxEl = null;
function clearOBBox() {
  if (obBoxEl) { obBoxEl.remove(); obBoxEl = null; }
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

// ================== ENTRY HINT ==================
function setEntryHintText(tf, ob){
  if(tf !== "5m"){
    el.entryHint.innerHTML = `현재는 <b>${tf}</b>입니다. <b>5분봉(5m)</b> 기준 진입가를 보려면 봉을 5m로 바꿔주세요.`;
    return;
  }
  if(!ob){
    el.entryHint.textContent = "5분봉 기준: 최근 오더블럭(OB)이 아직 감지되지 않았어요.";
    return;
  }
  const top = Math.max(ob.from, ob.to);
  const bot = Math.min(ob.from, ob.to);
  const mid = (top + bot) / 2;

  if(ob.type === "bull"){
    el.entryHint.innerHTML =
      `✅ <b>5분봉 기준 롱 후보</b><br>` +
      `진입 구간(OB): <b>${bot.toFixed(2)} ~ ${top.toFixed(2)}</b><br>` +
      `추천 진입가(중앙 50%): <b>${mid.toFixed(2)}</b><br>` +
      `손절 예시: OB 하단 <b>${(bot * 0.999).toFixed(2)}</b> 아래`;
  }else{
    el.entryHint.innerHTML =
      `✅ <b>5분봉 기준 숏 후보</b><br>` +
      `진입 구간(OB): <b>${bot.toFixed(2)} ~ ${top.toFixed(2)}</b><br>` +
      `추천 진입가(중앙 50%): <b>${mid.toFixed(2)}</b><br>` +
      `손절 예시: OB 상단 <b>${(top * 1.001).toFixed(2)}</b> 위`;
  }
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

// 상위 TF 상태
let htfCandles = [];
let htfEmaFast = null;
let htfEmaSlow = null;

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

// 상위 TF EMA 계산
function initHTF() {
  htfEmaFast = null;
  htfEmaSlow = null;
  for (const c of htfCandles) {
    htfEmaFast = emaNext(htfEmaFast, c.close, EMA_FAST);
    htfEmaSlow = emaNext(htfEmaSlow, c.close, EMA_SLOW);
  }
}
function htfTrend() {
  if (htfEmaFast == null || htfEmaSlow == null) return null;
  return htfEmaFast > htfEmaSlow ? "UP" : "DOWN";
}

// ================== SIGNAL ==================
function computeSignalAtClose(iClosed) {
  const reasons = [];

  // 메인 TF는 5m에서만 신호
  if (el.tf.value !== "5m") {
    return { sig: "WAIT", reasons: ["메인 기준은 5분봉(5m)입니다."] };
  }

  // 상위 TF 추세 필터
  const trend = htfTrend();
  if (!trend) {
    return { sig: "WAIT", reasons: ["상위 TF 추세 계산 대기"] };
  }
  reasons.push(`상위(${HTF}) 추세: ${trend === "UP" ? "상승" : "하락"}`);

  // 변동성 필터(ATR)
  const atr = calcATR(candles, ATR_PERIOD);
  if (!atr || (atr / candles[candles.length - 1].close) < ATR_MIN_RATIO) {
    return { sig: "WAIT", reasons: [...reasons, "변동성 낮음(횡보장) → 거래 회피"] };
  }
  reasons.push("변동성 OK");

  // OB 존재
  if (!lastOB) {
    return { sig: "WAIT", reasons: [...reasons, "오더블럭(OB) 없음"] };
  }
  reasons.push(`최근 OB: ${lastOB.type === "bull" ? "매수" : "매도"}`);

  const c = candles[iClosed];

  // OB 안으로 들어왔는지
  if (!inZone(c.close, lastOB)) {
    return { sig: "WAIT", reasons: [...reasons, "가격이 OB 구간 밖"] };
  }
  reasons.push("가격이 OB 구간 안");

  // 반전 캔들 확인
  if (!isRejectionCandle(c)) {
    return { sig: "WAIT", reasons: [...reasons, "반전(거절) 캔들 미확인"] };
  }
  reasons.push("반전(거절) 캔들 확인");

  // 방향 필터: OB 방향 + 상위 추세 일치만 허용
  if (lastOB.type === "bull" && trend === "UP") {
    return { sig: "LONG", reasons: [...reasons, "상위 추세 상승 + 매수 OB"] };
  }
  if (lastOB.type === "bear" && trend === "DOWN") {
    return { sig: "SHORT", reasons: [...reasons, "상위 추세 하락 + 매도 OB"] };
  }

  return { sig: "WAIT", reasons: [...reasons, "상위 추세와 OB 방향 불일치"] };
}

// ================== WS ==================
function stopWS() {
  if (ws) { try { wsWanted = false; ws.close(); } catch {} ws = null; }
}
function startWS(symbol, interval) {
  wsWanted = true;
  const stream = `${symbol.toLowerCase()}@kline_${interval}`;
  const url = `${BINANCE_WS_BASE}/${stream}`;

  el.summary.textContent = `실시간 연결중… (${symbol} ${interval})`;
  ws = new WebSocket(url);

  ws.onopen = () => { el.summary.textContent = `실시간 연결됨 ✅ (${symbol} ${interval})`; };

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

    if (bar.time > last.time) {
      candles.push(bar);
      const max = Number(el.limit.value);
      if (candles.length > max) candles.shift();
      candleSeries.update(bar);

      emaFastPrev = emaNext(emaFastPrev, bar.close, EMA_FAST);
      emaSlowPrev = emaNext(emaSlowPrev, bar.close, EMA_SLOW);
      emaFastSeries.update({ time: bar.time, value: emaFastPrev });
      emaSlowSeries.update({ time: bar.time, value: emaSlowPrev });

    } else if (bar.time === last.time) {
      candles[candles.length - 1] = bar;
      candleSeries.update(bar);

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

    if (isClosed) {
      if (now - lastHeavyAt >= HEAVY_THROTTLE_MS) {
        lastHeavyAt = now;
        lastOB = detectLastOB(candles);
        if (lastOB) {
          const startTime = candles[lastOB.j]?.time ?? candles[lastOB.i]?.time ?? candles[0].time;
          const endTime = candles[candles.length - 1].time;
          drawOBBox(lastOB, startTime, endTime);
        } else {
          clearOBBox();
        }
        setEntryHintText(el.tf.value, lastOB);
      }

      const iClosed = candles.length - 1;
      const { sig, reasons } = computeSignalAtClose(iClosed);

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
      renderReasons(reasons);
      el.summary.textContent = sig === "LONG" ? "롱 우세" : sig === "SHORT" ? "숏 우세" : "관망";
    }
  };

  ws.onerror = () => { el.summary.textContent = "실시간 연결 오류"; };
  ws.onclose = () => {
    if (!wsWanted) return;
    el.summary.textContent = "실시간 끊김… 재연결";
    setTimeout(() => { if (wsWanted) startWS(el.symbol.value, el.tf.value); }, 1200);
  };
}

// ================== MAIN ==================
async function fullReload() {
  const symbol = el.symbol.value;
  const tf = el.tf.value;
  const limit = Number(el.limit.value);

  el.summary.textContent = "데이터 불러오는 중…";
  setBadge("WAIT");
  stopWS();

  // 메인 TF
  candles = await fetchHistory(symbol, tf, limit);
  candleSeries.setData(candles);
  initEmaFromHistory();

  // 상위 TF
  htfCandles = await fetchHistory(symbol, HTF, 300);
  initHTF();

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
  setEntryHintText(tf, lastOB);

  chart.timeScale().fitContent();

  if (el.auto.dataset.on === "1") startWS(symbol, tf);
  else el.summary.textContent = "실시간 OFF (수동)";
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
    el.summary.textContent = "실시간 OFF (수동)";
  } else {
    el.auto.dataset.on = "1";
    el.auto.textContent = "실시간 ON";
    wsWanted = true;
    startWS(el.symbol.value, el.tf.value);
  }
});

// 최초 실행
fullReload().catch((e) => (el.summary.textContent = "에러: " + e.message));

// ================== CONFIG ==================
const KST_TZ = "Asia/Seoul";
const BINANCE_REST = "https://api.binance.com/api/v3/klines";
const BINANCE_WS_BASE = "wss://stream.binance.com:9443/ws";

// 메인: 5m에서만 신호
const MAIN_TF = "5m";
const HTF = "15m"; // 상위 추세 필터

const EMA_FAST = 50;
const EMA_SLOW = 200;

const ATR_PERIOD = 14;
// ATR/가격 비율이 이보다 낮으면 “너무 조용(횡보)”로 판단
const ATR_MIN_RATIO = 0.001;  // 0.10%
// 이보다 크면 “변동성 큼”
const ATR_HIGH_RATIO = 0.0022; // 0.22%

// OB 박스 끝을 “현재 시간”까지 연장(바이낸스 느낌)
const OB_TIME_EXTEND_SECONDS = 60 * 60 * 6; // 6시간 정도

const UI_THROTTLE_MS = 120;
const HEAVY_THROTTLE_MS = 900;

// 손절 버퍼(OB 살짝 아래/위)
const SL_BUFFER = 0.001; // 0.1%

// ================== DOM ==================
const el = {
  symbol: document.getElementById("symbol"),
  tf: document.getElementById("tf"),
  limit: document.getElementById("limit"),
  rr: document.getElementById("rr"),
  obCount: document.getElementById("obCount"),
  reload: document.getElementById("reload"),
  auto: document.getElementById("auto"),
  badge: document.getElementById("signalBadge"),
  summary: document.getElementById("signalSummary"),
  lastPrice: document.getElementById("lastPrice"),
  trendText: document.getElementById("trendText"),
  conditionText: document.getElementById("conditionText"),
  reasons: document.getElementById("reasons"),
  entryHint: document.getElementById("entryHint"),
  planHint: document.getElementById("planHint"),
};

const chartEl = document.getElementById("chart");
const obLayer = document.getElementById("obLayer");

// ================== UTILS ==================
const fmt = (n) => (n == null || Number.isNaN(n) ? "-" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const fmtPct = (x) => (x == null || Number.isNaN(x) ? "-" : `${(x * 100).toFixed(2)}%`);

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
// OB(간단): 큰 임펄스 직전 마지막 반대 캔들
function detectOBs(candles, scan = 420, maxCount = 5) {
  const start = Math.max(5, candles.length - scan);
  const bodies = candles.slice(start).map(bodySize);
  const avg = bodies.reduce((a, b) => a + b, 0) / Math.max(1, bodies.length);
  const out = [];

  for (let i = start + 2; i < candles.length; i++) {
    const cur = candles[i];
    const big = bodySize(cur) > avg * 1.6;
    if (!big) continue;

    let found = null;
    if (isBull(cur)) {
      for (let j = i - 1; j >= start; j--) {
        if (isBear(candles[j])) { found = { type: "bull", from: candles[j].low, to: candles[j].open, i, j, t: candles[j].time }; break; }
      }
    } else {
      for (let j = i - 1; j >= start; j--) {
        if (isBull(candles[j])) { found = { type: "bear", from: candles[j].open, to: candles[j].high, i, j, t: candles[j].time }; break; }
      }
    }
    if (found) out.push(found);
  }

  // 시간 기준으로 최신 maxCount개
  out.sort((a, b) => b.t - a.t);
  return out.slice(0, maxCount);
}

// OB 안에서 반전 캔들(꼬리 + 되돌림)
function isRejectionCandle(c) {
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.close, c.open);
  const lowerWick = Math.min(c.close, c.open) - c.low;
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

// ================== OB BOX (MULTI) ==================
let obBoxes = []; // [{ ob, el }]
function clearOBBoxes() {
  for (const x of obBoxes) x.el.remove();
  obBoxes = [];
}

function drawOBBoxes(obs, endTimeSec) {
  clearOBBoxes();
  if (!obs || !obs.length) return;

  // 최신이 제일 진하게
  const sorted = [...obs].sort((a, b) => b.t - a.t);

  for (let idx = 0; idx < sorted.length; idx++) {
    const ob = sorted[idx];
    const box = document.createElement("div");
    box.className = "ob-box";
    if (ob.type === "bear") box.classList.add("bear");
    if (idx !== 0) box.classList.add("dim");
    obLayer.appendChild(box);
    obBoxes.push({ ob, el: box });
  }

  redrawOBBoxes(endTimeSec);
}

function redrawOBBoxes(endTimeSec) {
  if (!obBoxes.length || !candles.length) return;

  for (const item of obBoxes) {
    const ob = item.ob;
    const box = item.el;

    const topPrice = Math.max(ob.from, ob.to);
    const botPrice = Math.min(ob.from, ob.to);

    const startTimeSec = candles[ob.j]?.time ?? ob.t ?? candles[0].time;
    const x1 = chart.timeScale().timeToCoordinate(startTimeSec);
    const x2 = chart.timeScale().timeToCoordinate(endTimeSec);

    const y1 = candleSeries.priceToCoordinate(topPrice);
    const y2 = candleSeries.priceToCoordinate(botPrice);

    if ([x1, x2, y1, y2].some(v => v == null)) {
      box.style.display = "none";
      continue;
    }
    box.style.display = "block";

    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const top = Math.min(y1, y2);
    const bottom = Math.max(y1, y2);

    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${Math.max(1, right - left)}px`;
    box.style.height = `${Math.max(1, bottom - top)}px`;
  }
}

// ================== ENTRY + PLAN TEXT ==================
function setEntryHintText(tf, ob){
  if(tf !== MAIN_TF){
    el.entryHint.innerHTML = `현재는 <b>${tf}</b>입니다. 신호/진입 기준은 <b>${MAIN_TF}</b> 입니다.`;
    return;
  }
  if(!ob){
    el.entryHint.textContent = `${MAIN_TF} 기준: 최근 오더블럭(OB)이 아직 감지되지 않았어요.`;
    return;
  }
  const top = Math.max(ob.from, ob.to);
  const bot = Math.min(ob.from, ob.to);
  const mid = (top + bot) / 2;

  if(ob.type === "bull"){
    el.entryHint.innerHTML =
      `✅ <b>${MAIN_TF} 기준 롱 후보</b><br>` +
      `진입 구간(OB): <b>${bot.toFixed(2)} ~ ${top.toFixed(2)}</b><br>` +
      `추천 진입가(중앙 50%): <b>${mid.toFixed(2)}</b>`;
  }else{
    el.entryHint.innerHTML =
      `✅ <b>${MAIN_TF} 기준 숏 후보</b><br>` +
      `진입 구간(OB): <b>${bot.toFixed(2)} ~ ${top.toFixed(2)}</b><br>` +
      `추천 진입가(중앙 50%): <b>${mid.toFixed(2)}</b>`;
  }
}

function setPlanHint(sig, ob, rr){
  if (el.tf.value !== MAIN_TF) {
    el.planHint.innerHTML = `플랜은 <b>${MAIN_TF}</b>에서만 자동 제안됩니다.`;
    return;
  }
  if (!ob || sig === "WAIT") {
    el.planHint.textContent = "플랜: 신호가 확정되면 손절/목표가를 자동 제안합니다.";
    return;
  }

  const top = Math.max(ob.from, ob.to);
  const bot = Math.min(ob.from, ob.to);
  const entry = (top + bot) / 2;

  let sl, tp, risk;
  if (sig === "LONG") {
    sl = bot * (1 - SL_BUFFER);
    risk = Math.max(0.0000001, entry - sl);
    tp = entry + rr * risk;
  } else {
    sl = top * (1 + SL_BUFFER);
    risk = Math.max(0.0000001, sl - entry);
    tp = entry - rr * risk;
  }

  const riskPct = risk / entry;

  el.planHint.innerHTML =
    `📌 <b>플랜(자동)</b> — 목표 <b>${rr}R</b><br>` +
    `진입가(권장): <b>${entry.toFixed(2)}</b><br>` +
    `손절가(SL): <b>${sl.toFixed(2)}</b> (리스크 ${fmtPct(riskPct)})<br>` +
    `목표가(TP): <b>${tp.toFixed(2)}</b>`;
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

let obs = [];       // 여러 OB
let lastOB = null;  // 최신 OB

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

// ================== CONDITION ==================
function updateConditionText() {
  const atr = calcATR(candles, ATR_PERIOD);
  if (!atr || !candles.length) {
    el.conditionText.textContent = "컨디션 계산 대기…";
    return { atr: null, ratio: null, label: "대기" };
  }

  const price = candles[candles.length - 1].close;
  const ratio = atr / price;

  let label = "보통";
  if (ratio < ATR_MIN_RATIO) label = "조용함(횡보 가능)";
  else if (ratio > ATR_HIGH_RATIO) label = "변동성 큼(주의)";

  const trend = htfTrend();
  const trendTxt = trend ? (trend === "UP" ? "상승 우위" : "하락 우위") : "계산 대기";

  el.conditionText.innerHTML =
    `상위(${HTF}) 추세: <b>${trendTxt}</b><br>` +
    `ATR(${ATR_PERIOD})/가격: <b>${(ratio*100).toFixed(2)}%</b> → <b>${label}</b>`;

  return { atr, ratio, label };
}

// ================== SIGNAL ==================
function computeSignalAtClose(iClosed) {
  const reasons = [];

  if (el.tf.value !== MAIN_TF) {
    return { sig: "WAIT", reasons: [`메인 기준은 ${MAIN_TF}입니다.`], obUsed: null };
  }

  // 상위 TF 추세 필터
  const trend = htfTrend();
  if (!trend) return { sig: "WAIT", reasons: ["상위 TF 추세 계산 대기"], obUsed: null };
  reasons.push(`상위(${HTF}) 추세: ${trend === "UP" ? "상승" : "하락"}`);

  // 변동성 필터
  const atr = calcATR(candles, ATR_PERIOD);
  const ratio = atr ? atr / candles[candles.length - 1].close : null;
  if (!atr || ratio < ATR_MIN_RATIO) {
    return { sig: "WAIT", reasons: [...reasons, "변동성 낮음 → 거래 회피"], obUsed: null };
  }
  reasons.push("변동성 OK");

  // OB 존재
  if (!lastOB) return { sig: "WAIT", reasons: [...reasons, "오더블럭(OB) 없음"], obUsed: null };
  reasons.push(`최신 OB: ${lastOB.type === "bull" ? "매수" : "매도"}`);

  const c = candles[iClosed];

  // OB 안 진입
  if (!inZone(c.close, lastOB)) {
    return { sig: "WAIT", reasons: [...reasons, "가격이 OB 구간 밖"], obUsed: lastOB };
  }
  reasons.push("가격이 OB 구간 안");

  // 반전 캔들 확인
  if (!isRejectionCandle(c)) {
    return { sig: "WAIT", reasons: [...reasons, "반전(거절) 캔들 미확인"], obUsed: lastOB };
  }
  reasons.push("반전(거절) 캔들 확인");

  // 방향 필터: OB 방향 + 상위 추세 일치만
  if (lastOB.type === "bull" && trend === "UP") {
    return { sig: "LONG", reasons: [...reasons, "상위 상승 + 매수 OB"], obUsed: lastOB };
  }
  if (lastOB.type === "bear" && trend === "DOWN") {
    return { sig: "SHORT", reasons: [...reasons, "상위 하락 + 매도 OB"], obUsed: lastOB };
  }
  return { sig: "WAIT", reasons: [...reasons, "상위 추세와 OB 방향 불일치"], obUsed: lastOB };
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

    // 캔들 업데이트
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

    // 마감봉에서만 무거운 작업
    if (isClosed) {
      if (now - lastHeavyAt >= HEAVY_THROTTLE_MS) {
        lastHeavyAt = now;

        // OB 갱신(여러 개)
        const count = Number(el.obCount.value);
        obs = detectOBs(candles, 520, count);
        lastOB = obs[0] ?? null;

        // OB 박스 그리기
        const endTime = candles[candles.length - 1].time + OB_TIME_EXTEND_SECONDS;
        drawOBBoxes(obs, endTime);

        // 컨디션 텍스트 갱신
        updateConditionText();

        // 5분봉 기준 텍스트
        setEntryHintText(el.tf.value, lastOB);
      }

      // 신호 계산
      const iClosed = candles.length - 1;
      const { sig, reasons, obUsed } = computeSignalAtClose(iClosed);

      // 신호 전환 시 마커
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

      // 플랜 제안
      const rr = Number(el.rr.value);
      setPlanHint(sig, obUsed, rr);

      el.summary.textContent = sig === "LONG" ? "롱 우세" : sig === "SHORT" ? "숏 우세" : "관망";

      // 박스 위치 재계산(보이는 범위 변경/업데이트 대비)
      const endTime = candles[candles.length - 1].time + OB_TIME_EXTEND_SECONDS;
      redrawOBBoxes(endTime);
    }
  };

  ws.onerror = () => { el.summary.textContent = "실시간 연결 오류"; };
  ws.onclose = () => {
    if (!wsWanted) return;
    el.summary.textContent = "실시간 끊김… 재연결";
    setTimeout(() => {
      if (wsWanted) startWS(el.symbol.value, el.tf.value);
    }, 1200);
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

  // OB 여러 개
  const count = Number(el.obCount.value);
  obs = detectOBs(candles, 520, count);
  lastOB = obs[0] ?? null;

  markers = [];
  candleSeries.setMarkers(markers);
  lastSignal = "WAIT";
  setBadge("WAIT");

  const endTime = candles[candles.length - 1].time + OB_TIME_EXTEND_SECONDS;
  drawOBBoxes(obs, endTime);

  setEntryHintText(tf, lastOB);
  updateConditionText();
  setPlanHint("WAIT", lastOB, Number(el.rr.value));

  chart.timeScale().fitContent();

  if (el.auto.dataset.on === "1") startWS(symbol, tf);
  else el.summary.textContent = "실시간 OFF (수동)";
}

// ================== EVENTS ==================
el.reload.addEventListener("click", () => fullReload().catch(e => el.summary.textContent = "에러: " + e.message));
el.tf.addEventListener("change", () => fullReload().catch(e => el.summary.textContent = "에러: " + e.message));
el.symbol.addEventListener("change", () => fullReload().catch(e => el.summary.textContent = "에러: " + e.message));
el.limit.addEventListener("change", () => fullReload().catch(e => el.summary.textContent = "에러: " + e.message));
el.rr.addEventListener("change", () => {
  // RR만 바뀌면 플랜만 다시 계산
  setPlanHint(lastSignal, lastOB, Number(el.rr.value));
});
el.obCount.addEventListener("change", () => fullReload().catch(e => el.summary.textContent = "에러: " + e.message));

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

// 줌/스크롤/리사이즈 때 박스 다시 그리기
chart.timeScale().subscribeVisibleTimeRangeChange(() => {
  if (!candles.length) return;
  const endTime = candles[candles.length - 1].time + OB_TIME_EXTEND_SECONDS;
  redrawOBBoxes(endTime);
});
window.addEventListener("resize", () => {
  if (!candles.length) return;
  const endTime = candles[candles.length - 1].time + OB_TIME_EXTEND_SECONDS;
  setTimeout(() => redrawOBBoxes(endTime), 0);
});

// 최초 실행
fullReload().catch(e => el.summary.textContent = "에러: " + e.message);

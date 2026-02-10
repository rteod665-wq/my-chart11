// ================== SETTINGS ==================
const KST_TZ = "Asia/Seoul";
const BINANCE_REST = "https://api.binance.com/api/v3/klines";
const BINANCE_WS_BASE = "wss://stream.binance.com:9443/ws";
let MAX_BARS = 500; // UI select값으로 덮어씀

// ================== HELPERS ==================
const fmt = (n) => (n==null ? "-" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));

function ema(values, period){
  const k = 2/(period+1);
  let out = [];
  let prev = null;
  for (let i=0;i<values.length;i++){
    const v = values[i];
    prev = (prev===null) ? v : (v*k + prev*(1-k));
    out.push(prev);
  }
  return out;
}

function bodySize(c){ return Math.abs(c.close - c.open); }
function isBull(c){ return c.close >= c.open; }
function isBear(c){ return c.close < c.open; }

function swingHigh(candles, lookback=20, endIndex=null){
  const end = endIndex ?? candles.length-1;
  const start = Math.max(0, end - lookback + 1);
  let m = -Infinity, idx=-1;
  for(let i=start;i<=end;i++){
    if(candles[i].high > m){ m=candles[i].high; idx=i; }
  }
  return {price:m, idx};
}
function swingLow(candles, lookback=20, endIndex=null){
  const end = endIndex ?? candles.length-1;
  const start = Math.max(0, end - lookback + 1);
  let m = Infinity, idx=-1;
  for(let i=start;i<=end;i++){
    if(candles[i].low < m){ m=candles[i].low; idx=i; }
  }
  return {price:m, idx};
}

// FVG (간단)
function detectLastFVG(candles, scan=200){
  let last = null;
  const start = Math.max(2, candles.length - scan);
  for(let i=start;i<candles.length;i++){
    const a = candles[i-2], c = candles[i];
    if(a.high < c.low) last = {type:"bull", from:a.high, to:c.low, i};
    else if(a.low > c.high) last = {type:"bear", from:c.high, to:a.low, i};
  }
  return last;
}

// Fakeout (간단)
function detectFakeoutAt(candles, i, lookback=25){
  if(i<=2) return null;
  const last = candles[i];
  const sh = swingHigh(candles, lookback, i-1);
  const sl = swingLow(candles, lookback, i-1);
  const upSweep = (last.high > sh.price) && (last.close < sh.price);
  const downSweep = (last.low < sl.price) && (last.close > sl.price);
  if(upSweep) return {type:"bear", level: sh.price};
  if(downSweep) return {type:"bull", level: sl.price};
  return null;
}

// Order Block (초기형)
function detectLastOB(candles, scan=260){
  const start = Math.max(5, candles.length - scan);
  let last = null;

  const bodies = candles.slice(start).map(bodySize);
  const avg = bodies.reduce((a,b)=>a+b,0)/Math.max(1,bodies.length);

  for(let i=start+2;i<candles.length;i++){
    const cur = candles[i];
    const big = bodySize(cur) > avg*1.6;
    if(!big) continue;

    if(isBull(cur)){
      for(let j=i-1;j>=start;j--){
        if(isBear(candles[j])){
          last = {type:"bull", from:candles[j].low, to:candles[j].open, i, j};
          break;
        }
      }
    }else{
      for(let j=i-1;j>=start;j--){
        if(isBull(candles[j])){
          last = {type:"bear", from:candles[j].open, to:candles[j].high, i, j};
          break;
        }
      }
    }
  }
  return last;
}

function inZone(price, zone){
  if(!zone) return false;
  const lo = Math.min(zone.from, zone.to);
  const hi = Math.max(zone.from, zone.to);
  return price >= lo && price <= hi;
}

// ================== SIGNALS / MARKERS ==================
function buildSignals(candles){
  const closes = candles.map(c=>c.close);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);

  const lastFVG = detectLastFVG(candles);
  const lastOB  = detectLastOB(candles);

  const markers = [];
  let lastState = "WAIT";

  // 너무 초기에 EMA가 불안정해서 210부터 평가
  for(let i=210;i<candles.length;i++){
    const trendUp = e50[i] > e200[i];
    const slopeUp = (e50[i] - e50[i-5]) > 0;
    const fake = detectFakeoutAt(candles, i, 25);

    let scoreLong=0, scoreShort=0;

    if(trendUp) scoreLong += 2; else scoreShort += 2;
    if(slopeUp) scoreLong += 1; else scoreShort += 1;
    if(fake?.type==="bull") scoreLong += 2;
    if(fake?.type==="bear") scoreShort += 2;

    const px = candles[i].close;
    if(lastFVG){
      if(lastFVG.type==="bull" && inZone(px, lastFVG)) scoreLong += 2;
      if(lastFVG.type==="bear" && inZone(px, lastFVG)) scoreShort += 2;
    }
    if(lastOB){
      if(lastOB.type==="bull" && inZone(px, lastOB)) scoreLong += 2;
      if(lastOB.type==="bear" && inZone(px, lastOB)) scoreShort += 2;
    }

    const diff = scoreLong - scoreShort;
    let state = "WAIT";
    if(diff >= 2) state = "LONG";
    else if(diff <= -2) state = "SHORT";

    if(state !== "WAIT" && state !== lastState){
      markers.push({
        time: candles[i].time,
        position: state==="LONG" ? "belowBar" : "aboveBar",
        shape: state==="LONG" ? "arrowUp" : "arrowDown",
        text: state,
      });
    }
    lastState = state;
  }

  return { e50, e200, lastFVG, lastOB, markers, lastState };
}

// ================== UI ==================
function setBadge(signal){
  const badge = document.getElementById("signalBadge");
  badge.className = "badge " + (signal==="LONG" ? "b-long" : signal==="SHORT" ? "b-short" : "b-wait");
  badge.textContent = signal;
}
function renderReasons(list){
  const ul = document.getElementById("reasons");
  ul.innerHTML = "";
  list.slice(0,8).forEach(t=>{
    const li = document.createElement("li");
    li.textContent = t;
    ul.appendChild(li);
  });
}

// ================== CHART (Lightweight v4) ==================
const chart = LightweightCharts.createChart(document.getElementById("chart"), {
  layout: { background: { color: "#101a2e" }, textColor: "#d7dbe7" },
  grid: { vertLines: { color: "#1e2a44" }, horzLines: { color: "#1e2a44" } },
  timeScale: { timeVisible: true, secondsVisible: true },
  rightPriceScale: { borderColor: "#223054" },
  crosshair: { mode: 1 },
  localization: {
    // ✅ 한국시간 표시
    timeFormatter: (timeSec) => {
      const d = new Date(timeSec * 1000);
      return new Intl.DateTimeFormat("ko-KR", {
        timeZone: KST_TZ,
        year: "2-digit", month:"2-digit", day:"2-digit",
        hour:"2-digit", minute:"2-digit", second:"2-digit",
        hour12: false,
      }).format(d);
    }
  }
});

const candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries);
const ema50Series  = chart.addSeries(LightweightCharts.LineSeries, { lineWidth: 2 });
const ema200Series = chart.addSeries(LightweightCharts.LineSeries, { lineWidth: 2 });

// “오더박스/갭”은 사각형 박스 대신 (안정/호환 위해) 상·하단 라인 2개로 표시
let obTopLine=null, obBotLine=null, fvgTopLine=null, fvgBotLine=null;
function clearZoneLines(){
  if(obTopLine){ candleSeries.removePriceLine(obTopLine); obTopLine=null; }
  if(obBotLine){ candleSeries.removePriceLine(obBotLine); obBotLine=null; }
  if(fvgTopLine){ candleSeries.removePriceLine(fvgTopLine); fvgTopLine=null; }
  if(fvgBotLine){ candleSeries.removePriceLine(fvgBotLine); fvgBotLine=null; }
}
function drawZoneLines(zone, kind){
  if(!zone) return;
  const lo = Math.min(zone.from, zone.to);
  const hi = Math.max(zone.from, zone.to);

  const title = kind==="OB"
    ? (zone.type==="bull" ? "OB(buy)" : "OB(sell)")
    : (zone.type==="bull" ? "FVG(bull)" : "FVG(bear)");

  const top = candleSeries.createPriceLine({
    price: hi, title: `${title} hi`,
    lineWidth: 1, lineStyle: 2, axisLabelVisible: true
  });
  const bot = candleSeries.createPriceLine({
    price: lo, title: `${title} lo`,
    lineWidth: 1, lineStyle: 2, axisLabelVisible: true
  });

  if(kind==="OB"){ obTopLine=top; obBotLine=bot; }
  else { fvgTopLine=top; fvgBotLine=bot; }
}

// ================== DATA (REST 초기 + WS 실시간) ==================
let candles = [];
let ws = null;
let wsWanted = true;
let lastComputeAt = 0;

function toLineData(values, candles){
  return values.map((v,i)=>({ time: candles[i].time, value: v }));
}

async function fetchHistory(symbol, interval, limit){
  // REST는 1s 포함 지원 (market data endpoints 문서) :contentReference[oaicite:1]{index=1}
  const url = `${BINANCE_REST}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}&timeZone=9`;
  const res = await fetch(url);
  if(!res.ok) throw new Error("Binance REST 오류");
  const data = await res.json();
  return data.map(k=>({
    time: Math.floor(k[0]/1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

function updateSecondsVisible(tf){
  const showSeconds = (tf==="1s" || tf==="1m" || tf==="3m" || tf==="5m");
  chart.applyOptions({ timeScale: { timeVisible: true, secondsVisible: showSeconds } });
}

function stopWS(){
  if(ws){
    try{ wsWanted = false; ws.close(); }catch(e){}
    ws = null;
  }
}
function startWS(symbol, interval){
  wsWanted = true;
  const sym = symbol.toLowerCase();
  const stream = `${sym}@kline_${interval}`; // kline 스트림이 “진행 중 캔들”을 계속 푸시 :contentReference[oaicite:2]{index=2}
  const url = `${BINANCE_WS_BASE}/${stream}`;

  document.getElementById("signalSummary").textContent = `실시간 연결중… (${symbol} ${interval})`;

  ws = new WebSocket(url);

  ws.onopen = () => {
    document.getElementById("signalSummary").textContent = `실시간 연결됨 ✅ (${symbol} ${interval})`;
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if(!msg?.k) return;

    const k = msg.k;
    const t = Math.floor(k.t / 1000);

    const bar = {
      time: t,
      open: Number(k.o),
      high: Number(k.h),
      low:  Number(k.l),
      close:Number(k.c),
      volume:Number(k.v),
    };

    // 마지막 캔들 갱신 또는 새 캔들 추가
    const last = candles[candles.length-1];
    if(!last || bar.time > last.time){
      candles.push(bar);
      if(candles.length > MAX_BARS) candles.shift();
      candleSeries.update(bar);
    }else if(bar.time === last.time){
      candles[candles.length-1] = bar;
      candleSeries.update(bar);
    }

    // 너무 자주(초당 수십번) 전체 재계산하면 렉 → 1초에 1번만 계산
    const now = Date.now();
    if(now - lastComputeAt < 150) return;
    lastComputeAt = now;

    // EMA/신호/마커 업데이트(최근 데이터 기반)
    if(candles.length < 220) return;

    const sig = buildSignals(candles);
    ema50Series.setData(toLineData(sig.e50, candles));
    ema200Series.setData(toLineData(sig.e200, candles));
    candleSeries.setMarkers(sig.markers);

    clearZoneLines();
    drawZoneLines(sig.lastOB, "OB");
    drawZoneLines(sig.lastFVG, "FVG");

    const lastClose = candles.at(-1)?.close;
    document.getElementById("lastPrice").textContent = fmt(lastClose);
    document.getElementById("trendText").textContent =
      `EMA50 ${fmt(sig.e50.at(-1))} / EMA200 ${fmt(sig.e200.at(-1))}`;

    setBadge(sig.lastState);

    const reasons = [];
    reasons.push(sig.e50.at(-1) > sig.e200.at(-1) ? "EMA50 > EMA200 (상승 우위)" : "EMA50 < EMA200 (하락 우위)");
    reasons.push((sig.e50.at(-1) - sig.e50.at(-6)) > 0 ? "EMA50 기울기 + (상승 모멘텀)" : "EMA50 기울기 - (하락 모멘텀)");
    if(sig.lastOB) reasons.push(`최근 OB 라인 표시 (${sig.lastOB.type==="bull" ? "매수" : "매도"})`);
    if(sig.lastFVG) reasons.push(`최근 FVG 라인 표시 (${sig.lastFVG.type==="bull" ? "bull" : "bear"})`);
    reasons.push("LONG/SHORT 전환 시 화살표 마커 표시");
    renderReasons(reasons);
  };

  ws.onerror = () => {
    document.getElementById("signalSummary").textContent = "실시간 연결 오류 (네트워크/차단 가능)";
  };

  ws.onclose = () => {
    if(!wsWanted) return;
    document.getElementById("signalSummary").textContent = "실시간 연결 끊김… 재연결 시도";
    // 간단 재연결
    setTimeout(()=>{
      if(wsWanted) startWS(symbol, interval);
    }, 1500);
  };
}

// ================== MAIN LOAD ==================
async function fullReload(){
  const symbol = document.getElementById("symbol").value;
  const tf = document.getElementById("tf").value;
  const limit = Number(document.getElementById("limit").value);

  MAX_BARS = limit;
  updateSecondsVisible(tf);

  document.getElementById("signalSummary").textContent = "초기 데이터 불러오는 중…";
  setBadge("WAIT");

  // WS 먼저 끊고
  stopWS();

  // 초기 히스토리(REST)
  candles = await fetchHistory(symbol, tf, limit);

  candleSeries.setData(candles);

  if(candles.length >= 220){
    const sig = buildSignals(candles);
    ema50Series.setData(toLineData(sig.e50, candles));
    ema200Series.setData(toLineData(sig.e200, candles));
    candleSeries.setMarkers(sig.markers);

    clearZoneLines();
    drawZoneLines(sig.lastOB, "OB");
    drawZoneLines(sig.lastFVG, "FVG");

    const lastClose = candles.at(-1)?.close;
    document.getElementById("lastPrice").textContent = fmt(lastClose);
    document.getElementById("trendText").textContent =
      `EMA50 ${fmt(sig.e50.at(-1))} / EMA200 ${fmt(sig.e200.at(-1))}`;

    setBadge(sig.lastState);

    const reasons = [];
    reasons.push(sig.e50.at(-1) > sig.e200.at(-1) ? "EMA50 > EMA200 (상승 우위)" : "EMA50 < EMA200 (하락 우위)");
    reasons.push((sig.e50.at(-1) - sig.e50.at(-6)) > 0 ? "EMA50 기울기 + (상승 모멘텀)" : "EMA50 기울기 - (하락 모멘텀)");
    if(sig.lastOB) reasons.push(`최근 OB 라인 표시 (${sig.lastOB.type==="bull" ? "매수" : "매도"})`);
    if(sig.lastFVG) reasons.push(`최근 FVG 라인 표시 (${sig.lastFVG.type==="bull" ? "bull" : "bear"})`);
    reasons.push("LONG/SHORT 전환 시 화살표 마커 표시");
    renderReasons(reasons);
  }

  chart.timeScale().fitContent();

  // 실시간 WS 시작
  startWS(symbol, tf);
}

document.getElementById("reload").addEventListener("click", ()=> {
  fullReload().catch(e=>{
    document.getElementById("signalSummary").textContent = "에러: " + e.message;
  });
});

// 자동갱신 버튼은 “실시간 ON/OFF” 토글로 사용
document.getElementById("auto").textContent = "실시간 ON";
document.getElementById("auto").dataset.on = "1";

document.getElementById("auto").addEventListener("click", (e)=>{
  const btn = e.currentTarget;
  const on = btn.dataset.on === "1";
  if(on){
    btn.dataset.on = "0";
    btn.textContent = "실시간 OFF";
    wsWanted = false;
    stopWS();
    document.getElementById("signalSummary").textContent = "실시간 OFF (수동 불러오기만)";
  }else{
    btn.dataset.on = "1";
    btn.textContent = "실시간 ON";
    wsWanted = true;
    const symbol = document.getElementById("symbol").value;
    const tf = document.getElementById("tf").value;
    startWS(symbol, tf);
  }
});

// 최초 실행
fullReload().catch(e=>{
  document.getElementById("signalSummary").textContent = "에러: " + e.message;
});

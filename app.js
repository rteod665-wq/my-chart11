// ================== CONFIG ==================
const KST_TZ = "Asia/Seoul";
const BINANCE_BASE = "https://api.binance.com";
const BINANCE_TIMEZONE_PARAM = "9"; // KST(UTC+9) - kline interval 해석용 :contentReference[oaicite:1]{index=1}

// ================== UTILS ==================
const fmt = (n) => (n==null?'-':Number(n).toLocaleString(undefined,{maximumFractionDigits:2}));
const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));

function ema(values, period){
  const k = 2/(period+1);
  let out = [];
  let prev = null;
  for(let i=0;i<values.length;i++){
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
  let m = -Infinity, idx=-1;
  const start = Math.max(0, end - lookback + 1);
  for(let i=start;i<=end;i++){
    if(candles[i].high > m){ m=candles[i].high; idx=i; }
  }
  return {price:m, idx};
}
function swingLow(candles, lookback=20, endIndex=null){
  const end = endIndex ?? candles.length-1;
  let m = Infinity, idx=-1;
  const start = Math.max(0, end - lookback + 1);
  for(let i=start;i<=end;i++){
    if(candles[i].low < m){ m=candles[i].low; idx=i; }
  }
  return {price:m, idx};
}

// FVG (간단): i-2.high < i.low => bullish gap, i-2.low > i.high => bearish gap
function detectLastFVG(candles, scan=200){
  let last = null;
  const start = Math.max(2, candles.length - scan);
  for(let i=start;i<candles.length;i++){
    const a = candles[i-2], c = candles[i];
    if(a.high < c.low) last = {type:'bull', from:a.high, to:c.low, i};
    else if(a.low > c.high) last = {type:'bear', from:c.high, to:a.low, i};
  }
  return last;
}

// Fakeout/Trap (간단): 최근 스윙 돌파(윅) 후 종가가 다시 안쪽
function detectFakeoutAt(candles, i, lookback=25){
  if(i <= 1) return null;
  const last = candles[i];
  const prevEnd = i-1;
  const sh = swingHigh(candles, lookback, prevEnd);
  const sl = swingLow(candles, lookback, prevEnd);

  const upSweep = (last.high > sh.price) && (last.close < sh.price);
  const downSweep = (last.low < sl.price) && (last.close > sl.price);

  if(upSweep) return {type:'bear', level:sh.price};
  if(downSweep) return {type:'bull', level:sl.price};
  return null;
}

// Order Block (초기형): 큰 임펄스 직전 마지막 반대캔들의 구간을 OB로
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
          last = {type:'bull', from:candles[j].low, to:candles[j].open, i, j};
          break;
        }
      }
    }else{
      for(let j=i-1;j>=start;j--){
        if(isBull(candles[j])){
          last = {type:'bear', from:candles[j].open, to:candles[j].high, i, j};
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

// ================== SIGNAL ENGINE ==================
function buildSignals(candles){
  const closes = candles.map(c=>c.close);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);

  const markers = [];
  let lastState = "WAIT";

  // 마지막 OB/FVG는 화면에 "존"으로 표시(최신 1개)
  const lastFVG = detectLastFVG(candles);
  const lastOB  = detectLastOB(candles);

  for(let i=210;i<candles.length;i++){
    const trendUp = e50[i] > e200[i];
    const slopeUp = (e50[i] - e50[i-5]) > 0;

    const fake = detectFakeoutAt(candles, i, 25);

    let scoreLong = 0, scoreShort = 0;

    // 추세
    if(trendUp) scoreLong += 2; else scoreShort += 2;
    if(slopeUp) scoreLong += 1; else scoreShort += 1;

    // Fakeout
    if(fake?.type==="bull") scoreLong += 2;
    if(fake?.type==="bear") scoreShort += 2;

    // 최신 존 터치(최근 생성된 FVG/OB만 기준으로)
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

    // 상태가 바뀌는 순간만 마커 찍기
    if(state !== "WAIT" && state !== lastState){
      markers.push({
        time: candles[i].time,
        position: state==="LONG" ? "belowBar" : "aboveBar",
        shape: state==="LONG" ? "arrowUp" : "arrowDown",
        text: state==="LONG" ? "LONG" : "SHORT",
      });
    }
    lastState = state;
  }

  return {
    e50, e200,
    lastFVG, lastOB,
    markers,
    lastState,
  };
}

// ================== CHART (Lightweight v4) ==================
const chart = LightweightCharts.createChart(document.getElementById('chart'), {
  layout: { background: { color: '#101a2e' }, textColor: '#d7dbe7' },
  grid: { vertLines: { color: '#1e2a44' }, horzLines: { color: '#1e2a44' } },
  timeScale: { timeVisible: true, secondsVisible: true },
  rightPriceScale: { borderColor: '#223054' },
  crosshair: { mode: 1 },

  // ✅ 한국시간(KST) 표시: 라벨/크로스헤어 시간 포맷을 Asia/Seoul로
  localization: {
    timeFormatter: (timeSec) => {
      // timeSec은 epoch seconds
      const d = new Date(timeSec * 1000);
      return new Intl.DateTimeFormat("ko-KR", {
        timeZone: KST_TZ,
        year: "2-digit",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(d);
    }
  },
});

const candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries);
const ema50Series  = chart.addSeries(LightweightCharts.LineSeries, { lineWidth: 2 });
const ema200Series = chart.addSeries(LightweightCharts.LineSeries, { lineWidth: 2 });

let autoTimer = null;

// OB / FVG “존” 표시용 가격선(위/아래 2줄)
let obTopLine = null, obBotLine = null;
let fvgTopLine = null, fvgBotLine = null;

function clearZoneLines(){
  if(obTopLine){ candleSeries.removePriceLine(obTopLine); obTopLine = null; }
  if(obBotLine){ candleSeries.removePriceLine(obBotLine); obBotLine = null; }
  if(fvgTopLine){ candleSeries.removePriceLine(fvgTopLine); fvgTopLine = null; }
  if(fvgBotLine){ candleSeries.removePriceLine(fvgBotLine); fvgBotLine = null; }
}

function drawZoneLines(zone, kind){
  if(!zone) return;
  const lo = Math.min(zone.from, zone.to);
  const hi = Math.max(zone.from, zone.to);

  const title = (kind==="OB")
    ? (zone.type==="bull" ? "OB(buy)" : "OB(sell)")
    : (zone.type==="bull" ? "FVG(bull)" : "FVG(bear)");

  // 같은 스타일로 위/아래 라인 생성
  const top = candleSeries.createPriceLine({
    price: hi,
    title: `${title} hi`,
    lineWidth: 1,
    lineStyle: 2,
    axisLabelVisible: true,
  });
  const bot = candleSeries.createPriceLine({
    price: lo,
    title: `${title} lo`,
    lineWidth: 1,
    lineStyle: 2,
    axisLabelVisible: true,
  });

  if(kind==="OB"){ obTopLine = top; obBotLine = bot; }
  else { fvgTopLine = top; fvgBotLine = bot; }
}

function setBadge(signal){
  const badge = document.getElementById('signalBadge');
  badge.className = 'badge ' + (signal==='LONG'?'b-long':signal==='SHORT'?'b-short':'b-wait');
  badge.textContent = signal;
}
function renderReasons(list){
  const ul = document.getElementById('reasons');
  ul.innerHTML = '';
  list.slice(0,8).forEach(t=>{
    const li = document.createElement('li');
    li.textContent = t;
    ul.appendChild(li);
  });
}

async function fetchBinance(symbol, interval, limit){
  // ✅ timeZone 파라미터: 캔들 “구간 해석”을 KST 기준으로 해석하도록(문서) :contentReference[oaicite:2]{index=2}
  const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}&timeZone=${encodeURIComponent(BINANCE_TIMEZONE_PARAM)}`;
  const res = await fetch(url);
  if(!res.ok) throw new Error("Binance API 오류");
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

function toLineData(values, candles){
  return values.map((v,i)=>({ time: candles[i].time, value: v }));
}

function updateSecondsVisible(tf){
  // 1s/1m 같이 초가 의미있는 구간이면 secondsVisible true
  const showSeconds = (tf === "1s" || tf === "1m" || tf === "3m" || tf === "5m");
  chart.applyOptions({ timeScale: { secondsVisible: showSeconds, timeVisible: true } });
}

async function load(){
  const symbol = document.getElementById('symbol').value;
  const tf = document.getElementById('tf').value;
  const limit = Number(document.getElementById('limit').value);

  updateSecondsVisible(tf);

  document.getElementById('signalSummary').textContent = "데이터 불러오는 중…";
  setBadge("WAIT");

  const candles = await fetchBinance(symbol, tf, limit);

  candleSeries.setData(candles);

  const sig = buildSignals(candles);

  ema50Series.setData(toLineData(sig.e50, candles));
  ema200Series.setData(toLineData(sig.e200, candles));

  // ✅ LONG/SHORT 마커 표시
  candleSeries.setMarkers(sig.markers);

  // ✅ OB/FVG 구간(위/아래 2줄) 표시
  clearZoneLines();
  drawZoneLines(sig.lastOB, "OB");
  drawZoneLines(sig.lastFVG, "FVG");

  // 사이드 UI
  const lastClose = candles.at(-1)?.close;
  document.getElementById('lastPrice').textContent = fmt(lastClose);
  document.getElementById('trendText').textContent =
    `EMA50 ${fmt(sig.e50.at(-1))} / EMA200 ${fmt(sig.e200.at(-1))}`;

  // 마지막 상태를 사이드 신호로 표시
  setBadge(sig.lastState);

  // 이유(간단)
  const reasons = [];
  reasons.push(sig.e50.at(-1) > sig.e200.at(-1) ? "EMA50 > EMA200 (상승 우위)" : "EMA50 < EMA200 (하락 우위)");
  reasons.push((sig.e50.at(-1)-sig.e50.at(-6)) > 0 ? "EMA50 기울기 + (상승 모멘텀)" : "EMA50 기울기 - (하락 모멘텀)");
  if(sig.lastOB) reasons.push(`최근 OB: ${sig.lastOB.type==="bull" ? "매수" : "매도"} 구간 표시`);
  if(sig.lastFVG) reasons.push(`최근 FVG: ${sig.lastFVG.type==="bull" ? "Bullish" : "Bearish"} 구간 표시`);
  reasons.push(`차트 마커: LONG/SHORT 전환 시점 표시`);

  document.getElementById('signalSummary').textContent =
    sig.lastState==="LONG" ? "롱 우세" :
    sig.lastState==="SHORT" ? "숏 우세" :
    "관망";

  renderReasons(reasons);

  chart.timeScale().fitContent();
}

// 버튼들
document.getElementById('reload').addEventListener('click', ()=>load().catch(e=>{
  document.getElementById('signalSummary').textContent = "에러: " + e.message;
}));

document.getElementById('auto').addEventListener('click', (e)=>{
  const btn = e.currentTarget;
  const on = btn.dataset.on === "1";
  if(on){
    clearInterval(autoTimer);
    autoTimer = null;
    btn.dataset.on = "0";
    btn.textContent = "자동갱신 OFF";
  }else{
    // 1s는 너무 자주 호출하면 레이트리밋/렉 위험 -> 2초로 제한
    const tf = document.getElementById('tf').value;
    const ms = (tf==="1s") ? 2000 : 15000;
    autoTimer = setInterval(()=>load().catch(()=>{}), ms);
    btn.dataset.on = "1";
    btn.textContent = `자동갱신 ON (${Math.round(ms/1000)}초)`;
  }
});

// 초기 로드
load().catch(e=>{
  document.getElementById('signalSummary').textContent = "에러: " + e.message;
});

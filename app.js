// ---------- utils ----------
const fmt = (n) => (n==null?'-':Number(n).toLocaleString(undefined,{maximumFractionDigits:2}));

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

function swingHigh(candles, lookback=20){
  let m = -Infinity, idx=-1;
  for(let i=candles.length-lookback;i<candles.length;i++){
    if(i<0) continue;
    if(candles[i].high > m){ m=candles[i].high; idx=i; }
  }
  return {price:m, idx};
}
function swingLow(candles, lookback=20){
  let m = Infinity, idx=-1;
  for(let i=candles.length-lookback;i<candles.length;i++){
    if(i<0) continue;
    if(candles[i].low < m){ m=candles[i].low; idx=i; }
  }
  return {price:m, idx};
}

// FVG (간단)
function detectLastFVG(candles, scan=120){
  let last = null;
  const start = Math.max(2, candles.length - scan);
  for(let i=start;i<candles.length;i++){
    const a = candles[i-2], c = candles[i];
    if(a.high < c.low) last = {type:'bull', from:a.high, to:c.low, i};
    else if(a.low > c.high) last = {type:'bear', from:c.high, to:a.low, i};
  }
  return last;
}

// Fakeout/Trap (간단)
function detectFakeout(candles, lookback=25){
  const last = candles[candles.length-1];
  const prev = candles.slice(0, candles.length-1);
  const sh = swingHigh(prev, lookback);
  const sl = swingLow(prev, lookback);
  const upSweep = (last.high > sh.price) && (last.close < sh.price);
  const downSweep = (last.low < sl.price) && (last.close > sl.price);
  if(upSweep) return {type:'bear', level:sh.price};
  if(downSweep) return {type:'bull', level:sl.price};
  return null;
}

// Order Block (초기형)
function detectLastOB(candles, scan=180){
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

// ---------- signal engine ----------
function decideSignal(candles){
  const closes = candles.map(c=>c.close);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const lastClose = closes[closes.length-1];

  const trendUp = ema50.at(-1) > ema200.at(-1);
  const emaSlope = ema50.at(-1) - ema50.at(-6);
  const slopeUp = emaSlope > 0;

  const fvg = detectLastFVG(candles);
  const ob  = detectLastOB(candles);
  const fake = detectFakeout(candles);

  const reasons = [];
  let scoreLong = 0, scoreShort = 0;

  if(trendUp){ scoreLong += 2; reasons.push("EMA50 > EMA200 (상승 우위)"); }
  else { scoreShort += 2; reasons.push("EMA50 < EMA200 (하락 우위)"); }

  if(slopeUp){ scoreLong += 1; reasons.push("EMA50 기울기 + (상승 모멘텀)"); }
  else { scoreShort += 1; reasons.push("EMA50 기울기 - (하락 모멘텀)"); }

  if(fake?.type==='bull'){ scoreLong += 2; reasons.push(`저점 스윕 후 되돌림(Fakeout) (기준 ${fmt(fake.level)})`); }
  if(fake?.type==='bear'){ scoreShort += 2; reasons.push(`고점 스윕 후 되돌림(Fakeout) (기준 ${fmt(fake.level)})`); }

  if(fvg){
    if(fvg.type==='bull' && inZone(lastClose, fvg)){ scoreLong += 2; reasons.push("Bullish FVG 구간 재진입"); }
    if(fvg.type==='bear' && inZone(lastClose, fvg)){ scoreShort += 2; reasons.push("Bearish FVG 구간 재진입"); }
  }

  if(ob){
    if(ob.type==='bull' && inZone(lastClose, ob)){ scoreLong += 2; reasons.push("매수 OB 구간 터치"); }
    if(ob.type==='bear' && inZone(lastClose, ob)){ scoreShort += 2; reasons.push("매도 OB 구간 터치"); }
  }

  const diff = scoreLong - scoreShort;
  let signal = "WAIT";
  if(diff >= 2) signal = "LONG";
  else if(diff <= -2) signal = "SHORT";

  return { signal, reasons, lastClose, ema50: ema50.at(-1), ema200: ema200.at(-1), zones: {fvg, ob, fake} };
}

// ---------- chart ----------
const chart = LightweightCharts.createChart(document.getElementById('chart'), {
  layout: { background: { color: '#101a2e' }, textColor: '#d7dbe7' },
  grid: { vertLines: { color: '#1e2a44' }, horzLines: { color: '#1e2a44' } },
  timeScale: { timeVisible: true, secondsVisible: false },
  rightPriceScale: { borderColor: '#223054' },
  crosshair: { mode: 1 }
});
const candleSeries = chart.addCandlestickSeries();
const ema50Series = chart.addLineSeries({ lineWidth: 2 });
const ema200Series = chart.addLineSeries({ lineWidth: 2 });

let autoTimer = null;

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
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
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

async function load(){
  const symbol = document.getElementById('symbol').value;
  const tf = document.getElementById('tf').value;
  const limit = Number(document.getElementById('limit').value);

  document.getElementById('signalSummary').textContent = "데이터 불러오는 중…";
  setBadge("WAIT");

  const candles = await fetchBinance(symbol, tf, limit);

  candleSeries.setData(candles);

  const closes = candles.map(c=>c.close);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);
  ema50Series.setData(toLineData(e50, candles));
  ema200Series.setData(toLineData(e200, candles));

  const out = decideSignal(candles);

  document.getElementById('lastPrice').textContent = fmt(out.lastClose);
  document.getElementById('trendText').textContent = `EMA50 ${fmt(out.ema50)} / EMA200 ${fmt(out.ema200)}`;

  setBadge(out.signal);
  document.getElementById('signalSummary').textContent =
    out.signal==="LONG" ? "롱 우세 조건이 더 많음" :
    out.signal==="SHORT" ? "숏 우세 조건이 더 많음" :
    "조건이 애매해서 관망";

  renderReasons(out.reasons);
  chart.timeScale().fitContent();
}

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
    autoTimer = setInterval(()=>load().catch(()=>{}), 15000); // 15초마다 갱신
    btn.dataset.on = "1";
    btn.textContent = "자동갱신 ON (15초)";
  }
});

load().catch(e=>{
  document.getElementById('signalSummary').textContent = "에러: " + e.message;
});

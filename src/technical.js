// 주가 흐름(기술적 분석): 일별 시세 → 과열·침체 지표, 이동평균, 그래프 데이터
// 외부 호출 없이 계산만 해요. 지표 구성은 인베스팅닷컴 기술적 분석 화면을 참고했고,
// "매수·매도" 대신 "과열·침체 / 상승·하락 신호"로 보여줘요 (투자 권유가 아닌 정보 제공).
// rows: [{ date, open, high, low, close, volume, change }] 날짜 오름차순 (price.js getPriceHistory)

const DAILY_LIMIT = 0.3; // 하루 가격제한폭 ±30%: 이보다 큰 변화는 액면분할·병합 등
const CHART_DAYS = 250;   // 그래프는 최근 1년
const MIN_DAYS = 60;

const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const last = arr => arr[arr.length - 1];

// 시세 정리: 거래정지일처럼 시가·고가·저가가 0이면 종가로 채우고,
// 액면분할 등으로 하루에 ±30%를 넘게 바뀐 날은 그 이전 가격을 같은 기준으로 맞춤
export function prepareRows(raw) {
  const rows = raw.filter(r => r.close > 0).map(r => {
    const open = r.open > 0 ? r.open : r.close;
    return { date: r.date, open, close: r.close, volume: r.volume ?? 0,
             high: Math.max(r.high > 0 ? r.high : r.close, open, r.close),
             low: Math.min(r.low > 0 ? r.low : r.close, open, r.close), change: r.change };
  });
  let adjusted = false;
  for (let i = rows.length - 1; i > 0; i--) {
    const jump = rows[i].close / rows[i - 1].close - 1;
    if (Math.abs(jump) <= DAILY_LIMIT) continue;
    // 그날 실제 등락률(거래소 기준가 대비)로 이전 가격을 맞춤. 등락률이 없으면 그 이전 데이터는 버림
    const real = Number.isFinite(rows[i].change) && Math.abs(rows[i].change) <= DAILY_LIMIT * 100 ? rows[i].change / 100 : null;
    if (real == null) return { rows: rows.slice(i), adjusted: true };
    const f = rows[i].close / ((1 + real) * rows[i - 1].close);
    for (let j = 0; j < i; j++) {
      const r = rows[j];
      rows[j] = { ...r, open: r.open * f, high: r.high * f, low: r.low * f, close: r.close * f, volume: r.volume / f };
    }
    adjusted = true;
  }
  return { rows, adjusted };
}

// ---- 계산 도우미 (모두 입력과 같은 길이, 계산 전 구간은 null) ----
function sma(values, n) {
  const out = Array(values.length).fill(null);
  let sum = 0, count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) { sum = 0; count = 0; continue; }
    sum += v; count++;
    if (count > n) { sum -= values[i - n]; count = n; }
    if (count === n) out[i] = sum / n;
  }
  return out;
}
function ema(values, n) {
  const out = Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null, seed = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    if (prev == null) {
      seed.push(v);
      if (seed.length === n) prev = out[i] = seed.reduce((a, b) => a + b, 0) / n;
    } else prev = out[i] = v * k + prev * (1 - k);
  }
  return out;
}
// 와일더 평균 (RSI·ATR·ADX에서 쓰는 방식)
function wilder(values, n) {
  const out = Array(values.length).fill(null);
  let prev = null, seed = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    if (prev == null) {
      seed.push(v);
      if (seed.length === n) prev = out[i] = seed.reduce((a, b) => a + b, 0) / n;
    } else prev = out[i] = (prev * (n - 1) + v) / n;
  }
  return out;
}
const windowOf = (arr, i, n) => (i + 1 >= n ? arr.slice(i + 1 - n, i + 1) : null);

// ---- 지표 ----
function rsiSeries(close, n = 14) {
  const gain = close.map((c, i) => (i ? Math.max(c - close[i - 1], 0) : null));
  const loss = close.map((c, i) => (i ? Math.max(close[i - 1] - c, 0) : null));
  const g = wilder(gain, n), l = wilder(loss, n);
  return g.map((v, i) => (v == null ? null : l[i] === 0 ? 100 : 100 - 100 / (1 + v / l[i])));
}
function stochK(close, high, low, n) {
  return close.map((c, i) => {
    const h = windowOf(high, i, n), lo = windowOf(low, i, n);
    if (!h) return null;
    const hh = Math.max(...h), ll = Math.min(...lo);
    return hh === ll ? 50 : ((c - ll) / (hh - ll)) * 100;
  });
}
function trueRange(high, low, close) {
  return high.map((h, i) => (i ? Math.max(h - low[i], Math.abs(h - close[i - 1]), Math.abs(low[i] - close[i - 1])) : h - low[i]));
}

function compute(rows) {
  const close = rows.map(r => r.close), high = rows.map(r => r.high), low = rows.map(r => r.low);
  const c = last(close);
  const tr = trueRange(high, low, close);

  const rsi = rsiSeries(close, 14);
  const stoch = sma(stochK(close, high, low, 9), 6);
  const stochRsi = rsi.map((v, i) => {
    const w = windowOf(rsi, i, 14);
    if (!w || w.includes(null)) return null;
    const hi = Math.max(...w), lo = Math.min(...w);
    return hi === lo ? 50 : ((v - lo) / (hi - lo)) * 100;
  });

  const ema26 = ema(close, 26);
  const macd = ema(close, 12).map((v, i) => (v == null || ema26[i] == null ? null : v - ema26[i]));
  const macdSignal = ema(macd, 9);

  // ADX: 추세의 세기 (+DI·-DI로 방향)
  const plusDm = high.map((h, i) => { if (!i) return null; const up = h - high[i - 1], dn = low[i - 1] - low[i]; return up > dn && up > 0 ? up : 0; });
  const minusDm = high.map((h, i) => { if (!i) return null; const up = h - high[i - 1], dn = low[i - 1] - low[i]; return dn > up && dn > 0 ? dn : 0; });
  const trS = wilder(tr.map((v, i) => (i ? v : null)), 14);
  const pDi = wilder(plusDm, 14).map((v, i) => (v == null || !trS[i] ? null : (v / trS[i]) * 100));
  const mDi = wilder(minusDm, 14).map((v, i) => (v == null || !trS[i] ? null : (v / trS[i]) * 100));
  const adx = wilder(pDi.map((p, i) => (p == null ? null : p + mDi[i] === 0 ? 0 : (Math.abs(p - mDi[i]) / (p + mDi[i])) * 100)), 14);

  const hh14 = Math.max(...high.slice(-14)), ll14 = Math.min(...low.slice(-14));
  const williams = hh14 === ll14 ? -50 : ((hh14 - c) / (hh14 - ll14)) * -100;

  const tp = rows.map(r => (r.high + r.low + r.close) / 3);
  const tpSma = sma(tp, 14);
  const tpWin = tp.slice(-14);
  const meanDev = tpWin.reduce((a, v) => a + Math.abs(v - last(tpSma)), 0) / 14;
  const cci = meanDev === 0 ? 0 : (last(tp) - last(tpSma)) / (0.015 * meanDev);

  const atr = wilder(tr, 14);
  const atrPct = atr.map((v, i) => (v == null ? null : (v / close[i]) * 100));
  const recentAtr = atrPct.slice(-250).filter(v => v != null).sort((a, b) => a - b);
  const atrMedian = recentAtr[Math.floor(recentAtr.length / 2)];

  // 고점·저점 흐름: 최근 14일 동안 고점이 높아진 폭 − 저점이 낮아진 폭의 하루 평균
  let hlSum = 0;
  for (let i = rows.length - 14; i < rows.length; i++) {
    hlSum += Math.max(high[i] - high[i - 1], 0) - Math.max(low[i - 1] - low[i], 0);
  }
  const highsLows = hlSum / 14;

  // 얼티밋 오실레이터 (7·14·28일)
  const bp = close.map((v, i) => (i ? v - Math.min(low[i], close[i - 1]) : null));
  const uoAvg = n => bp.slice(-n).reduce((a, b) => a + b, 0) / tr.slice(-n).reduce((a, b) => a + b, 0);
  const uo = (100 * (4 * uoAvg(7) + 2 * uoAvg(14) + uoAvg(28))) / 7;

  const roc = (c / close[close.length - 13] - 1) * 100;
  const ema13 = last(ema(close, 13));
  const bullBear = (last(high) - ema13) + (last(low) - ema13);

  return { c, rsi: last(rsi), stoch: last(stoch), stochRsi: last(stochRsi), macd: last(macd), macdSignal: last(macdSignal),
           adx: last(adx), pDi: last(pDi), mDi: last(mDi), williams, cci, atr: last(atr), atrPct: last(atrPct), atrMedian,
           highsLows, uo, roc, bullBear };
}

// ---- 신호 판정 ----
// 과열·침체를 먼저 보고, 아니면 가운데 기준으로 상승·하락 (가운데 근처는 중립)
const band = (v, { hot, cold, up, down }) =>
  v == null ? null : v >= hot ? 'hot' : v <= cold ? 'cold' : v > up ? 'up' : v < down ? 'down' : 'neutral';
const sign = (v, eps = 0) => (v == null ? null : v > eps ? 'up' : v < -eps ? 'down' : 'neutral');

export const SIGNAL_LABEL = { hot: '과열', cold: '침체', up: '상승 신호', down: '하락 신호', neutral: '중립' };

// 지표 설명: short는 표에, about은 펼쳐 볼 때
function buildIndicators(x) {
  const tiny = x.c * 0.001; // 주가의 0.1%보다 작은 차이는 중립
  const atrLevel = x.atrPct == null || !x.atrMedian ? null
    : x.atrPct > x.atrMedian * 1.3 ? '변동성 큼' : x.atrPct < x.atrMedian * 0.7 ? '변동성 작음' : '변동성 보통';
  const adxSignal = x.adx == null ? null : x.adx < 25 ? 'neutral' : x.pDi > x.mDi ? 'up' : 'down';
  return [
    { key: 'rsi', name: 'RSI (14)', value: round(x.rsi), signal: band(x.rsi, { hot: 70, cold: 30, up: 55, down: 45 }),
      about: '최근 14일 동안 오른 힘과 내린 힘의 비율이에요. 70 이상이면 과열, 30 이하면 침체로 봐요.' },
    { key: 'stoch', name: 'STOCH (9, 6)', value: round(x.stoch), signal: band(x.stoch, { hot: 80, cold: 20, up: 55, down: 45 }),
      about: '최근 9일 최고가·최저가 사이에서 지금 주가가 어디쯤인지(6일 평균)예요. 80 이상이면 과열, 20 이하면 침체로 봐요.' },
    { key: 'stochRsi', name: 'STOCHRSI (14)', value: round(x.stochRsi), signal: band(x.stochRsi, { hot: 80, cold: 20, up: 55, down: 45 }),
      about: 'RSI가 최근 14일 범위에서 어디쯤인지예요. 아주 민감해서 자주 바뀌어요.' },
    { key: 'macd', name: 'MACD (12, 26)', value: round(x.macd), signal: x.macd == null || x.macdSignal == null ? null : sign(x.macd - x.macdSignal),
      about: '12일 평균과 26일 평균의 차이예요. 이 값이 9일 신호선보다 위면 상승 신호, 아래면 하락 신호로 봐요.' },
    { key: 'adx', name: 'ADX (14)', value: round(x.adx), signal: adxSignal,
      about: '추세가 얼마나 뚜렷한지예요. 25 이상이면 추세가 있다고 보고, 오르는 힘(+DI)과 내리는 힘(-DI) 중 큰 쪽으로 방향을 정해요. 25 미만은 중립이에요.' },
    { key: 'williams', name: 'Williams %R (14)', value: round(x.williams), signal: band(x.williams, { hot: -20, cold: -80, up: -45, down: -55 }),
      about: '최근 14일 최고가에서 지금 주가가 얼마나 떨어져 있는지예요. −20 이상이면 과열, −80 이하면 침체로 봐요.' },
    { key: 'cci', name: 'CCI (14)', value: round(x.cci), signal: band(x.cci, { hot: 100, cold: -100, up: 20, down: -20 }),
      about: '주가가 14일 평균에서 평소보다 얼마나 벗어났는지예요. +100 이상이면 과열, −100 이하면 침체로 봐요.' },
    { key: 'atr', name: 'ATR (14)', value: round(x.atr), signal: null, level: atrLevel,
      about: '하루에 주가가 평균 얼마나 움직이는지(원)예요. 방향은 알려주지 않고, 최근 1년 평소 수준과 비교해 변동성이 큰지 봐요.' },
    { key: 'highsLows', name: 'Highs/Lows (14)', value: round(x.highsLows), signal: sign(x.highsLows, tiny),
      about: '최근 14일 동안 고점이 높아진 폭에서 저점이 낮아진 폭을 뺀 하루 평균이에요. 양수면 고점이 올라가는 흐름이에요.' },
    { key: 'uo', name: 'Ultimate Oscillator', value: round(x.uo), signal: band(x.uo, { hot: 70, cold: 30, up: 55, down: 45 }),
      about: '7일·14일·28일의 사는 힘을 함께 본 값이에요. 70 이상이면 과열, 30 이하면 침체로 봐요.' },
    { key: 'roc', name: 'ROC (12)', value: round(x.roc), signal: sign(x.roc, 0.5),
      about: '12거래일 전보다 주가가 몇 % 변했는지예요.' },
    { key: 'bullBear', name: 'Bull/Bear Power (13)', value: round(x.bullBear), signal: sign(x.bullBear, tiny),
      about: '그날 고가·저가가 13일 지수평균보다 얼마나 위·아래에 있는지 더한 값이에요. 양수면 사는 힘이 강해요.' },
  ];
}

const MA_PERIODS = [5, 10, 20, 50, 100, 200];
function buildMovingAverages(close) {
  const c = last(close);
  const sig = ma => (ma == null ? null : c > ma ? 'up' : c < ma ? 'down' : 'neutral');
  return MA_PERIODS.map(n => {
    const s = last(sma(close, n)), e = last(ema(close, n));
    return { period: n, sma: round(s), smaSignal: sig(s), ema: round(e), emaSignal: sig(e) };
  });
}

// 주가 온도: 과열·침체를 보는 지표 6개를 0~100으로 맞춰 평균 (높을수록 과열)
function temperature(x) {
  const parts = [x.rsi, x.stoch, x.stochRsi, x.williams + 100, x.uo, Math.min(100, Math.max(0, 50 + x.cci / 4))]
    .filter(v => v != null && Number.isFinite(v));
  const score = parts.reduce((a, b) => a + b, 0) / parts.length;
  const level = score >= 70 ? 'hot' : score >= 60 ? 'warm' : score > 40 ? 'neutral' : score > 30 ? 'cool' : 'cold';
  return { score: Math.round(score), level, ...TEMPERATURE[level] };
}
const TEMPERATURE = {
  hot: { label: '과열', text: '최근 짧은 기간에 많이 올라 과열된 편이에요. 이런 때는 주가가 크게 흔들리기 쉬워요.' },
  warm: { label: '다소 과열', text: '최근 오르는 힘이 강한 편이에요.' },
  neutral: { label: '중립', text: '최근 오르는 힘과 내리는 힘이 비슷해요.' },
  cool: { label: '다소 침체', text: '최근 내리는 힘이 강한 편이에요.' },
  cold: { label: '침체', text: '최근 짧은 기간에 많이 떨어져 침체된 편이에요. 더 떨어질 수도, 다시 오를 수도 있어요.' },
};

// 주가 흐름: 이동평균 12개 + 추세 지표 5개의 상승·하락 신호 개수
const TREND_KEYS = ['macd', 'adx', 'highsLows', 'roc', 'bullBear'];
function trend(indicators, mas) {
  const signals = [...mas.flatMap(m => [m.smaSignal, m.emaSignal]), ...indicators.filter(i => TREND_KEYS.includes(i.key)).map(i => i.signal)]
    .filter(Boolean);
  const up = signals.filter(s => s === 'up').length, down = signals.filter(s => s === 'down').length;
  const share = up + down ? up / (up + down) : 0.5;
  const label = share >= 0.7 ? '상승 흐름' : share >= 0.55 ? '다소 상승 흐름' : share <= 0.3 ? '하락 흐름' : share <= 0.45 ? '다소 하락 흐름' : '뚜렷하지 않음';
  const text = share >= 0.55 ? '주가가 대부분의 평균선 위에 있고, 오르는 쪽 신호가 더 많아요.'
    : share <= 0.45 ? '주가가 대부분의 평균선 아래에 있고, 내리는 쪽 신호가 더 많아요.'
    : '오르는 쪽과 내리는 쪽 신호가 섞여 있어요.';
  return { label, text, up, down, neutral: signals.length - up - down };
}

export function analyzeTrend(rawRows) {
  const { rows, adjusted } = prepareRows(rawRows);
  if (rows.length < MIN_DAYS) {
    throw Object.assign(new Error('주가 데이터가 너무 적어서 계산할 수 없어요. (상장한 지 얼마 안 된 종목 등)'), { status: 422 });
  }
  const x = compute(rows);
  const indicators = buildIndicators(x);
  const movingAverages = buildMovingAverages(rows.map(r => r.close));
  const latest = last(rows);

  const close = rows.map(r => r.close);
  const ma20 = sma(close, 20), ma60 = sma(close, 60);
  const from = Math.max(0, rows.length - CHART_DAYS);
  const chart = rows.slice(from).map((r, i) => ({ d: r.date, c: round(r.close, 1), ma20: round(ma20[from + i], 1), ma60: round(ma60[from + i], 1) }));

  return {
    asOf: latest.date, close: latest.close, change: Number.isFinite(latest.change) ? latest.change : null,
    days: rows.length, adjusted,
    temperature: temperature(x), trend: trend(indicators, movingAverages),
    indicators, movingAverages, chart,
  };
}

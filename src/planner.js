// 투자 플래너: "얼마를 사라"가 아니라 "내가 짠 구성이 내 성향과 맞는지" 점검하는 계산 (외부 호출 없음)
// - 나누는 방식으로 비중 → 종목별 금액·주수 (하루 늦은 종가 기준)
// - 위험 점검: 종목끼리 같이 움직이는 정도까지 반영한 변동성, 나쁜 날 손실 금액, 원금 대비 최대 손실 ↔ 설문 손실 감내
// - 과거 시뮬레이션: 이 비중으로 1년·3년 전에 샀다면 (한 번에 / 매달 나눠), 국고채·균등 배분 비교
// 과거 결과는 미래를 보장하지 않고, 배당·수수료·세금은 들어 있지 않아요.
import { prepareRows } from './technical.js';

const PERIOD_DAYS = { '1y': 250, '3y': 730 }; // 3년치 시세가 휴장일 때문에 730거래일 안팎이라
const MAX_POINTS = 260; // 그래프 점 개수 (3년이면 3일에 한 점)

// 설문 q3(손실 감내) → 원금 대비 견딜 수 있는 손실 % (null이면 선을 긋지 않음)
export const LOSS_LIMIT = { none: 0, calm: 10, growth: 20, aggressive: null };

export const METHODS = {
  equal: '똑같이 나누기',
  fit: '적합도가 높은 종목에 더 많이',
  lowvol: '덜 흔들리는 종목에 더 많이',
  custom: '직접 비중 입력',
};

const sum = a => a.reduce((x, y) => x + y, 0);
const mean = a => sum(a) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(sum(a.map(v => (v - m) ** 2)) / (a.length - 1)); };
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

// 종목들이 모두 거래된 날짜만 맞춰서 종가 표 만들기 (액면분할 보정한 가격)
function align(stocks) {
  const maps = stocks.map(s => new Map(prepareRows(s.rows).rows.map(r => [r.date, r.close])));
  const dates = [...maps[0].keys()].filter(d => maps.every(m => m.has(d))).sort();
  return { dates, closes: maps.map(m => dates.map(d => m.get(d))) };
}
const dailyReturns = closes => closes.slice(1).map((c, i) => c / closes[i] - 1);

// 나누는 방식 → 비중 (합 1)
function weightsFor(method, stocks, custom) {
  let raw;
  if (method === 'fit') raw = stocks.map(s => Math.max(1, s.fit ?? 1));
  else if (method === 'lowvol') raw = stocks.map(s => (s.vol > 0 ? 1 / s.vol : 0));
  else if (method === 'custom') raw = stocks.map((s, i) => Math.max(0, Number(custom?.[i]) || 0));
  else raw = stocks.map(() => 1);
  const total = sum(raw);
  if (!(total > 0)) throw Object.assign(new Error('비중을 1% 이상 입력해주세요.'), { status: 400 });
  return raw.map(v => v / total);
}

// 과거 시뮬레이션: 비중 w로 시작일에 한 번에 사거나, 매달 첫 거래일에 나눠 사서 그대로 보유
function simulate(dates, closes, w, amount, buy, bond3y) {
  const n = dates.length;
  const firsts = buy === 'monthly' ? dates.map((d, i) => (i === 0 || d.slice(0, 6) !== dates[i - 1].slice(0, 6) ? i : -1)).filter(i => i >= 0) : [0];
  const per = amount / firsts.length;
  const units = w.map(() => 0);
  const bondDaily = bond3y != null ? (1 + bond3y / 100) ** (1 / 250) - 1 : null;
  let invested = 0, bond = 0, k = 0;
  const out = [];
  for (let t = 0; t < n; t++) {
    if (bondDaily != null) bond *= 1 + bondDaily;
    if (k < firsts.length && firsts[k] === t) {
      w.forEach((wi, i) => { units[i] += (per * wi) / closes[i][t]; });
      invested += per; bond += per; k++;
    }
    out.push({ t, value: sum(units.map((u, i) => u * closes[i][t])), invested, bond: bondDaily != null ? bond : null });
  }
  return { series: out, units };
}

// 원금 대비 가장 크게 잃었을 때, 회복까지, 손실 감내선 아래 일수
function lossStats(series, dates, limit) {
  let worst = { ratio: 0, t: null };
  for (const p of series) { const r = p.value / p.invested - 1; if (r < worst.ratio) worst = { ratio: r, t: p.t }; }
  let recovered = null;
  if (worst.t != null) {
    const back = series.find(p => p.t > worst.t && p.value >= p.invested);
    recovered = back ? back.t - worst.t : null;
  }
  const below = limit == null ? null : series.filter(p => p.value / p.invested - 1 < -limit / 100).length;
  // 고점 대비 최대 하락: 원금보다 위에 있어도 가장 높았던 때보다 얼마나 떨어졌는지 (매달 사면 넣은 돈 대비 비율로)
  let peak = 0, dd = { ratio: 0, t: null };
  for (const p of series) {
    const q = p.value / p.invested;
    peak = Math.max(peak, q);
    if (q / peak - 1 < dd.ratio) dd = { ratio: q / peak - 1, t: p.t };
  }
  return {
    peakDrawdownPct: round(dd.ratio * 100), peakDrawdownDate: dd.t == null ? null : dates[dd.t],
    worstPct: round(worst.ratio * 100), worstDate: worst.t == null ? null : dates[worst.t],
    recoveredDays: recovered, stillBelow: worst.t != null && recovered == null, daysBelowLimit: below,
  };
}

// stocks: [{ code, name, sector, fit, close, rows }], options: { amount, method, custom, period, buy, lossLimit, bond3y }
export function buildPlan(stocks, { amount, method, custom, period, buy, lossLimit, bond3y }) {
  const { dates: allDates, closes: allCloses } = align(stocks);
  if (allDates.length < 60) {
    throw Object.assign(new Error('고른 종목들이 함께 거래된 기간이 너무 짧아서 계산할 수 없어요. (상장한 지 얼마 안 된 종목 등)'), { status: 422 });
  }
  // 종목별 최근 1년 변동성 (덜 흔들리는 종목에 더 많이 나눌 때 사용)
  const recent = allCloses.map(c => dailyReturns(c.slice(-251)));
  stocks.forEach((s, i) => { s.vol = sd(recent[i]) * Math.sqrt(250) * 100; });
  const w = weightsFor(method, stocks, custom);

  // 1) 종목별 금액·주수 (가장 최근 종가)
  const items = stocks.map((s, i) => {
    const target = amount * w[i];
    const shares = Math.floor(target / s.close);
    return { code: s.code, name: s.name, sector: s.sector, fit: s.fit, weight: round(w[i] * 100, 1), target: Math.round(target),
             close: s.close, shares, cost: shares * s.close, vol: round(s.vol, 1) };
  });
  const spent = sum(items.map(i => i.cost));
  const realW = spent > 0 ? items.map(i => i.cost / spent) : w; // 실제로 살 수 있는 주수 기준 비중

  // 2) 구성 전체: 적합도(금액 가중), 업종 쏠림
  const fits = stocks.map(s => s.fit);
  const fit = fits.every(f => f != null) ? Math.round(sum(fits.map((f, i) => f * realW[i]))) : null;
  const bySector = {};
  items.forEach((it, i) => { const k = it.sector || '업종 정보 없음'; bySector[k] = (bySector[k] ?? 0) + realW[i]; });
  const sectors = Object.entries(bySector).map(([name, share]) => ({ name, pct: round(share * 100, 1) })).sort((a, b) => b.pct - a.pct);

  // 3) 위험 점검: 비중대로 묶은 하루 수익률 → 연 변동성, 나쁜 날(하위 2.5%) 손실 금액
  const port = dailyReturns(allCloses[0]).map((_, t) => sum(realW.map((wi, i) => wi * (allCloses[i][t + 1] / allCloses[i][t] - 1))));
  const last1y = port.slice(-250);
  const vol = sd(last1y) * Math.sqrt(250) * 100;
  const sorted = [...port.slice(-750)].sort((a, b) => a - b);
  const badDay = sorted[Math.floor(sorted.length * 0.025)];
  const base = spent > 0 ? spent : amount;
  const avgVol = sum(stocks.map((s, i) => s.vol * realW[i]));

  // 4) 과거 시뮬레이션 (고른 기간이 데이터보다 길면 가능한 만큼)
  const days = Math.min(PERIOD_DAYS[period] ?? 250, allDates.length);
  const from = allDates.length - days;
  const dates = allDates.slice(from);
  const closes = allCloses.map(c => c.slice(from));
  const main = simulate(dates, closes, realW, amount, buy, bond3y);
  const equal = simulate(dates, closes, realW.map(() => 1 / realW.length), amount, buy, null);
  const last = main.series[main.series.length - 1];
  const stats = lossStats(main.series, dates, lossLimit);
  const contributions = items.map((it, i) => ({
    name: it.name, pl: Math.round(main.units[i] * closes[i][closes[i].length - 1] - amount * realW[i]),
  })).sort((a, b) => b.pl - a.pl);
  const step = Math.max(1, Math.ceil(main.series.length / MAX_POINTS));
  const chart = main.series.filter((p, i) => i % step === 0 || i === main.series.length - 1).map(p => ({
    d: dates[p.t], v: Math.round(p.value), inv: Math.round(p.invested),
    eq: Math.round(equal.series[p.t].value), bond: p.bond == null ? null : Math.round(p.bond),
  }));

  return {
    amount, method, methodLabel: METHODS[method], period, buy,
    asOf: allDates[allDates.length - 1],
    items, spent, cash: amount - spent,
    portfolio: { fit, sectors, vol: round(vol, 1), avgVol: round(avgVol, 1), badDayPct: round(badDay * 100, 2), badDayWon: Math.round(badDay * base) },
    lossLimit,
    sim: {
      from: dates[0], to: dates[dates.length - 1], days: dates.length, shortened: days < (PERIOD_DAYS[period] ?? 250) - 20,
      returnPct: round((last.value / last.invested - 1) * 100, 1), value: Math.round(last.value), invested: Math.round(last.invested),
      equalReturnPct: round((equal.series[equal.series.length - 1].value / last.invested - 1) * 100, 1),
      bondReturnPct: last.bond == null ? null : round((last.bond / last.invested - 1) * 100, 1),
      ...stats, contributions, chart,
    },
  };
}

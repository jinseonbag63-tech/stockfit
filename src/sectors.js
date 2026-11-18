// 업종별 상태: 하루치 전체 종목 시세로 업종(KSIC 앞 2자리)·시장 전체 지수를 직접 계산해 DB(sector_daily)에 쌓고,
// 그 지수로 업종 온도(과열~침체)·흐름·등락과 순위(TOP 5)를 계산해요.
// 공식 코스피·업종 지수가 아니라, 상장사(코스피·코스닥)를 시가총액 가중으로 묶은 자체 계산이에요.
import { getDailyAll, getMarketCaps } from './price.js';
import { analyzeIndex } from './technical.js';
import { industryName } from './industry.js';
import { getByCode } from './corpCodes.js';

const TARGET_DAYS = 80;   // 60일 이동평균 + 여유
const SCAN_LIMIT = 200;   // 거꾸로 훑을 최대 달력 일수
const GAP_MS = 300;       // 공공데이터포털 호출 사이 간격
const MIN_STOCKS = 10;    // 순위에 넣는 최소 종목 수 (종목이 적으면 한 종목만 움직여도 1등이 돼서)
const MAX_CHANGE = 30;    // 하루 ±30%를 넘는 값은 오류로 보고 제외
const MIN_POINTS = 20;    // 이보다 짧으면 온도·흐름을 계산하지 않음
const TOP = 5;

let db;
const state = { running: false, done: 0, total: TARGET_DAYS, error: null, finishedAt: null };
let summary = null; // 계산해 둔 결과 (새 날짜가 들어오면 지움)

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

export function initSectors(database) { db = database; }
export const sectorStatus = () => ({ ...state });

// 종목코드 → 업종(KSIC 앞 2자리). 업종 비교 수집(peers.js)이 모아 둔 company_info 사용
async function sectorMap() {
  const rows = await db.all('SELECT stock_code, industry_code FROM company_info WHERE industry_code IS NOT NULL');
  return new Map(rows.map(r => [r.stock_code, String(r.industry_code).slice(0, 2)]));
}

// 하루치 시세 → 업종별·시장 전체 하루 등락 (전날 시가총액 가중 = 오늘 시가총액 ÷ (1 + 등락률))
function aggregate(items, sectorOf) {
  const g = new Map();
  const add = (key, it, r) => {
    const a = g.get(key) ?? { w: 0, wr: 0, up: 0, down: 0, n: 0, cap: 0 };
    const prev = it.cap / (1 + r);
    a.w += prev; a.wr += prev * r; a.up += r > 0; a.down += r < 0; a.n++; a.cap += it.cap;
    g.set(key, a);
  };
  for (const it of items) {
    if (Math.abs(it.change) > MAX_CHANGE) continue;
    const r = it.change / 100;
    add('ALL', it, r);
    const s = sectorOf.get(it.code);
    if (s) add(s, it, r);
  }
  return [...g].map(([sector, a]) => ({ sector, ret: a.w ? a.wr / a.w : 0, up: a.up, down: a.down, n: a.n, cap: a.cap }));
}

// 오늘부터 거꾸로 평일을 훑으며 없는 날만 받아 저장 (휴장일·아직 안 올라온 날은 빈 응답이라 건너뜀)
export async function syncSectors(key) {
  if (!key || !db || state.running) return;
  Object.assign(state, { running: true, error: null, done: 0 });
  try {
    const sectorOf = await sectorMap();
    if (!sectorOf.size) throw new Error('업종 정보가 아직 없어요. 업종 비교 데이터를 모은 뒤 다시 계산해요.');
    const have = new Set((await db.all("SELECT date FROM sector_daily WHERE sector = 'ALL'")).map(r => r.date));
    const d = new Date();
    let added = 0;
    for (let i = 0; i < SCAN_LIMIT && state.done < TARGET_DAYS; i++, d.setDate(d.getDate() - 1)) {
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      const day = ymd(d);
      if (have.has(day)) { state.done++; continue; }
      const items = await getDailyAll(key, day);
      await sleep(GAP_MS);
      if (!items.length) continue;
      const rows = aggregate(items, sectorOf);
      await db.tx(async t => {
        for (const r of rows) {
          await t.run(`INSERT INTO sector_daily (sector, date, ret, up, down, n, cap) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(sector, date) DO UPDATE SET ret = excluded.ret, up = excluded.up, down = excluded.down, n = excluded.n, cap = excluded.cap`,
          [r.sector, day, r.ret, r.up, r.down, r.n, r.cap]);
        }
      });
      state.done++; added++;
    }
    if (added) summary = null;
    state.finishedAt = Date.now();
    console.log(`[업종별 상태] ${state.done}거래일 준비 (새로 ${added}일)`);
  } catch (err) {
    state.error = err.message;
    console.error('[업종별 상태]', err.message);
  } finally {
    state.running = false;
  }
}

// 한 종목의 업종 코드와, 그 업종·시장 전체의 날짜별 하루 등락 (상승·하락 단서에서 비교용)
export async function sectorSeriesFor(stockCode) {
  if (!db) return null;
  const row = await db.get('SELECT industry_code FROM company_info WHERE stock_code = ?', [stockCode]);
  const sector = row?.industry_code ? String(row.industry_code).slice(0, 2) : null;
  const read = async key => (await db.all('SELECT date, ret FROM sector_daily WHERE sector = ? ORDER BY date', [key]))
    .map(r => ({ date: r.date, ret: Number(r.ret) }));
  return { sector, sectorName: sector ? industryName(sector) : null, sectorDays: sector ? await read(sector) : [], marketDays: await read('ALL') };
}

// 업종별 온도·흐름·등락, 순위 TOP 5, 시장 전체. 대표 종목은 최근 시가총액 순 3개
export async function getSectors(key) {
  if (summary && Date.now() - summary.at < 60 * 60 * 1000) return summary.data;
  const rows = await db.all('SELECT sector, date, ret, up, down, n, cap FROM sector_daily ORDER BY date');
  if (!rows.length) return { asOf: null, days: 0, market: null, sectors: [], rankings: null };
  const dates = [...new Set(rows.map(r => r.date))];
  const asOf = dates[dates.length - 1];
  const bySector = new Map();
  for (const r of rows) (bySector.get(r.sector) ?? bySector.set(r.sector, []).get(r.sector)).push(r);

  // 대표 종목: 최근 시가총액 상위 3개 (시가총액은 price.js가 12시간 저장)
  const caps = await getMarketCaps(key).catch(() => null);
  const sectorOf = await sectorMap();
  const leaders = new Map();
  for (const [code, cap] of caps ?? []) {
    const s = sectorOf.get(code), stock = s && getByCode(code);
    if (!stock || !(cap > 0)) continue;
    (leaders.get(s) ?? leaders.set(s, []).get(s)).push({ code, name: stock.name, cap });
  }

  const build = (sector, list) => {
    const lastRow = list[list.length - 1];
    if (lastRow.date !== asOf) return null; // 최근 날짜에 없는 업종(상장 종목이 사라진 경우 등)
    let v = 100;
    const points = list.map(r => ({ d: r.date, v: (v *= 1 + Number(r.ret)) }));
    const a = points.length >= MIN_POINTS ? analyzeIndex(points) : null;
    return {
      code: sector, name: sector === 'ALL' ? '시장 전체' : industryName(sector),
      n: Number(lastRow.n), cap: Number(lastRow.cap), upRatio: round(Number(lastRow.up) / Math.max(1, Number(lastRow.up) + Number(lastRow.down)) * 100, 0),
      today: round(Number(lastRow.ret) * 100), days: points.length,
      temperature: a?.temperature ?? null, trend: a?.trend ?? null, week: a?.week ?? null, month: a?.month ?? null, rsi: a?.rsi ?? null,
      spark: points.slice(-60).map(p => round(p.v, 2)),
      leaders: (leaders.get(sector) ?? []).sort((x, y) => y.cap - x.cap).slice(0, 3).map(({ code, name }) => ({ code, name })),
    };
  };
  const market = build('ALL', bySector.get('ALL') ?? []);
  const sectors = [...bySector].filter(([s]) => s !== 'ALL').map(([s, list]) => build(s, list)).filter(Boolean)
    .sort((a, b) => (b.month ?? -999) - (a.month ?? -999));
  const ranked = sectors.filter(s => s.n >= MIN_STOCKS && s.temperature);
  const data = {
    asOf, days: dates.length, minStocks: MIN_STOCKS, market, sectors,
    rankings: {
      strong: [...ranked].sort((a, b) => b.month - a.month).slice(0, TOP).map(s => s.code),
      hot: [...ranked].sort((a, b) => b.temperature.score - a.temperature.score).slice(0, TOP).map(s => s.code),
      cold: [...ranked].sort((a, b) => a.temperature.score - b.temperature.score).slice(0, TOP).map(s => s.code),
    },
  };
  summary = { at: Date.now(), data };
  return data;
}

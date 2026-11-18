// 상승·하락 단서: 주가가 왜 움직였는지 "원인을 단정하지 않고" 확인할 수 있는 단서만 모아요 (외부 호출 없음)
// 1) 시장 전체·같은 업종과 비교 (어디서 온 움직임인지)  2) 크게 움직인 날과 그날 앞뒤의 공시·뉴스
// 3) 같은 시기 공시  4) 최근 뉴스  5) 증권가 시각 (증권사 의견 기사의 제목·링크와 상향·하향 기사 수)
import { prepareRows } from './technical.js';

const WINDOWS = [{ key: 'week', label: '1주', days: 5 }, { key: 'month', label: '1개월', days: 20 }];
const QUIET = 3;        // 등락이 ±3% 안이면 "큰 움직임 없음"
const SHARE = 0.6;      // 시장·업종이 같은 방향으로 종목 움직임의 60% 이상 움직였으면 그쪽 영향이 크다고 봄
const SIMILAR = 3;      // 시장·업종과 차이가 3%p 안이면 "비슷하게 움직였어요"
const BIG_DAYS = 3;     // 크게 움직인 날 최대 개수
const BIG_MIN = 3;      // 하루 ±3% 이상
const ANALYST_DAYS = 30;
const UP_WORDS = /상향|올려|높여|↑/;
const DOWN_WORDS = /하향|내려|낮춰|↓/;

const round = (v, d = 1) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const sd = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const dash = d => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;           // YYYYMMDD → YYYY-MM-DD
const kstDay = iso => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10); // 뉴스 시각 → 한국 날짜
const shift = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// 업종·시장의 하루 등락 목록에서 endDate까지 마지막 n거래일 누적 등락(%)
function seriesReturn(days, endDate, n) {
  const upto = days.filter(r => r.date <= endDate);
  if (upto.length < n) return null;
  return (upto.slice(-n).reduce((v, r) => v * (1 + r.ret), 1) - 1) * 100;
}

// 어디서 온 움직임인지: 시장 → 업종 → 이 종목만 순서로
function attribute(s, k, m) {
  if (s == null) return null;
  if (Math.abs(s) < QUIET) return { kind: 'quiet', text: '큰 움직임은 없었어요.' };
  if (k == null && m == null) return { kind: 'nodata', text: '시장·업종 데이터가 아직 없어서 어디서 온 움직임인지는 비교하지 못했어요.' };
  const went = s > 0 ? '오른' : '내린';
  const same = v => v != null && Math.sign(v) === Math.sign(s) && Math.abs(v) >= Math.abs(s) * SHARE;
  if (same(m)) return { kind: 'market', text: `시장 전체가 함께 ${went} 영향이 커 보여요.` };
  if (same(k)) return { kind: 'sector', text: `같은 업종이 함께 ${went} 영향이 커 보여요.` };
  if ([k, m].some(v => v != null && Math.abs(s - v) < SIMILAR)) return { kind: 'quiet', text: '시장·업종과 크게 다르지 않게 움직였어요.' };
  return { kind: 'own', text: `시장·업종보다 이 종목이 훨씬 크게 ${s > 0 ? '올랐어요' : '내렸어요'}. 이 종목만의 이유가 있었는지 아래 공시·뉴스를 확인해 보세요.` };
}

// rawRows: price.js 일별 시세, series: sectors.js sectorSeriesFor, disclosures/news/analyst: feed.js 결과
// stockName: 기사 제목에 종목 이름이 들어간 것만 고를 때 사용 (본문에만 잠깐 나온 기사를 거름)
export function buildClues(rawRows, series, { disclosures = [], news = [], analyst = [] }, stockName = '') {
  const named = it => !stockName || it.title.includes(stockName);
  const { rows } = prepareRows(rawRows);
  const asOf = rows[rows.length - 1].date;
  const close = rows.map(r => r.close);
  const hasSector = series?.sectorDays?.length > 0;
  const hasMarket = series?.marketDays?.length > 0;

  // 1) 시장·업종과 비교
  const compare = WINDOWS.map(w => {
    const s = close.length > w.days ? (close[close.length - 1] / close[close.length - 1 - w.days] - 1) * 100 : null;
    const k = hasSector ? seriesReturn(series.sectorDays, asOf, w.days) : null;
    const m = hasMarket ? seriesReturn(series.marketDays, asOf, w.days) : null;
    return { key: w.key, label: w.label, stock: round(s), sector: round(k), market: round(m), verdict: attribute(s, k, m) };
  });

  // 2) 크게 움직인 날: 최근 20거래일 중 하루 등락이 ±3%와 평소 변동의 2배를 모두 넘는 날, 큰 순서로 최대 3일
  const daily = rows.map((r, i) => (i ? (r.close / rows[i - 1].close - 1) * 100 : null));
  const usual = sd(daily.slice(-120).filter(v => v != null));
  const limit = Math.max(BIG_MIN, usual * 2);
  const from = Math.max(1, rows.length - 20);
  const dayRet = (days, d) => { const r = days?.find(x => x.date === d); return r ? round(r.ret * 100) : null; };
  const near = (date, items, before, after) => items.filter(it => { const d = it.type === 'news' ? kstDay(it.date) : it.date; return d >= shift(date, -before) && d <= shift(date, after); });
  const bigDays = rows.slice(from).map((r, i) => ({ date: r.date, change: daily[from + i] }))
    .filter(x => Math.abs(x.change) >= limit)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, BIG_DAYS)
    .map(x => ({
      date: x.date, change: round(x.change), sector: hasSector ? dayRet(series.sectorDays, x.date) : null, market: hasMarket ? dayRet(series.marketDays, x.date) : null,
      disclosures: near(dash(x.date), disclosures, 2, 0).slice(0, 3),
      news: near(dash(x.date), news, 1, 1).sort((a, b) => named(b) - named(a)).slice(0, 3),
    }));

  // 3) 같은 시기(최근 1개월) 공시, 4) 최근 뉴스 (네이버는 날짜를 정해 검색할 수 없어 최신 기사만)
  const monthStart = dash(rows[Math.max(0, rows.length - 21)].date);
  const recentDisc = disclosures.filter(d => d.date >= monthStart).slice(0, 8);
  // 제목에 종목 이름이 있는 기사를 쓰고, 3개보다 적으면 나머지 기사로 채움
  const byDate = (a, b) => b.date.localeCompare(a.date);
  const titled = news.filter(named).sort(byDate);
  const newsSorted = titled.length >= 3 ? titled : [...titled, ...news.filter(n => !named(n)).sort(byDate)];

  // 5) 증권가 시각: 최근 30일 증권사 의견 기사, 제목의 단어로 상향·하향을 나눔 (정확하지 않을 수 있음)
  const since = shift(dash(asOf), -ANALYST_DAYS);
  const opinions = analyst.filter(a => kstDay(a.date) >= since && named(a) && /목표|투자의견|증권|리포트/.test(a.title))
    .map(a => ({ ...a, tone: UP_WORDS.test(a.title) ? 'up' : DOWN_WORDS.test(a.title) ? 'down' : 'other' }));

  return {
    asOf, sector: series?.sector ? { code: series.sector, name: series.sectorName } : null,
    hasSector, hasMarket, compare, bigLimit: round(limit), usualMove: round(usual, 2), bigDays,
    disclosures: recentDisc,
    news: { items: newsSorted.slice(0, 8), oldest: newsSorted.length ? newsSorted[newsSorted.length - 1].date : null },
    analyst: {
      up: opinions.filter(o => o.tone === 'up').length, down: opinions.filter(o => o.tone === 'down').length,
      other: opinions.filter(o => o.tone === 'other').length, items: opinions.slice(0, 6),
    },
  };
}

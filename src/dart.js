// DART 오픈API에서 재무·배당 데이터를 가져와 지표를 계산하는 모듈
// - 주요계정(3년치): 부채·자본·매출·이익 등 → 안정성·수익성·성장성 지표
// - 전체 재무제표: 매출총이익, 영업현금흐름, 이자 지급액 → 이익의 질·이자보상배율·재무 체크리스트
// - 배당(3년치): 배당수익률, 배당성향, 연속 배당
const BASE = 'https://opendart.fss.or.kr/api';
const ANNUAL_REPORT = '11011'; // 사업보고서(연간)

export async function callDart(endpoint, params) {
  const url = new URL(`${BASE}/${endpoint}.json`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DART 서버 응답 오류 (HTTP ${res.status})`);
  return res.json();
}

// "1,234,567", "-1,234", "(1,234)" 같은 문자열을 숫자로 변환
export function toNum(s) {
  if (s == null) return null;
  let t = String(s).replace(/,/g, '').trim();
  if (t === '' || t === '-') return null;
  const paren = t.match(/^\((.*)\)$/);
  if (paren) t = `-${paren[1]}`;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// 계정명이 회사마다 조금씩 달라서 여러 이름을 순서대로 찾아요
export function pickAccount(rows, names) {
  for (const name of names) {
    const row = rows.find(r => r.account_nm.replace(/\s/g, '').startsWith(name));
    if (row) return { cur: toNum(row.thstrm_amount), prev: toNum(row.frmtrm_amount), prev2: toNum(row.bfefrmtrm_amount) };
  }
  return { cur: null, prev: null, prev2: null };
}

// 주요계정 이름 (단일회사·다중회사 주요계정 API 공통)
const MAIN_ACCOUNTS = {
  currentAssets: ['유동자산'],
  totalAssets: ['자산총계'],
  currentLiabilities: ['유동부채'],
  nonCurrentLiabilities: ['비유동부채'],
  liabilities: ['부채총계'],
  capital: ['자본금'],
  retainedEarnings: ['이익잉여금'],
  equity: ['자본총계'],
  revenue: ['매출액', '수익(매출액)', '영업수익'],
  operatingIncome: ['영업이익'],
  netIncome: ['당기순이익'],
};

// 연결재무제표(CFS) 우선, 없으면 별도(OFS)
export function chooseStatement(rows) {
  const cfs = rows.filter(r => r.fs_div === 'CFS');
  return cfs.length ? { rows: cfs, fsDiv: 'CFS', fsType: '연결' } : { rows: rows.filter(r => r.fs_div === 'OFS'), fsDiv: 'OFS', fsType: '별도' };
}

export function mainAccounts(rows) {
  return Object.fromEntries(Object.entries(MAIN_ACCOUNTS).map(([k, names]) => [k, pickAccount(rows, names)]));
}

const pct = (a, b) => (a == null || b == null || b === 0 ? null : (a / b) * 100);
const ratio = (a, b) => (a == null || b == null || b === 0 ? null : a / b);
const growth = (cur, prev) => (cur == null || prev == null || prev === 0 ? null : ((cur - prev) / Math.abs(prev)) * 100);

// 주요계정만으로 계산하는 지표 (업종 비교에도 같은 계산을 써요)
export function coreMetrics(a) {
  const rev = a.revenue, oi = a.operatingIncome;
  // 3년 평균 매출 성장률: 2년 전 → 올해, 두 해 모두 매출이 플러스일 때만
  const cagr = rev.cur > 0 && rev.prev2 > 0 ? (Math.sqrt(rev.cur / rev.prev2) - 1) * 100 : null;
  // 최근 2년 동안 매출·영업이익이 전년보다 늘어난 횟수 (최대 4번)
  const steps = [[rev.prev2, rev.prev], [rev.prev, rev.cur], [oi.prev2, oi.prev], [oi.prev, oi.cur]]
    .filter(([x, y]) => x != null && y != null);
  const consistency = steps.length >= 2 ? (steps.filter(([x, y]) => y > x).length / steps.length) * 100 : null;
  // 알트만 Z''(비제조업·신흥시장용, 주가 없이 장부가로 계산): 6.56·X1 + 3.26·X2 + 6.72·X3 + 1.05·X4
  const ta = a.totalAssets.cur;
  const x = [
    ratio(a.currentAssets.cur != null && a.currentLiabilities.cur != null ? a.currentAssets.cur - a.currentLiabilities.cur : null, ta),
    ratio(a.retainedEarnings.cur, ta),
    ratio(oi.cur, ta),
    ratio(a.equity.cur, a.liabilities.cur),
  ];
  const altmanZ = x.every(v => v != null) ? 6.56 * x[0] + 3.26 * x[1] + 6.72 * x[2] + 1.05 * x[3] : null;
  return {
    debtRatio: pct(a.liabilities.cur, a.equity.cur),
    currentRatio: pct(a.currentAssets.cur, a.currentLiabilities.cur),
    operatingMargin: pct(oi.cur, rev.cur),
    roe: pct(a.netIncome.cur, a.equity.cur),
    revenueGrowth: growth(rev.cur, rev.prev),
    revenueCagr3y: cagr,
    growthConsistency: consistency,
    altmanZ,
    netIncome: a.netIncome.cur, // PER 계산용 (원)
    equity: a.equity.cur,       // PBR 계산용 (원)
  };
}

// 전체 재무제표에서 계정 찾기: 표준 계정 ID → 계정명 순서로
function findFull(rows, { sj, ids = [], names = [] }) {
  const inSj = rows.filter(r => sj.includes(r.sj_div)).sort((a, b) => Number(a.ord) - Number(b.ord));
  const row = inSj.find(r => ids.includes(r.account_id))
    ?? inSj.find(r => names.some(re => re.test(r.account_nm.replace(/\s/g, ''))));
  return row ? { cur: toNum(row.thstrm_amount), prev: toNum(row.frmtrm_amount) } : { cur: null, prev: null };
}

async function fetchFullStatements(key, corpCode, year, fsDiv) {
  const data = await callDart('fnlttSinglAcntAll', {
    crtfc_key: key, corp_code: corpCode, bsns_year: String(year), reprt_code: ANNUAL_REPORT, fs_div: fsDiv,
  });
  if (data.status !== '000') return null;
  const rows = data.list;
  const grossProfit = findFull(rows, { sj: ['IS', 'CIS'], ids: ['ifrs-full_GrossProfit'], names: [/^매출총이익/] });
  const cfo = findFull(rows, { sj: ['CF'], ids: ['ifrs-full_CashFlowsFromUsedInOperatingActivities'], names: [/^영업활동.*현금흐름/] });
  // 이자: 현금흐름표의 "이자의 지급"이 가장 정확하고, 없으면 이자비용, 그것도 없으면 금융비용(외환손실 등이 섞여 과대)
  let interest = findFull(rows, { sj: ['CF'], ids: ['ifrs-full_InterestPaidClassifiedAsOperatingActivities', 'ifrs-full_InterestPaidClassifiedAsFinancingActivities'], names: [/^이자의?지급/, /^이자지급/] });
  let interestSource = '이자 지급액';
  if (interest.cur == null) { interest = findFull(rows, { sj: ['IS', 'CIS'], ids: ['ifrs-full_InterestExpense'], names: [/^이자비용/] }); interestSource = '이자비용'; }
  if (interest.cur == null) { interest = findFull(rows, { sj: ['IS', 'CIS'], ids: ['ifrs-full_FinanceCosts'], names: [/^금융(비용|원가)/] }); interestSource = '금융비용(이자 외 항목 포함)'; }
  return { grossProfit, cfo: cfo.cur, interest: interest.cur == null ? null : Math.abs(interest.cur), interestSource };
}

async function fetchFinancials(key, corpCode, year) {
  const data = await callDart('fnlttSinglAcnt', {
    crtfc_key: key, corp_code: corpCode, bsns_year: String(year), reprt_code: ANNUAL_REPORT,
  });
  if (data.status === '013') return null; // 해당 연도 데이터 없음
  if (data.status !== '000') throw new Error(`DART 오류 ${data.status}: ${data.message}`);
  const st = chooseStatement(data.list);
  return { year, fsDiv: st.fsDiv, fsType: st.fsType, accounts: mainAccounts(st.rows) };
}

async function fetchDividend(key, corpCode, year) {
  const data = await callDart('alotMatter', {
    crtfc_key: key, corp_code: corpCode, bsns_year: String(year), reprt_code: ANNUAL_REPORT,
  });
  const empty = { dividendYield: null, payoutRatio: null, dps: [] };
  if (data.status !== '000') return empty;
  const find = (label, common) => data.list.find(r =>
    r.se.replace(/\s/g, '').includes(label) && (!common || r.stock_knd === '보통주'));
  const dpsRow = find('주당현금배당금', true);
  return {
    dividendYield: toNum(find('현금배당수익률', true)?.thstrm),
    payoutRatio: toNum(find('현금배당성향', false)?.thstrm),
    dps: dpsRow ? [toNum(dpsRow.thstrm), toNum(dpsRow.frmtrm), toNum(dpsRow.lwfr)] : [], // 올해, 1년 전, 2년 전
  };
}

// 피오트로스키 F-score 9개 항목 → 초보자용 체크리스트
function financialChecklist(a, full) {
  const ta = a.totalAssets, ni = a.netIncome, rev = a.revenue;
  const roa = (n, t) => ratio(n, t);
  const cmp = (x, y) => (x == null || y == null ? null : x > y);
  const gm = (gp, r) => ratio(gp, r);
  const items = [
    ['이익을 냈어요', '손실을 냈어요', ni.cur == null ? null : ni.cur > 0],
    ['본업으로 현금이 들어왔어요', '본업에서 현금이 빠져나갔어요', full?.cfo == null ? null : full.cfo > 0],
    ['자산 대비 이익률이 좋아졌어요', '자산 대비 이익률이 나빠졌어요', cmp(roa(ni.cur, ta.cur), roa(ni.prev, ta.prev))],
    ['이익보다 실제 들어온 현금이 많아요', '이익에 비해 실제 들어온 현금이 적어요', full?.cfo == null || ni.cur == null ? null : full.cfo > ni.cur],
    ['장기 빚 비중이 줄었어요', '장기 빚 비중이 늘었어요', cmp(ratio(a.nonCurrentLiabilities.prev, ta.prev), ratio(a.nonCurrentLiabilities.cur, ta.cur))],
    ['단기 지급 능력이 좋아졌어요', '단기 지급 능력이 나빠졌어요', cmp(ratio(a.currentAssets.cur, a.currentLiabilities.cur), ratio(a.currentAssets.prev, a.currentLiabilities.prev))],
    ['새 주식을 발행하지 않았어요', '새 주식을 발행했어요 (자본금 증가)', a.capital.cur == null || a.capital.prev == null ? null : a.capital.cur <= a.capital.prev],
    ['매출총이익률이 좋아졌어요', '매출총이익률이 나빠졌어요', cmp(gm(full?.grossProfit.cur, rev.cur), gm(full?.grossProfit.prev, rev.prev))],
    ['자산을 더 효율적으로 써서 매출을 냈어요', '자산 대비 매출이 줄었어요', cmp(ratio(rev.cur, ta.cur), ratio(rev.prev, ta.prev))],
  ].map(([good, bad, pass]) => ({ label: pass === false ? bad : good, pass }));
  const known = items.filter(i => i.pass != null);
  return { items, passed: known.filter(i => i.pass).length, total: known.length };
}

// 최근 사업보고서 기준으로 지표 계산 (작년 보고서가 아직 없으면 한 해 전으로)
export async function getMetricsFromDart(key, stock) {
  const thisYear = new Date().getFullYear();
  let fin = null;
  for (const y of [thisYear - 1, thisYear - 2]) {
    fin = await fetchFinancials(key, stock.corpCode, y);
    if (fin) break;
  }
  if (!fin) throw new Error('최근 2년 사업보고서 데이터를 찾지 못했어요.');
  const [div, full] = await Promise.all([
    fetchDividend(key, stock.corpCode, fin.year),
    fetchFullStatements(key, stock.corpCode, fin.year, fin.fsDiv).catch(() => null),
  ]);

  const a = fin.accounts;
  const core = coreMetrics(a);
  const ta = a.totalAssets.cur;
  const paidYears = div.dps.filter(v => v > 0).length;
  return {
    year: fin.year,
    source: `DART ${fin.year}년 사업보고서 (${fin.fsType})`,
    sample: false,
    metrics: {
      ...core,
      // 이자 지급액이 0이면 갚을 이자가 없는 것 → 아주 여유 있음(99배로 표시)
      interestCoverage: full?.interest == null || a.operatingIncome.cur == null ? null
        : full.interest === 0 ? 99 : a.operatingIncome.cur / full.interest,
      grossProfitability: pct(full?.grossProfit.cur, ta),
      accruals: full?.cfo == null || a.netIncome.cur == null ? null : pct(a.netIncome.cur - full.cfo, ta),
      dividendYield: div.dividendYield,
      payoutRatio: div.payoutRatio,
      dividendStreak: div.dps.length ? paidYears : null,
      dividendCut: div.dps.length >= 2 && div.dps[1] > 0 && (div.dps[0] ?? 0) < div.dps[1],
    },
    interestSource: full?.interestSource ?? null,
    checklist: financialChecklist(a, full),
  };
}

// 기업개황: 시장 구분(코스피/코스닥)과 업종 코드
export async function getCompanyInfo(key, corpCode) {
  const data = await callDart('company', { crtfc_key: key, corp_code: corpCode });
  if (data.status !== '000') return { market: null, industryCode: null };
  return { market: data.corp_cls, industryCode: data.induty_code };
}

// DART 오픈API에서 재무·배당 데이터를 가져와 지표를 계산하는 모듈
const BASE = 'https://opendart.fss.or.kr/api';
const ANNUAL_REPORT = '11011'; // 사업보고서(연간)

async function callDart(endpoint, params) {
  const url = new URL(`${BASE}/${endpoint}.json`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DART 서버 응답 오류 (HTTP ${res.status})`);
  return res.json();
}

// "1,234,567" 같은 문자열을 숫자로 변환
export function toNum(s) {
  if (s == null) return null;
  const t = String(s).replace(/,/g, '').trim();
  if (t === '' || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// 계정명이 회사마다 조금씩 달라서 여러 이름을 순서대로 찾아요
export function pickAccount(rows, names) {
  for (const name of names) {
    const row = rows.find(r => r.account_nm.replace(/\s/g, '').startsWith(name));
    if (row) return { cur: toNum(row.thstrm_amount), prev: toNum(row.frmtrm_amount) };
  }
  return { cur: null, prev: null };
}

const pct = (a, b) => (a == null || b == null || b === 0 ? null : (a / b) * 100);

async function fetchFinancials(key, corpCode, year) {
  const data = await callDart('fnlttSinglAcnt', {
    crtfc_key: key, corp_code: corpCode, bsns_year: String(year), reprt_code: ANNUAL_REPORT,
  });
  if (data.status === '013') return null; // 해당 연도 데이터 없음
  if (data.status !== '000') throw new Error(`DART 오류 ${data.status}: ${data.message}`);

  // 연결재무제표(CFS) 우선, 없으면 별도(OFS)
  const cfs = data.list.filter(r => r.fs_div === 'CFS');
  const rows = cfs.length ? cfs : data.list.filter(r => r.fs_div === 'OFS');
  return {
    year,
    fsType: cfs.length ? '연결' : '별도',
    liabilities: pickAccount(rows, ['부채총계']),
    equity: pickAccount(rows, ['자본총계']),
    revenue: pickAccount(rows, ['매출액', '수익(매출액)', '영업수익']),
    operatingIncome: pickAccount(rows, ['영업이익']),
    netIncome: pickAccount(rows, ['당기순이익']),
  };
}

async function fetchDividend(key, corpCode, year) {
  const data = await callDart('alotMatter', {
    crtfc_key: key, corp_code: corpCode, bsns_year: String(year), reprt_code: ANNUAL_REPORT,
  });
  if (data.status !== '000') return { dividendYield: null, payoutRatio: null };
  const find = (label, common) => data.list.find(r =>
    r.se.replace(/\s/g, '').includes(label) && (!common || r.stock_knd === '보통주'));
  return {
    dividendYield: toNum(find('현금배당수익률', true)?.thstrm),
    payoutRatio: toNum(find('현금배당성향', false)?.thstrm),
  };
}

// 최근 사업보고서 기준으로 지표 계산 (올해 보고서가 없으면 한 해 전으로)
export async function getMetricsFromDart(key, stock) {
  const thisYear = new Date().getFullYear();
  let fin = null;
  for (const y of [thisYear - 1, thisYear - 2]) {
    fin = await fetchFinancials(key, stock.corpCode, y);
    if (fin) break;
  }
  if (!fin) throw new Error('최근 2년 사업보고서 데이터를 찾지 못했어요.');
  const div = await fetchDividend(key, stock.corpCode, fin.year);

  return {
    year: fin.year,
    source: `DART ${fin.year}년 사업보고서 (${fin.fsType})`,
    sample: false,
    metrics: {
      debtRatio: pct(fin.liabilities.cur, fin.equity.cur),
      operatingMargin: pct(fin.operatingIncome.cur, fin.revenue.cur),
      roe: pct(fin.netIncome.cur, fin.equity.cur),
      revenueGrowth: fin.revenue.prev ? pct(fin.revenue.cur - fin.revenue.prev, Math.abs(fin.revenue.prev)) : null,
      dividendYield: div.dividendYield,
      payoutRatio: div.payoutRatio,
    },
  };
}

// 기업개황: 시장 구분(코스피/코스닥)과 업종 코드
export async function getCompanyInfo(key, corpCode) {
  const data = await callDart('company', { crtfc_key: key, corp_code: corpCode });
  if (data.status !== '000') return { market: null, industryCode: null };
  return { market: data.corp_cls, industryCode: data.induty_code };
}

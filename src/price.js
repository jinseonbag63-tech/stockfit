// 주가 데이터: 공공데이터포털 "금융위원회_주식시세정보" (.env의 DATA_GO_KR_KEY)
// - 종목별 3년 일별 시세 → 변동성, 최대 하락폭, 위험 등급(97.5% VaR), 주가 흐름 화면(technical.js)
// - 전체 종목의 최근 시가총액 → PER·PBR (업종 비교 포함)
// 데이터는 실시간이 아니라 다음 영업일 오후에 업데이트돼요.
// 이용 조건: 공공누리 4유형(출처 표시, 상업적 이용 금지, 변경 금지)
import { toNum } from './dart.js';

// 현재 버전(V2) 주소. 예전 주소(/service/GetStockSecuritiesInfoService/getStockPriceInfo)는 빈 결과를 돌려줘요
const BASE = 'https://apis.data.go.kr/1160100/GetStockSecuritiesInfoService_V2/getStockPriceInfo_V2';
const STATS_TTL = 6 * 60 * 60 * 1000;
const CAPS_TTL = 12 * 60 * 60 * 1000;
const DAILY_LIMIT = 0.3; // 하루 가격제한폭 ±30%: 이보다 큰 변화는 액면분할 등으로 보고 제외

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

// 공공데이터포털은 "인코딩 키"와 "디코딩 키"를 함께 줘요. 어느 쪽을 넣어도 동작하게:
// 이미 %가 들어 있으면(인코딩 키) 그대로, 아니면(디코딩 키) 인코딩해서 붙임
function withKey(url, key) {
  const k = /%[0-9A-Fa-f]{2}/.test(key) ? key : encodeURIComponent(key);
  return `${url}&serviceKey=${k}`;
}

async function call(key, params) {
  const qs = new URLSearchParams({ resultType: 'json', ...params });
  const res = await fetch(withKey(`${BASE}?${qs}`, key));
  const text = await res.text();
  // 키 오류 등은 json을 요청해도 XML로 오는 경우가 있어요
  if (text.trim().startsWith('<')) {
    const msg = text.match(/<(returnAuthMsg|errMsg|resultMsg)>([^<]*)</)?.[2];
    throw new Error(`시세 API 오류: ${msg || `HTTP ${res.status}`}`);
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`시세 API 응답을 읽지 못했어요 (HTTP ${res.status})`); }
  const header = data.response?.header;
  if (header && header.resultCode !== '00') throw new Error(`시세 API 오류 ${header.resultCode}: ${header.resultMsg}`);
  const body = data.response?.body;
  const items = body?.items?.item ?? (Array.isArray(body?.items) ? body.items : []);
  const list = Array.isArray(items) ? items : [items];
  // 비어 있으면 원인을 찾을 수 있게 응답 모양을 남김 (키 값은 들어 있지 않음)
  lastEmpty = list.length ? null : `응답 코드 ${header?.resultCode ?? '없음'}, 전체 ${body?.totalCount ?? '?'}건, 응답 항목: ${Object.keys(data.response ?? data).join(',')}`;
  return list;
}
let lastEmpty = null;

const sameCode = (item, code) => String(item.srtnCd ?? '').replace(/^A/, '') === code;

// 97.5% VaR 기준 위험 등급 (금융위 위험등급 가이드라인의 펀드 변동성 등급 구간을 준용)
// 1등급이 가장 위험
export const RISK_GRADES = [
  null,
  { grade: 1, label: '매우 높은 위험' },
  { grade: 2, label: '높은 위험' },
  { grade: 3, label: '다소 높은 위험' },
  { grade: 4, label: '보통 위험' },
  { grade: 5, label: '낮은 위험' },
  { grade: 6, label: '매우 낮은 위험' },
];
export function riskGradeFromVar(v) {
  if (v == null) return null;
  const g = v > 50 ? 1 : v > 30 ? 2 : v > 20 ? 3 : v > 10 ? 4 : v > 1 ? 5 : 6;
  return { ...RISK_GRADES[g], var975: v };
}

// 종가 목록 → 위험 지표
export function priceStats(rows) {
  const closes = rows.map(r => r.close);
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    const r = closes[i] / closes[i - 1] - 1;
    if (Math.abs(r) <= DAILY_LIMIT) returns.push(r);
  }
  if (returns.length < 60) return null; // 상장한 지 얼마 안 된 종목 등

  const last = returns.slice(-250);
  const mean = last.reduce((a, b) => a + b, 0) / last.length;
  const sd = Math.sqrt(last.reduce((a, b) => a + (b - mean) ** 2, 0) / (last.length - 1));

  // 분할 등을 걸러낸 수익률로 가격 흐름을 다시 만들어 최대 하락폭 계산
  let idx = 1, peak = 1, mdd = 0;
  for (const r of last) { idx *= 1 + r; peak = Math.max(peak, idx); mdd = Math.min(mdd, idx / peak - 1); }

  // 97.5% VaR: 일간 수익률 하위 2.5% 손실 × √250 (최대 3년)
  const sorted = returns.slice(-750).sort((a, b) => a - b);
  const q = sorted[Math.floor(sorted.length * 0.025)];

  return {
    volatility: sd * Math.sqrt(250) * 100,
    maxDrawdown: mdd * 100,
    return1y: (idx - 1) * 100,
    risk: riskGradeFromVar(Math.abs(Math.min(q, 0)) * Math.sqrt(250) * 100),
    days: last.length,
  };
}

// 종목별 3년 일별 시세 (시가·고가·저가·종가·거래량·등락률·시가총액). 위험 지표와 주가 흐름 화면이 같이 써요
const historyCache = new Map();
const HISTORY_CACHE_MAX = 300; // 메모리를 너무 쓰지 않게 오래된 것부터 지움
export async function getPriceHistory(key, code) {
  const hit = historyCache.get(code);
  if (hit && Date.now() - hit.at < STATS_TTL) return hit.rows;
  const begin = new Date();
  begin.setFullYear(begin.getFullYear() - 3);
  const items = await call(key, { likeSrtnCd: code, beginBasDt: ymd(begin), numOfRows: '1000', pageNo: '1' });
  const rows = items.filter(i => sameCode(i, code))
    .map(i => ({ date: String(i.basDt), open: toNum(i.mkp), high: toNum(i.hipr), low: toNum(i.lopr), close: toNum(i.clpr),
                 volume: toNum(i.trqu), change: toNum(i.fltRt), cap: toNum(i.mrktTotAmt) }))
    .filter(r => r.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) throw new Error(`이 종목의 시세 데이터가 없어요. (${lastEmpty ?? `받은 ${items.length}건 중 종목코드 일치 없음`})`);
  historyCache.delete(code);
  historyCache.set(code, { at: Date.now(), rows });
  if (historyCache.size > HISTORY_CACHE_MAX) historyCache.delete(historyCache.keys().next().value);
  return rows;
}

export async function getPriceStats(key, code) {
  const rows = await getPriceHistory(key, code);
  const latest = rows[rows.length - 1];
  return { asOf: latest.date, close: latest.close, marketCap: latest.cap, ...priceStats(rows) };
}

// 전체 종목의 최근 시가총액 (업종 PER·PBR 비교용). 최근 영업일을 찾아 하루치를 한 번에
let capsCache = null;
export async function getMarketCaps(key) {
  if (capsCache && Date.now() - capsCache.at < CAPS_TTL) return capsCache.caps;
  const d = new Date();
  for (let i = 0; i < 10; i++, d.setDate(d.getDate() - 1)) {
    const items = await call(key, { basDt: ymd(d), numOfRows: '5000', pageNo: '1' });
    if (items.length) {
      const caps = new Map(items.map(it => [String(it.srtnCd ?? '').replace(/^A/, ''), toNum(it.mrktTotAmt)]));
      capsCache = { at: Date.now(), caps, asOf: ymd(d) };
      return caps;
    }
  }
  throw new Error(`최근 10일 동안의 시세 데이터를 찾지 못했어요. (${lastEmpty})`);
}

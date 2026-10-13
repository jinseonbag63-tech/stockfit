// 거시 지표: 한국은행 ECOS (.env의 ECOS_API_KEY) → 기준금리, 국고채 3년 금리
// 1순위: "100대 통계지표"에서 이름으로 찾기 (통계 코드가 바뀌어도 동작)
// 2순위: 통계 코드로 직접 조회
const BASE = 'https://ecos.bok.or.kr/api';
const TTL = 12 * 60 * 60 * 1000;
// 금리가 이 이상이면 "고금리"로 보고 안정성 비중을 높여요
export const HIGH_RATE = 3.5;

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const num = v => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null; };

async function call(path) {
  const res = await fetch(`${BASE}/${path}`);
  if (!res.ok) throw new Error(`ECOS 서버 응답 오류 (HTTP ${res.status})`);
  const data = await res.json();
  // 오류는 { RESULT: { CODE, MESSAGE } } 형태
  if (data.RESULT) {
    if (data.RESULT.CODE === 'INFO-200') return null; // 데이터 없음
    throw new Error(`ECOS 오류 ${data.RESULT.CODE}: ${data.RESULT.MESSAGE}`);
  }
  return data;
}

async function fromKeyStatistics(key) {
  const data = await call(`KeyStatisticList/${encodeURIComponent(key)}/json/kr/1/100`);
  const rows = data?.KeyStatisticList?.row ?? [];
  const find = re => rows.find(r => re.test(String(r.KEYSTAT_NAME ?? '').replace(/\s/g, '')));
  const base = find(/기준금리/), bond = find(/국고채.*3년/);
  return {
    baseRate: num(base?.DATA_VALUE), baseRateAsOf: base?.CYCLE ?? null,
    bond3y: num(bond?.DATA_VALUE), bond3yAsOf: bond?.CYCLE ?? null,
  };
}

// 일별 통계의 가장 최근 값
async function latestDaily(key, statCode, itemCode) {
  const end = new Date(), begin = new Date(end.getTime() - 45 * 24 * 60 * 60 * 1000);
  const data = await call(`StatisticSearch/${encodeURIComponent(key)}/json/kr/1/100/${statCode}/D/${ymd(begin)}/${ymd(end)}/${itemCode}`);
  const rows = data?.StatisticSearch?.row ?? [];
  const last = rows[rows.length - 1];
  return last ? { value: num(last.DATA_VALUE), asOf: last.TIME } : { value: null, asOf: null };
}

let cache = null;
export async function getRates(key) {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  let r = { baseRate: null, bond3y: null };
  try { r = await fromKeyStatistics(key); } catch (err) { console.error('[ECOS 100대 지표]', err.message); }
  if (r.baseRate == null) {
    const b = await latestDaily(key, '722Y001', '0101000'); // 한국은행 기준금리
    r.baseRate = b.value; r.baseRateAsOf = b.asOf;
  }
  if (r.bond3y == null) {
    const b = await latestDaily(key, '817Y002', '010200000'); // 국고채(3년)
    r.bond3y = b.value; r.bond3yAsOf = b.asOf;
  }
  if (r.baseRate == null && r.bond3y == null) throw new Error('ECOS에서 금리 데이터를 찾지 못했어요.');
  const data = { ...r, highRate: r.bond3y != null && r.bond3y >= HIGH_RATE };
  cache = { at: Date.now(), data };
  return data;
}

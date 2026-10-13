// 업종 비교: 상장사 전체의 업종 코드와 재무 지표를 DART에서 모아 DB에 저장하고,
// 한 종목의 지표가 같은 업종(KSIC 앞 2자리) 안에서 몇 등쯤인지(백분위) 계산
// - 처음 한 번은 상장사 수만큼 기업개황을 불러서 10분 넘게 걸려요(서버는 그동안 기존 기준표로 동작)
// - 업종 코드는 90일, 재무 지표는 7일마다 새로 받아요
import { callDart, chooseStatement, mainAccounts, coreMetrics } from './dart.js';
import { allCompanies, hasFullList } from './corpCodes.js';

const INFO_MAX_AGE = 90 * 24 * 60 * 60 * 1000;
const METRIC_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const GAP_MS = 150;     // DART 호출 사이 간격 (분당 400회 정도)
const CHUNK = 100;      // 다중회사 API는 한 번에 100개까지
export const MIN_PEERS = 8; // 같은 업종 회사가 이보다 적으면 업종 비교 대신 기준표 사용

let db;
const state = { running: false, phase: '대기 중', done: 0, total: 0, error: null, finishedAt: null };
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function initPeers(database) { db = database; }

export async function peerStatus() {
  const c = db ? await db.get(`SELECT (SELECT COUNT(*) FROM company_info) AS companies,
    (SELECT COUNT(*) FROM peer_metrics WHERE metrics <> '{}') AS metrics`) : null;
  return { ...state, companies: Number(c?.companies ?? 0), metrics: Number(c?.metrics ?? 0) };
}

// DART 응답 상태 확인: 한도 초과(020) 등은 이번 수집을 멈춤
function check(d) {
  if (d.status === '000' || d.status === '013') return d.status === '000';
  throw new Error(`DART 오류 ${d.status}: ${d.message}`);
}

// 마지막으로 받은 시각을 한 번에 읽어오기 (회사마다 따로 물으면 원격 DB에서 느려요)
async function ages(sql, params = []) {
  return new Map((await db.all(sql, params)).map(r => [r.corp_code, Number(r.updated_at)]));
}

export async function syncPeers(key) {
  if (!key || !db || state.running || !hasFullList()) return;
  Object.assign(state, { running: true, error: null });
  try {
    const companies = allCompanies();

    // 1) 업종 코드 (기업개황)
    const infoAge = await ages('SELECT corp_code, updated_at FROM company_info');
    const stale = companies.filter(c => !infoAge.has(c.corpCode) || Date.now() - infoAge.get(c.corpCode) > INFO_MAX_AGE);
    Object.assign(state, { phase: '상장사 업종 정보를 모으는 중', done: 0, total: stale.length });
    for (const c of stale) {
      const d = await callDart('company', { crtfc_key: key, corp_code: c.corpCode });
      if (check(d)) {
        await db.run(`INSERT INTO company_info (corp_code, stock_code, industry_code, market, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(corp_code) DO UPDATE SET stock_code = excluded.stock_code, industry_code = excluded.industry_code,
          market = excluded.market, updated_at = excluded.updated_at`,
        [c.corpCode, c.code, d.induty_code || null, d.corp_cls || null, Date.now()]);
      }
      state.done++;
      await sleep(GAP_MS);
    }

    // 2) 재무 지표 (최근 2개 연도, 100개씩)
    const thisYear = new Date().getFullYear();
    for (const year of [thisYear - 1, thisYear - 2]) {
      const metricAge = await ages('SELECT corp_code, updated_at FROM peer_metrics WHERE year = ?', [year]);
      const need = companies.filter(c => !metricAge.has(c.corpCode) || Date.now() - metricAge.get(c.corpCode) > METRIC_MAX_AGE);
      Object.assign(state, { phase: `${year}년 재무 지표를 모으는 중`, done: 0, total: Math.ceil(need.length / CHUNK) });
      for (let i = 0; i < need.length; i += CHUNK) {
        const chunk = need.slice(i, i + CHUNK);
        const d = await callDart('fnlttMultiAcnt', {
          crtfc_key: key, corp_code: chunk.map(c => c.corpCode).join(','), bsns_year: String(year), reprt_code: '11011',
        });
        const rows = check(d) ? d.list : [];
        await db.tx(async t => {
          for (const c of chunk) {
            const own = rows.filter(r => r.corp_code === c.corpCode || r.stock_code === c.code);
            // 데이터가 없는 회사도 '{}'로 기록해서 7일 동안 다시 묻지 않음
            const metrics = own.length ? coreMetrics(mainAccounts(chooseStatement(own).rows)) : {};
            await t.run(`INSERT INTO peer_metrics (corp_code, year, metrics, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(corp_code, year) DO UPDATE SET metrics = excluded.metrics, updated_at = excluded.updated_at`,
            [c.corpCode, year, JSON.stringify(metrics), Date.now()]);
          }
        });
        state.done++;
        peerCache.clear();
        await sleep(GAP_MS);
      }
    }
    Object.assign(state, { phase: '완료', finishedAt: Date.now() });
    console.log(`[업종 비교] 준비 완료: ${(await peerStatus()).metrics.toLocaleString()}건`);
  } catch (err) {
    Object.assign(state, { phase: '중단됨', error: err.message });
    console.error('[업종 비교] 수집 중단:', err.message, '→ 다음 수집 때 이어서 받아요.');
  } finally {
    state.running = false;
  }
}

// 같은 업종 회사들의 지표 (1시간 캐시). 분석 전에 한 번 불러두고 rankAmong으로 순위 계산
const peerCache = new Map();
export async function loadPeers(industryCode, year) {
  if (!db || !industryCode || !year) return [];
  const key = `${String(industryCode).slice(0, 2)}:${year}`;
  const hit = peerCache.get(key);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.rows;
  const rows = (await db.all(`SELECT c.corp_code, c.stock_code, m.metrics FROM peer_metrics m
      JOIN company_info c ON c.corp_code = m.corp_code WHERE substr(c.industry_code, 1, 2) = ? AND m.year = ?`,
    [String(industryCode).slice(0, 2), year]))
    .map(r => ({ corpCode: r.corp_code, stockCode: r.stock_code, m: JSON.parse(r.metrics) }));
  peerCache.set(key, { at: Date.now(), rows });
  return rows;
}

// 업종 안 순위 → 0~100점. pick(peer)로 비교할 값을 꺼냄 (PER처럼 시가총액이 필요한 경우)
// 데이터가 MIN_PEERS보다 적으면 null
export function rankAmong(peers, { value, higherIsBetter, pick }) {
  if (value == null) return null;
  const vals = peers.map(pick).filter(Number.isFinite);
  if (vals.length < MIN_PEERS) return null;
  const below = vals.filter(v => v < value).length;
  const equal = vals.filter(v => v === value).length;
  const pctBelow = ((below + equal / 2) / vals.length) * 100;
  return { score: higherIsBetter ? pctBelow : 100 - pctBelow, peers: vals.length };
}

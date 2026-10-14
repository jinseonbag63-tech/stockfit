// 내 성향에 맞는 종목: 후보 종목(시가총액 상위 50개)의 데이터를 미리 모아두고,
// 접속한 사람의 성향으로 적합도만 다시 계산해 높은 순서로 보여줘요.
// (재무·주가 데이터는 성향과 상관없고, 적합도 계산은 가벼워서 성향이 바뀌어도 바로 다시 계산돼요)
// 투자 추천이 아니라, 정해진 후보 안에서 "내 기준에 더 가까운 순서"예요.
const REFRESH_MS = 24 * 60 * 60 * 1000;
const GAP_MS = 200; // 후보 하나씩 준비할 때 외부 API 사이 간격

const sleep = ms => new Promise(r => setTimeout(r, ms));

// listCandidates(): { stocks, basis } / stockInputs(stock): 성향과 무관한 분석 재료 / scoreStock(inputs, answers): { profile, fit }
export function createPicks({ listCandidates, stockInputs, scoreStock }) {
  let pool = []; // [{ stock, inputs }]
  let scheduled = false; // 시작 전(업종 비교 데이터를 기다리는 중)에도 "준비 중"으로 보이게
  const state = { running: false, done: 0, total: 0, basis: null, updatedAt: null, error: null };

  async function refresh() {
    if (state.running) return;
    Object.assign(state, { running: true, error: null, done: 0 });
    try {
      const { stocks, basis } = await listCandidates();
      Object.assign(state, { total: stocks.length, basis });
      // 다 모은 뒤 한 번에 교체 (일부만 모인 상태로 "상위 5개"를 보여주면 틀린 순위가 돼요)
      const next = [];
      for (const stock of stocks) {
        try {
          next.push({ stock, inputs: await stockInputs(stock) });
        } catch (err) {
          console.error(`[성향 맞춤 종목] ${stock.name}:`, err.message); // 한 종목이 실패해도 나머지는 계속
        }
        state.done++;
        await sleep(GAP_MS);
      }
      pool = next;
      state.updatedAt = Date.now();
      console.log(`[성향 맞춤 종목] 후보 ${pool.length}곳 준비 완료 (${basis === 'marketcap' ? '시가총액 상위' : basis === 'list' ? '주요 종목 목록' : '예시 종목'})`);
    } catch (err) {
      state.error = err.message;
      console.error('[성향 맞춤 종목] 준비 실패:', err.message);
    } finally {
      state.running = false;
    }
  }

  // 성향 기준 적합도 상위 n개. reason: 내 성향에서 비중이 크고 점수도 좋은 기준
  function top(answers, n = 5) {
    return pool
      .filter(p => !p.inputs.data.sample || pool.every(q => q.inputs.data.sample)) // 실제 데이터가 있으면 예시는 빼기
      .map(p => ({ stock: p.stock, ...scoreStock(p.inputs, answers) }))
      .sort((a, b) => b.fit.total - a.fit.total)
      .slice(0, n)
      .map(({ stock, fit }) => ({
        code: stock.code, name: stock.name, total: fit.total, verdict: fit.verdict,
        reason: fit.parts.filter(p => p.score >= 60).sort((a, b) => b.weight - a.weight).slice(0, 2).map(p => p.label),
      }));
  }

  return {
    refresh,
    top,
    status: () => ({ ...state, preparing: state.running || !scheduled, ready: pool.length > 0, count: pool.length }),
    schedule() {
      scheduled = true;
      refresh();
      setInterval(refresh, REFRESH_MS).unref();
    },
  };
}

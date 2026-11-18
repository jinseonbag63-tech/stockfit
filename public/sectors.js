// 주가 흐름 화면의 "업종별" 탭: 시장 전체, 업종 순위 TOP 5(최근 강한 / 과열 / 침체), 전체 업종 표
// 계산은 서버(src/sectors.js)가 하고, 여기서는 그리기만 해요. 처음 탭을 열 때 불러와요.
// app.js가 initSectors({ $, esc, api, openTrend })로 필요한 도구를 넘겨줘요.
import { onTrendTab } from './technical.js';

let $, esc, api, openTrend;
let data = null, loading = false, rank = 'strong', retryTimer;

const RANK_NOTE = {
  strong: '최근 1개월 동안 많이 오른 순서예요.',
  hot: '주가 온도가 높은 순서예요. 짧은 기간에 많이 올라 흔들리기 쉬운 업종이에요.',
  cold: '주가 온도가 낮은 순서예요. 짧은 기간에 많이 떨어진 업종이에요.',
};
// 온도 단계 → 주가 흐름 화면과 같은 배지 색
const TEMP_SIG = { hot: 'hot', warm: 'up', neutral: 'neutral', cool: 'down', cold: 'cold' };
const pct = v => (v == null ? '-' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
const chg = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const day = d => `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}`;
// 받침이 있으면 "이에요", 없으면 "예요" (예: 의복·패션이에요 / IT 서비스예요)
const ieyo = w => { const c = w.charCodeAt(w.length - 1); return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? '이에요' : '예요'; };
// 시가총액(원) → 조 단위
const cap = v => (v >= 1e12 ? `${(v / 1e12).toLocaleString(undefined, { maximumFractionDigits: 1 })}조 원` : `${Math.round(v / 1e8).toLocaleString()}억 원`);
const expertStats = s => `<span class="expert-only">RSI ${s.rsi ?? '-'}</span><span class="expert-only">20일 평균 대비 ${pct(s.dev20)}</span><span class="expert-only">시총 ${cap(s.cap)}</span>`;
const temp = t => (t ? `<span class="sig ${TEMP_SIG[t.level]}">${esc(t.label)} ${t.score}</span>` : '<span class="sig none">-</span>');

export function initSectors(deps) {
  ({ $, esc, api, openTrend } = deps);
  onTrendTab(tab => { if (tab === 'sector' && !data) load(); });
  $('sectorRankTabs').addEventListener('click', e => {
    const b = e.target.closest('[data-rank]');
    if (!b) return;
    rank = b.dataset.rank;
    $('sectorRankTabs').querySelectorAll('[data-rank]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    renderTop();
  });
  // 대표 종목을 누르면 종목별 탭에서 그 종목의 주가 흐름
  $('sectorView').addEventListener('click', e => {
    const b = e.target.closest('[data-code]');
    if (b) openTrend(b.dataset.code, b.dataset.name);
  });
}

async function load() {
  if (loading) return;
  loading = true;
  clearTimeout(retryTimer);
  try {
    const d = await api('/api/sectors');
    const s = d.status;
    if (!d.days || d.days < 20) {
      // 아직 모으는 중: 진행 상황을 보여주고 잠시 뒤 다시 확인
      $('sectorStatus').textContent = s?.error ? `업종 데이터를 모으지 못했어요: ${s.error}`
        : `업종별 지수를 만들기 위해 최근 주가를 모으는 중이에요 (${s?.done ?? 0}/${s?.total ?? 80}거래일). 처음 한 번만 몇 분 걸려요.`;
      $('sectorStatus').hidden = false;
      $('sectorBody').hidden = true;
      retryTimer = setTimeout(load, 15000);
      return;
    }
    data = d;
    render();
  } catch (e) {
    $('sectorStatus').textContent = e.message;
    $('sectorStatus').hidden = false;
  } finally { loading = false; }
}

function render() {
  const d = data, m = d.market;
  $('sectorStatus').hidden = true;
  $('sectorBody').hidden = false;
  $('sectorAsOf').textContent = `${day(d.asOf)} 종가 기준 · 최근 ${d.days}거래일`;
  // 초보자 모드: 맨 위 한 줄 요약
  const byCode = Object.fromEntries(d.sectors.map(s => [s.code, s]));
  const strong = byCode[d.rankings.strong[0]], cold = byCode[d.rankings.cold[0]];
  $('sectorSummary').innerHTML = m?.temperature ? `요즘 시장 전체는 <strong>${esc(m.temperature.label)}</strong> 상태이고 최근 1개월 <strong class="chg ${chg(m.month)}">${pct(m.month)}</strong>예요.`
    + (strong ? ` 최근 가장 강한 업종은 <strong>${esc(strong.name)}</strong>${cold ? '' : `${ieyo(strong.name)}.`}` : '')
    + (cold ? `${strong ? ',' : ''} 가장 침체된 업종은 <strong>${esc(cold.name)}</strong>${ieyo(cold.name)}.` : '') : '';
  $('sectorMarket').innerHTML = !m ? '' : `
    <div><span>주가 온도</span>${temp(m.temperature)}</div>
    <div><span>흐름</span><strong>${esc(m.trend?.label ?? '-')}</strong></div>
    <div><span>1주</span><strong class="chg ${chg(m.week)}">${pct(m.week)}</strong></div>
    <div><span>1개월</span><strong class="chg ${chg(m.month)}">${pct(m.month)}</strong></div>
    <div><span>오늘 오른 종목</span><strong>${m.upRatio}%</strong></div>
    <div class="spark-cell">${spark(m.spark)}</div>`;
  renderTop();
  const list = d.sectors.filter(s => s.n >= d.minStocks);
  $('sectorAllTitle').textContent = `전체 업종 보기 (종목 ${d.minStocks}개 이상 ${list.length}개 업종, 1개월 등락 순)`;
  $('sectorAll').innerHTML = list.map(s => `<tr>
      <td><strong>${esc(s.name)}</strong></td><td class="num">${s.n}</td><td>${temp(s.temperature)}</td>
      <td>${esc(s.trend?.label ?? '-')}</td><td class="num chg ${chg(s.week)}">${pct(s.week)}</td>
      <td class="num chg ${chg(s.month)}">${pct(s.month)}</td><td class="num">${s.upRatio}%</td>
      <td class="num expert-only">${s.rsi ?? '-'}</td><td class="num expert-only">${pct(s.dev20)}</td><td class="num expert-only">${cap(s.cap)}</td></tr>`).join('');
  $('sectorFine').textContent = '업종은 공식 업종 분류(KSIC) 기준이라 반도체·바이오 같은 테마 이름과 조금 다를 수 있어요. '
    + '업종·시장 지수는 공식 코스피·업종 지수가 아니라 코스피·코스닥 상장사를 시가총액 가중으로 묶어 직접 계산했어요. '
    + `종목이 ${d.minStocks}개 미만인 업종은 순위에서 뺐어요. 최근 움직임 순위일 뿐 투자 권유가 아니에요.`;
}

function renderTop() {
  const byCode = Object.fromEntries(data.sectors.map(s => [s.code, s]));
  $('sectorRankNote').textContent = RANK_NOTE[rank];
  $('sectorTop').innerHTML = data.rankings[rank].map(code => byCode[code]).filter(Boolean).map((s, i) => `
    <li>
      <span class="rank-no">${i + 1}</span>
      <div class="sector-main">
        <p class="sector-name"><strong>${esc(s.name)}</strong> <span class="meta">${s.n}종목</span></p>
        <p class="sector-stats">${temp(s.temperature)} <span>${esc(s.trend?.label ?? '')}</span>
          <span>1주 <b class="chg ${chg(s.week)}">${pct(s.week)}</b></span>
          <span>1개월 <b class="chg ${chg(s.month)}">${pct(s.month)}</b></span>
          <span>오늘 오른 종목 ${s.upRatio}%</span>${expertStats(s)}</p>
        ${s.leaders.length ? `<p class="sector-leaders">대표 종목 ${s.leaders.map(l =>
          `<button type="button" class="link-btn" data-code="${esc(l.code)}" data-name="${esc(l.name)}">${esc(l.name)}</button>`).join(' ')}</p>` : ''}
      </div>
      <div class="spark-cell">${spark(s.spark)}</div>
    </li>`).join('');
}

// 최근 60거래일 지수 흐름을 작은 선으로 (시작보다 높으면 빨강, 낮으면 파랑)
function spark(vals) {
  if (!vals?.length) return '';
  const W = 120, H = 36, lo = Math.min(...vals), hi = Math.max(...vals) || 1;
  const x = i => (i / Math.max(1, vals.length - 1)) * W;
  const y = v => (hi === lo ? H / 2 : 2 + (1 - (v - lo) / (hi - lo)) * (H - 4));
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return `<svg class="spark ${vals[vals.length - 1] >= vals[0] ? 'up' : 'down'}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path d="${d}"/></svg>`;
}

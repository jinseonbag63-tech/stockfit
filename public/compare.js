// 종목 비교 화면 (#compare): 두 종목을 내 성향 기준으로 여섯 가지 기준별로 나란히 비교
// 서버의 종목 분석 API(/api/analyze)를 종목마다 한 번씩 불러서 그리기만 해요 (점수는 종목 분석 화면과 같음).
// app.js가 initCompare({ $, esc, show, api, getProfile, getWatchStocks, onAnalyze })로 필요한 도구를 넘겨줘요.
import { onShowView, goTo } from './views.js';

let $, esc, show, api, getProfile, getWatchStocks, onAnalyze;
let pair = null; // [A 분석 결과, B 분석 결과]

// 사용자가 말한 순서 그대로
const ORDER = ['stability', 'profitability', 'growth', 'valuation', 'dividend', 'volatility'];
const SAME = 5; // 점수 차이가 이보다 작으면 "비슷해요"
const NEEDS_PRICE = ['valuation', 'volatility'];
// 주어 조사: 받침이 있으면 '이', 없으면 '가' (삼성전자가, 현대차가 / SK하이닉스가)
const iGa = w => {
  const c = w.charCodeAt(w.length - 1);
  return `${w}${c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 > 0 ? '이' : '가'}`;
};

export function initCompare(deps) {
  ({ $, esc, show, api, getProfile, getWatchStocks, onAnalyze } = deps);
  onShowView('compare', renderWatchChips);
  $('compareForm').addEventListener('submit', e => { e.preventDefault(); load($('compareA').value, $('compareB').value); });
  // 관심종목 버튼: 빈 칸부터 채우고, 둘 다 차 있으면 두 번째를 바꿈
  $('compareWatchChips').addEventListener('click', e => {
    const b = e.target.closest('[data-name]');
    if (!b) return;
    const target = !$('compareA').value.trim() ? 'compareA' : 'compareB';
    $(target).value = b.dataset.name;
    if ($('compareA').value.trim() && $('compareB').value.trim()) $('compareForm').requestSubmit();
  });
  $('compareHeads').addEventListener('click', e => {
    const b = e.target.closest('[data-code]');
    if (b) onAnalyze(b.dataset.code, b.dataset.name);
  });
}

// 관심종목 화면의 "선택한 두 종목 비교하기"에서 열 때
export function openCompare(a, b) {
  $('compareA').value = a.name;
  $('compareB').value = b.name;
  goTo('compare');
  load(a.code, b.code);
}

// 성향이 바뀌면 같은 두 종목으로 다시 비교
export function refreshCompare() {
  if (pair) load(pair[0].stock.code, pair[1].stock.code);
}

function renderWatchChips() {
  const list = getWatchStocks();
  $('compareWatch').hidden = !list.length;
  $('compareWatchChips').innerHTML = list.map(s => `<button type="button" data-name="${esc(s.name)}"><strong>${esc(s.name)}</strong></button>`).join('');
}

async function load(qa, qb) {
  if (!qa?.trim() || !qb?.trim()) return;
  show($('compareError'), '');
  const params = q => new URLSearchParams({ q: q.trim(), ...(getProfile() || {}) });
  try {
    const [a, b] = await Promise.all([api(`/api/analyze?${params(qa)}`), api(`/api/analyze?${params(qb)}`)]);
    if (a.stock.code === b.stock.code) throw new Error('서로 다른 두 종목을 골라주세요.');
    pair = [a, b];
    render(a, b);
  } catch (e) { show($('compareError'), e.message); }
}

function render(a, b) {
  $('compareEmpty').hidden = true;
  $('compareResult').hidden = false;
  const profile = a.profile;
  $('compareProfile').textContent = getProfile()
    ? `${profile.riskLevel} 기준으로 비교했어요. 성향은 위쪽 "내 투자성향"에서 바꿀 수 있어요.`
    : '아직 투자성향을 정하지 않아서 기본 기준으로 비교했어요.';

  const notes = [];
  if (a.sample || b.sample) notes.push('예시 데이터로 비교하고 있어요.');
  if (a.sources?.price !== 'on' || b.sources?.price !== 'on') notes.push('주가 데이터가 없어서 가격 수준·주가 안정성은 비교할 수 없어요.');
  show($('compareNotice'), notes.join(' '));

  // 종목별 머리: 이름, 종합 적합도, 판정
  $('compareHeads').innerHTML = [a, b].map((d, i) => `
    <div class="cmp-head ${i ? 'b' : 'a'}">
      <p class="cmp-name"><span class="cmp-dot" aria-hidden="true"></span>${esc(d.stock.name)}</p>
      <p class="meta">${esc([d.stock.code, d.stock.sector].filter(Boolean).join(' · '))}</p>
      <p class="cmp-total"><strong>${d.fit.total}</strong><small>/ 100 적합도</small></p>
      <p class="cmp-verdict-text">${esc(d.fit.verdict)}</p>
      <button type="button" class="link-btn" data-code="${esc(d.stock.code)}" data-name="${esc(d.stock.name)}">종목 분석 보기 →</button>
    </div>`).join('');

  const partsA = Object.fromEntries(a.fit.parts.map(p => [p.key, p]));
  const partsB = Object.fromEntries(b.fit.parts.map(p => [p.key, p]));
  const result = key => {
    const sa = partsA[key]?.score, sb = partsB[key]?.score;
    if (sa == null || sb == null) return { who: null, text: '비교할 수 없어요' };
    if (Math.abs(sa - sb) < SAME) return { who: 'same', text: '비슷해요' };
    const win = sa > sb ? a : b;
    return { who: sa > sb ? 'a' : 'b', text: `${iGa(win.stock.name)} 더 좋아요` };
  };
  const missing = (d, key) => (NEEDS_PRICE.includes(key) && d.sources?.price !== 'on' ? '주가 데이터 없음' : '정보 없음');
  const bar = (d, part, side, key) => (part?.score == null
    ? `<div class="cmp-bar ${side} none"><i></i><em>${missing(d, key)}</em></div>`
    : `<div class="cmp-bar ${side}"><i><span style="width:${Math.max(2, Math.round(part.score))}%"></span></i><em>${Math.round(part.score)}점</em></div>`);

  // 전문가 모드: 기준 안의 지표 값을 나란히 (값 · 지표 점수)
  const indA = Object.fromEntries(a.indicators.map(i => [i.key, i]));
  const indB = Object.fromEntries(b.indicators.map(i => [i.key, i]));
  const itemScore = (part, key) => {
    const s = part?.items.find(i => i.key === key)?.score;
    return s == null ? '' : ` <small>${Math.round(s)}점</small>`;
  };
  const detail = key => {
    const items = (partsA[key] ?? partsB[key])?.items ?? [];
    return `<details class="cmp-detail expert-only"><summary>지표별로 보기</summary>
      <table class="trend-table"><thead><tr><th>지표</th><th>${esc(a.stock.name)}</th><th>${esc(b.stock.name)}</th></tr></thead><tbody>
      ${items.map(it => `<tr><td>${esc(it.label)}</td>
        <td class="num">${esc(indA[it.key]?.value ?? '-')}${itemScore(partsA[key], it.key)}</td>
        <td class="num">${esc(indB[it.key]?.value ?? '-')}${itemScore(partsB[key], it.key)}</td></tr>`).join('')}
      </tbody></table></details>`;
  };

  $('compareRows').innerHTML = ORDER.map(key => {
    const label = (partsA[key] ?? partsB[key])?.label ?? key;
    const r = result(key);
    const w = profile.weights[key];
    return `
    <div class="cmp-row">
      <div class="cmp-label"><strong>${esc(label)}</strong><span>내 비중 ${Math.round(w * 100)}%</span></div>
      <div class="cmp-bars">${bar(a, partsA[key], 'a', key)}${bar(b, partsB[key], 'b', key)}</div>
      <p class="cmp-result ${r.who ?? 'none'}">${esc(r.text)}</p>
      ${detail(key)}
    </div>`;
  }).join('');

  // 초보자 모드: 한 줄 결론
  const lead = { a: [], b: [], same: [] };
  for (const key of ORDER) { const r = result(key); if (r.who) lead[r.who].push((partsA[key] ?? partsB[key]).label); }
  const top = ORDER.filter(k => partsA[k]?.score != null && partsB[k]?.score != null)
    .sort((x, y) => profile.weights[y] - profile.weights[x])[0];
  const lines = [
    lead.a.length ? `앞서는 기준 · <strong>${esc(a.stock.name)}</strong>: ${esc(lead.a.join(', '))}` : null,
    lead.b.length ? `앞서는 기준 · <strong>${esc(b.stock.name)}</strong>: ${esc(lead.b.join(', '))}` : null,
    lead.same.length ? `비슷한 기준: ${esc(lead.same.join(', '))}` : null,
  ].filter(Boolean);
  if (top) {
    const r = result(top), label = partsA[top].label;
    lines.push(r.who === 'same' ? `내가 가장 중요하게 보는 <strong>${esc(label)}</strong>에서는 두 종목이 비슷해요.`
      : `내가 가장 중요하게 보는 <strong>${esc(label)}</strong>에서는 ${esc(iGa((r.who === 'a' ? a : b).stock.name))} 앞서요.`);
  }
  $('compareSummary').innerHTML = lines.map(l => `<span>${l}</span>`).join('');
}

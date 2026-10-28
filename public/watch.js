// 관심종목 화면 (#watch): 표(적합도·기준 6개·주가 온도·전일 대비), 삭제·정렬·순서 바꾸기, 구성 진단, 두 종목 비교 선택
// 관심종목 목록 자체(이 기기·계정 저장)는 app.js가 관리하고, 여기서는 그리기와 화면 안 동작만 해요.
// app.js가 initWatch({ $, esc, api, store, analyze, getProfile, getWatchlist, setWatchlist, onAnalyze, onCompare })로 넘겨줘요.
import { onShowView, currentView } from './views.js';

let $, esc, api, store, analyze, getProfile, getWatchlist, setWatchlist, onAnalyze, onCompare;
let results = [];       // [{ code, d }] 관심종목 순서대로, d는 종목 분석 결과 (실패하면 null)
const trends = {};      // 종목코드 → 주가 흐름 결과 (없거나 실패하면 null). 관심종목 화면을 열 때만 불러옴
const picked = new Set(); // 비교하려고 고른 종목 (다시 그려도 유지)
let loadSeq = 0;

const SORT_KEY = 'stockfit.watchSort';
const ORDER = ['stability', 'profitability', 'growth', 'valuation', 'dividend', 'volatility'];
const SHORT = { stability: '안정', profitability: '수익', growth: '성장', valuation: '가격', dividend: '배당', volatility: '주가' };
// 주가 온도 → 주가 흐름 화면과 같은 배지 색
const TEMP_SIG = { hot: 'hot', warm: 'up', neutral: 'neutral', cool: 'down', cold: 'cold' };

export function initWatch(deps) {
  ({ $, esc, api, store, analyze, getProfile, getWatchlist, setWatchlist, onAnalyze, onCompare } = deps);
  $('watchSort').value = store.get(SORT_KEY, 'mine');
  $('watchSort').addEventListener('change', () => { store.set(SORT_KEY, $('watchSort').value); render(); });
  onShowView('watch', loadTrends);

  $('watchList').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.code) return onAnalyze(b.dataset.code, b.dataset.name);
    if (b.dataset.remove) return remove(b.dataset.remove);
    if (b.dataset.move) return move(b.dataset.move, Number(b.dataset.dir));
  });
  $('watchList').addEventListener('change', e => {
    const c = e.target.closest('[data-pick]');
    if (!c) return;
    if (c.checked) picked.add(c.dataset.pick); else picked.delete(c.dataset.pick);
    updateCompare();
  });
  $('watchCompareBtn').addEventListener('click', () => {
    const [a, b] = [...picked].map(code => watchStocks().find(s => s.code === code));
    if (a && b) onCompare(a, b);
  });
}

// 불러온 관심종목 [{ code, name }] (종목 비교 화면의 "관심종목에서 고르기")
export const watchStocks = () => results.filter(r => r.d).map(r => ({ code: r.code, name: r.d.stock.name }));

// 관심종목이나 성향이 바뀌면 다시 분석
export async function refreshWatch() {
  const seq = ++loadSeq;
  const list = getWatchlist();
  const next = await Promise.all(list.map(code => analyze(code).then(d => ({ code, d }), () => ({ code, d: null }))));
  if (seq !== loadSeq) return; // 그사이 더 새로운 요청이 있었으면 버림
  results = next;
  for (const code of [...picked]) if (!list.includes(code)) picked.delete(code);
  render();
  if (currentView() === 'watch') loadTrends();
}

// 주가 온도·전일 대비: 아직 안 불러온 종목만 (서버가 종목 분석 때 받아 둔 시세를 다시 써요)
async function loadTrends() {
  const need = results.filter(r => r.d && !(r.code in trends)).map(r => r.code);
  if (!need.length) return;
  await Promise.all(need.map(code => api(`/api/technical?q=${encodeURIComponent(code)}`)
    .then(t => { trends[code] = t; }, () => { trends[code] = null; })));
  render();
}

function remove(code) {
  setWatchlist(getWatchlist().filter(c => c !== code));
  results = results.filter(r => r.code !== code);
  picked.delete(code);
  render();
}

// 내가 정한 순서에서 한 칸 위·아래로
function move(code, dir) {
  const list = [...getWatchlist()];
  const i = list.indexOf(code), j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  setWatchlist(list);
  results.sort((a, b) => list.indexOf(a.code) - list.indexOf(b.code));
  render();
}

function sorted() {
  const by = $('watchSort').value;
  const fit = r => r.d?.fit.total ?? -1;
  const name = r => r.d?.stock.name ?? r.code;
  if (by === 'high') return [...results].sort((a, b) => fit(b) - fit(a));
  if (by === 'low') return [...results].sort((a, b) => (a.d ? fit(a) : 999) - (b.d ? fit(b) : 999));
  if (by === 'name') return [...results].sort((a, b) => name(a).localeCompare(name(b), 'ko'));
  return results;
}

function render() {
  const ok = results.filter(r => r.d);
  if (!results.length) {
    $('watchSummary').textContent = '종목 분석 화면에서 ☆ 관심종목을 누르면, 내 성향과 얼마나 맞는지 한 번에 비교해볼 수 있어요.';
  } else if (!ok.length) {
    $('watchSummary').textContent = '관심종목을 불러오지 못했어요.';
  } else {
    const avg = Math.round(ok.reduce((a, r) => a + r.d.fit.total, 0) / ok.length);
    $('watchSummary').innerHTML = `관심종목 ${ok.length}개 · 평균 적합도 <strong>${avg}점</strong>`;
  }
  $('watchTable').hidden = !results.length;
  $('watchSortBox').hidden = results.length < 2;

  const mine = $('watchSort').value === 'mine';
  const list = sorted();
  $('watchList').innerHTML = list.map((r, i) => row(r, mine, i, list.length)).join('');
  renderDiagnosis(ok);
  updateCompare();
}

function row(r, mine, i, n) {
  const code = esc(r.code);
  const moves = mine ? `
      <button type="button" class="icon-btn" data-move="${code}" data-dir="-1" aria-label="위로" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="icon-btn" data-move="${code}" data-dir="1" aria-label="아래로" ${i === n - 1 ? 'disabled' : ''}>↓</button>` : '';
  const actions = `<span class="w-actions">${moves}
      <button type="button" class="icon-btn del" data-remove="${code}" aria-label="관심종목에서 빼기" title="관심종목에서 빼기">✕</button></span>`;
  if (!r.d) {
    return `<li class="wrow failed"><span class="w-name"><strong>${code}</strong><span class="meta">불러오지 못했어요</span></span>
      <span></span><span></span><span></span><span></span>${actions}</li>`;
  }
  const d = r.d;
  const name = esc(d.stock.name);
  const parts = Object.fromEntries(d.fit.parts.map(p => [p.key, p]));
  // 초보자: 강점·약점 한 줄 / 전문가: 기준 6개 작은 막대
  const strong = ORDER.filter(k => parts[k]?.score >= 60).sort((a, b) => parts[b].score - parts[a].score).slice(0, 2);
  const weak = ORDER.filter(k => parts[k]?.score != null && parts[k].score < 40).sort((a, b) => parts[a].score - parts[b].score).slice(0, 2);
  const easy = [strong.length ? `강점: ${strong.map(k => parts[k].label).join(', ')}` : null,
                weak.length ? `약점: ${weak.map(k => parts[k].label).join(', ')}` : null].filter(Boolean).join(' · ') || '뚜렷한 강점·약점이 없어요';
  const bars = ORDER.map(k => {
    const s = parts[k]?.score;
    const level = s == null ? 'none' : s >= 60 ? 'good' : s >= 40 ? 'mid' : 'bad';
    return `<span class="mini ${level}" title="${esc(parts[k]?.label ?? k)} ${s == null ? '정보 없음' : `${Math.round(s)}점`}">
      <i><b style="height:${s == null ? 0 : Math.max(6, Math.round(s))}%"></b></i><small>${SHORT[k]}</small></span>`;
  }).join('');

  const t = trends[r.code];
  const temp = t ? `<span class="sig ${TEMP_SIG[t.temperature.level]}">${esc(t.temperature.label)} ${t.temperature.score}</span>`
    : `<span class="sig none">${r.code in trends ? '-' : '…'}</span>`;
  const ch = t?.change;
  const change = ch == null ? '<span class="chg">-</span>'
    : `<span class="chg ${ch > 0 ? 'up' : ch < 0 ? 'down' : ''}">${ch > 0 ? '▲' : ch < 0 ? '▼' : ''}${Math.abs(ch).toFixed(2)}%</span>`;

  return `
    <li class="wrow">
      <span class="w-name">
        <input type="checkbox" data-pick="${code}" aria-label="${name} 비교에 넣기" ${picked.has(r.code) ? 'checked' : ''} />
        <span><button type="button" class="w-link" data-code="${code}" data-name="${name}">${name}</button>
        <span class="meta">${esc([d.stock.code, d.stock.sector].filter(Boolean).join(' · '))}</span></span>
      </span>
      <span class="w-fit ${d.fit.total < 50 ? 'low' : ''}" data-label="적합도">${d.fit.total}점</span>
      <span class="w-crit"><span class="beginner-only w-easy">${esc(easy)}</span><span class="expert-only minis">${bars}</span></span>
      <span class="w-temp" data-label="주가 온도">${temp}</span>
      <span class="w-chg" data-label="전일 대비">${change}</span>
      ${actions}
    </li>`;
}

// 관심종목 구성 진단: 관심종목 전체를 보고 쉬운 말로 (정보 제공용)
function renderDiagnosis(ok) {
  $('watchDiag').hidden = ok.length < 2;
  if (ok.length < 2) return;
  const lines = [];
  const names = rs => rs.map(r => r.d.stock.name).join(', ');

  // 1) 업종 쏠림
  const bySector = {};
  for (const r of ok) if (r.d.stock.sector) (bySector[r.d.stock.sector] ??= []).push(r);
  const [topSector, topList = []] = Object.entries(bySector).sort((a, b) => b[1].length - a[1].length)[0] ?? [];
  if (topList.length >= 2 && topList.length / ok.length >= 0.5) {
    lines.push(['warn', `<strong>${esc(topSector)}</strong> 업종이 ${ok.length}개 중 ${topList.length}개예요. 한 업종에 몰려 있으면 그 업종이 어려울 때 함께 흔들릴 수 있어요.`]);
  } else if (Object.keys(bySector).length >= 3) {
    lines.push(['ok', `${Object.keys(bySector).length}개 업종에 나뉘어 있어요.`]);
  }

  // 2) 기준별 강점·약점 (관심종목 평균)
  const avg = Object.fromEntries(ORDER.map(k => {
    const s = ok.map(r => r.d.fit.parts.find(p => p.key === k)?.score).filter(v => v != null);
    return [k, s.length ? s.reduce((a, b) => a + b, 0) / s.length : null];
  }));
  const label = k => ok[0].d.fit.parts.find(p => p.key === k)?.label ?? k;
  const strong = ORDER.filter(k => avg[k] >= 60).map(label), weak = ORDER.filter(k => avg[k] != null && avg[k] < 40).map(label);
  if (strong.length || weak.length) {
    lines.push(['info', `관심종목 전체로 보면 ${[strong.length ? `강한 기준은 <strong>${esc(strong.join(', '))}</strong>` : '',
      weak.length ? `약한 기준은 <strong>${esc(weak.join(', '))}</strong>` : ''].filter(Boolean).join(', ')}이에요.`]);
  }

  // 3) 내 성향보다 주가 위험이 큰 종목
  const risky = ok.filter(r => r.d.fit.risk?.excess > 0);
  const who = getProfile() ? `내 성향(${esc(ok[0].d.profile.riskLevel)})` : `기본 기준(${esc(ok[0].d.profile.riskLevel)})`;
  if (risky.length) lines.push(['warn', `${who}보다 주가 위험이 큰 종목이 ${risky.length}개예요: ${esc(names(risky))}`]);

  // 4) 주가 온도
  const hot = ok.filter(r => trends[r.code]?.temperature.level === 'hot');
  const cold = ok.filter(r => trends[r.code]?.temperature.level === 'cold');
  if (hot.length || cold.length) {
    lines.push(['info', [hot.length ? `최근 과열된 종목 ${hot.length}개(${esc(names(hot))})` : '',
      cold.length ? `침체된 종목 ${cold.length}개(${esc(names(cold))})` : ''].filter(Boolean).join(', ') + '가 있어요. 짧은 기간의 주가 움직임이라 참고만 하세요.']);
  }

  // 5) 배당
  const withDiv = ok.filter(r => r.d.fit.parts.find(p => p.key === 'dividend')?.score != null);
  if (withDiv.length) {
    const good = withDiv.filter(r => r.d.fit.parts.find(p => p.key === 'dividend').score >= 60);
    lines.push([good.length ? 'ok' : 'info', good.length
      ? `배당 점수가 좋은(60점 이상) 종목은 ${good.length}개예요: ${esc(names(good))}`
      : '배당 점수가 좋은(60점 이상) 종목이 없어요. 배당을 기대한다면 참고하세요.']);
  }

  // 6) 내 기준과 잘 맞지 않는 종목
  const low = ok.filter(r => r.d.fit.total < 50);
  if (low.length) lines.push(['warn', `내 기준과 잘 맞지 않는(적합도 50점 미만) 종목: ${esc(names(low))}`]);
  else lines.push(['ok', '모든 종목이 내 기준과 어느 정도 맞아요(적합도 50점 이상).']);

  $('watchDiagList').innerHTML = lines.map(([kind, text]) => `<li class="${kind}">${text}</li>`).join('');
}

function updateCompare() {
  $('watchCompareBar').hidden = watchStocks().length < 2;
  const n = picked.size;
  $('watchCompareBtn').disabled = n !== 2;
  $('watchCompareNote').textContent = n === 2 ? '두 종목을 골랐어요.' : n > 2 ? '두 종목만 골라주세요.' : '두 종목을 고르면 나란히 비교할 수 있어요.';
}

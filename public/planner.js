// 투자 플래너 화면 (#planner): 종목·금액·나누는 방식 입력 → 예시 구성, 위험 점검, 과거 시뮬레이션 그래프
// 계산은 서버(src/planner.js)가 하고, 여기서는 입력과 그리기만 해요. 입력값은 이 기기에만 저장해요.
// app.js가 initPlanner({ $, esc, show, api, store, getProfile, getWatchStocks })로 필요한 도구를 넘겨줘요.
import { onShowView } from './views.js';

let $, esc, show, api, store, getProfile, getWatchStocks;
let state = { amount: 5_000_000, method: 'equal', period: '1y', buy: 'lump', stocks: [] }; // stocks: [{ code, name, custom }]
let plan = null; // 마지막 점검 결과
const KEY = 'stockfit.plan';
const MAX = 10;

const won = v => (v == null ? '-' : `${Math.round(v).toLocaleString()}원`);
const man = v => (Math.abs(v) >= 10_000 ? `${(v / 10_000).toLocaleString(undefined, { maximumFractionDigits: 0 })}만 원` : won(v));
const pct = (v, sign = true) => (v == null ? '-' : `${sign && v > 0 ? '+' : ''}${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`);
const day = d => `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}`;
const chg = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');

export function initPlanner(deps) {
  ({ $, esc, show, api, store, getProfile, getWatchStocks } = deps);
  state = { ...state, ...store.get(KEY, {}) };
  onShowView('planner', () => { renderWatchChips(); if (plan) drawChart(); });

  $('planAmount').value = state.amount.toLocaleString();
  $('planAmount').addEventListener('input', () => {
    const n = Number($('planAmount').value.replace(/[^\d]/g, ''));
    state.amount = n; $('planAmount').value = n ? n.toLocaleString() : ''; save();
  });
  $('planAmountChips').addEventListener('click', e => {
    const b = e.target.closest('[data-amount]');
    if (b) { state.amount = Number(b.dataset.amount); $('planAmount').value = state.amount.toLocaleString(); save(); }
  });
  bindChoice('planMethod', 'method', () => renderStocks());
  bindChoice('planPeriod', 'period');
  bindChoice('planBuy', 'buy');

  $('planAdd').addEventListener('click', () => addByQuery($('planQ').value));
  $('planQ').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addByQuery($('planQ').value); } });
  $('planWatchChips').addEventListener('click', e => {
    const b = e.target.closest('[data-code]');
    if (b) toggle(b.dataset.code, b.dataset.name);
  });
  $('planStocks').addEventListener('click', e => { const b = e.target.closest('[data-remove]'); if (b) toggle(b.dataset.remove); });
  $('planStocks').addEventListener('input', e => {
    const i = e.target.closest('[data-custom]');
    if (i) { state.stocks.find(s => s.code === i.dataset.custom).custom = Number(i.value) || 0; save(); updateCustomSum(); }
  });
  $('planForm').addEventListener('submit', e => { e.preventDefault(); run(); });
  $('planLines').addEventListener('change', drawChart);
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => plan && drawChart(), 150); });
  renderStocks();
}

// 성향이 바뀌면 같은 입력으로 다시 점검 (적합도·손실 감내가 달라짐)
export function refreshPlanner() { if (plan) run(); }

function save() { store.set(KEY, state); }

// 칩 묶음 하나 = 선택지 하나 (aria-pressed)
function bindChoice(id, key, after) {
  const box = $(id);
  const sync = () => box.querySelectorAll('[data-value]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === state[key])));
  box.addEventListener('click', e => {
    const b = e.target.closest('[data-value]');
    if (!b) return;
    state[key] = b.dataset.value; save(); sync(); after?.();
  });
  sync();
}

async function addByQuery(q) {
  if (!q?.trim()) return;
  try {
    const [s] = await api(`/api/search?q=${encodeURIComponent(q.trim())}`);
    if (!s) return show($('planError'), '찾을 수 없는 종목이에요.');
    if (!state.stocks.some(x => x.code === s.code)) toggle(s.code, s.name);
    $('planQ').value = '';
  } catch (e) { show($('planError'), e.message); }
}

function toggle(code, name) {
  show($('planError'), '');
  if (state.stocks.some(s => s.code === code)) state.stocks = state.stocks.filter(s => s.code !== code);
  else if (state.stocks.length >= MAX) return show($('planError'), `종목은 ${MAX}개까지 고를 수 있어요.`);
  else state.stocks.push({ code, name, custom: 0 });
  save(); renderStocks(); renderWatchChips();
}

// 관심종목을 다 불러온 뒤에도 다시 그림 (app.js가 호출)
export function renderWatchChips() {
  const list = getWatchStocks();
  $('planWatch').hidden = !list.length;
  $('planWatchChips').innerHTML = list.map(s => `<button type="button" data-code="${esc(s.code)}" data-name="${esc(s.name)}"
    aria-pressed="${state.stocks.some(x => x.code === s.code)}"><strong>${esc(s.name)}</strong></button>`).join('');
}

function renderStocks() {
  const custom = state.method === 'custom';
  $('planStocks').innerHTML = state.stocks.length ? state.stocks.map(s => `
    <li><span><strong>${esc(s.name)}</strong> <span class="meta">${esc(s.code)}</span></span>
      ${custom ? `<label class="plan-pct"><input type="number" min="0" max="100" step="1" data-custom="${esc(s.code)}" value="${s.custom || ''}" aria-label="${esc(s.name)} 비중" />%</label>` : ''}
      <button type="button" class="icon-btn del" data-remove="${esc(s.code)}" aria-label="${esc(s.name)} 빼기">✕</button></li>`).join('')
    : '<li class="plan-none">관심종목 버튼이나 검색으로 종목을 2개 이상 담아주세요.</li>';
  $('planCustomSum').hidden = !custom || !state.stocks.length;
  updateCustomSum();
}
function updateCustomSum() {
  const total = state.stocks.reduce((a, s) => a + (s.custom || 0), 0);
  $('planCustomSum').textContent = `합계 ${total}% ${total === 100 ? '' : '(100%가 아니어도 비율대로 나눠요)'}`;
}

async function run() {
  show($('planError'), '');
  if (state.stocks.length < 2) return show($('planError'), '종목을 2개 이상 골라주세요.');
  if (!(state.amount >= 100_000)) return show($('planError'), '투자금은 10만 원 이상 넣어주세요.');
  $('planSubmit').disabled = true;
  $('planSubmit').textContent = '점검하는 중…';
  try {
    plan = await api('/api/plan', { method: 'POST', body: {
      codes: state.stocks.map(s => s.code), amount: state.amount, method: state.method, period: state.period, buy: state.buy,
      custom: state.stocks.map(s => s.custom || 0), profile: getProfile(),
    } });
    render();
  } catch (e) { show($('planError'), e.message); }
  finally { $('planSubmit').disabled = false; $('planSubmit').textContent = '점검하기'; }
}

function render() {
  const p = plan, port = p.portfolio, sim = p.sim;
  $('planEmpty').hidden = true;
  $('planResult').hidden = false;

  // 1) 예시 구성
  $('planCompNote').textContent = `"${p.methodLabel}" 방식으로 나눈 예시예요 · ${day(p.asOf)} 종가 기준이라 실제로 살 때 가격과 다를 수 있어요`;
  const top = port.sectors[0];
  $('planTiles').innerHTML = [
    ['구성 적합도', port.fit == null ? '-' : `${port.fit}점`, p.profileSet ? '내 성향 기준, 금액 비중으로 평균' : '기본 기준 (설문을 하면 내 성향으로)'],
    ['실제로 사는 금액', man(p.spent), `남는 돈 ${won(p.cash)}`],
    ['가장 큰 업종', top ? `${top.pct}%` : '-', top ? top.name : ''],
  ].map(([k, v, s]) => `<div class="plan-tile"><span>${k}</span><strong>${esc(v)}</strong><small>${esc(s)}</small></div>`).join('');
  $('planItems').innerHTML = p.items.map(it => `<tr>
      <td><strong>${esc(it.name)}</strong><span class="meta">${esc(it.sector || '')}</span></td>
      <td class="num">${it.weight}%</td><td class="num">${won(it.target)}</td>
      <td class="num">${won(it.close)}</td><td class="num">${it.shares.toLocaleString()}주</td><td class="num">${won(it.cost)}</td>
      <td class="num">${it.fit ?? '-'}점</td></tr>`).join('');
  const zero = p.items.filter(i => i.shares === 0).map(i => i.name);
  show($('planSectorNote'), [
    top && top.pct >= 60 && port.sectors.length > 1 ? `${top.name} 업종에 ${top.pct}%가 몰려 있어요. 그 업종이 어려울 때 함께 흔들릴 수 있어요.` : '',
    top && port.sectors.length === 1 ? `모든 종목이 ${top.name} 업종이에요. 업종이 하나라 함께 흔들리기 쉬워요.` : '',
    zero.length ? `${zero.join(', ')}은(는) 1주 가격이 배정 금액보다 비싸서 살 수 없어요. 투자금을 늘리거나 비중을 바꿔보세요.` : '',
  ].filter(Boolean).join(' '));

  // 2) 위험 점검: 숫자 + 쉬운 문장, 설문 손실 감내와 비교
  $('planRiskTiles').innerHTML = [
    ['1년 변동성', `±${port.vol}%`, `종목 평균 ±${port.avgVol}%`],
    ['나쁜 날 하루 손실', won(port.badDayWon), `${pct(port.badDayPct)} (100일 중 2~3일 정도)`],
    ['원금 대비 최대 손실', sim.worstPct < 0 ? pct(sim.worstPct) : '없음', `과거 ${p.period === '3y' ? '3년' : '1년'} 시뮬레이션`],
  ].map(([k, v, s]) => `<div class="plan-tile"><span>${k}</span><strong>${esc(v)}</strong><small>${esc(s)}</small></div>`).join('');
  const easy = [];
  easy.push(`이 구성은 1년 동안 보통 <strong>±${port.vol}%</strong> 정도 오르내렸어요.`
    + (port.vol < port.avgVol * 0.9 ? ` 종목 하나씩(평균 ±${port.avgVol}%)보다 작은데, 서로 다르게 움직이는 종목을 섞은 효과예요.` : ''));
  easy.push(`주가가 나쁜 날(100일 중 2~3일)에는 하루에 약 <strong>${esc(won(Math.abs(port.badDayWon)))}</strong>을 잃을 수 있었어요.`);
  const worst = (sim.worstPct < 0 ? `원금 대비 가장 크게 잃었을 때는 <strong>${pct(sim.worstPct)}</strong>(${day(sim.worstDate)})였어요.` : '시뮬레이션 기간 동안 원금 아래로 내려간 적이 없었어요.')
    // 원금보다 위에 있어도 고점에서 크게 떨어졌다면 함께 알려줌 (원금 기준만 보면 위험이 작아 보일 수 있어서)
    + (sim.peakDrawdownPct < sim.worstPct - 5 ? ` 다만 가장 높았던 때와 비교하면 <strong>${pct(sim.peakDrawdownPct)}</strong>(${day(sim.peakDrawdownDate)})까지 떨어진 적이 있어요.` : '');
  let verdict = 'none';
  if (!p.profileSet) easy.push(`${worst} 투자성향 설문을 하면 내가 견딜 수 있는 손실과 비교해 드려요.`);
  else if (p.lossLimit == null) easy.push(`${worst} 설문에서 큰 손실도 감수한다고 하셨어요.`);
  else if (p.lossLimit === 0) {
    easy.push(`설문에서 <strong>원금 손실은 싫다</strong>고 하셨어요. ${worst} 주식은 원금 아래로 내려갈 수 있는 상품이에요.`);
    verdict = sim.worstPct < 0 ? 'over' : 'ok';
  } else {
    const over = sim.worstPct < -p.lossLimit;
    verdict = over ? 'over' : 'ok';
    easy.push(`설문에서 <strong>${p.lossLimit}% 손실까지</strong> 괜찮다고 하셨어요. ${worst} `
      + (over ? `견딜 수 있다고 한 선보다 더 내려갔고, 그 아래에 있었던 날이 <strong>${sim.daysBelowLimit}일</strong>이에요. 생각보다 크게 흔들릴 수 있어요.`
        : '견딜 수 있다고 한 선 안에 있었어요.'));
  }
  $('planRiskEasy').className = `plan-easy ${verdict}`;
  $('planRiskEasy').innerHTML = easy.map(t => `<li>${t}</li>`).join('');

  // 3) 과거 시뮬레이션
  $('planSimNote').textContent = `${day(sim.from)} ~ ${day(sim.to)} · ${p.buy === 'monthly' ? '매달 첫 거래일에 나눠 사기' : '첫날 한 번에 사기'}`
    + (sim.shortened ? ' · 고른 종목이 함께 거래된 기간이 짧아서 기간을 줄였어요' : '');
  $('planSimStats').innerHTML = [
    ['이 구성', pct(sim.returnPct), `${man(sim.invested)} → ${man(sim.value)}`, chg(sim.returnPct)],
    ['원금 대비 최저', sim.worstPct < 0 ? pct(sim.worstPct) : '없음',
      sim.worstPct < 0 ? (sim.stillBelow ? '아직 원금을 회복하지 못했어요' : `${sim.recoveredDays}거래일 만에 원금 회복`) : '원금 아래로 내려간 적 없음', sim.worstPct < 0 ? 'down' : ''],
    ['고점 대비 최대 하락', pct(sim.peakDrawdownPct), sim.peakDrawdownDate ? `${day(sim.peakDrawdownDate)} 무렵` : '', sim.peakDrawdownPct < 0 ? 'down' : ''],
    ['똑같이 나눴다면', pct(sim.equalReturnPct), '같은 종목·같은 날 산 경우', chg(sim.equalReturnPct)],
    ['국고채 금리라면', sim.bondReturnPct == null ? '-' : pct(sim.bondReturnPct), p.bond3y == null ? '금리 키가 없어 생략' : `연 ${p.bond3y}%로 계산`, ''],
  ].map(([k, v, s, c]) => `<div class="plan-tile"><span>${k}</span><strong class="chg ${c}">${esc(v)}</strong><small>${esc(s)}</small></div>`).join('');
  const maxAbs = Math.max(1, ...sim.contributions.map(c => Math.abs(c.pl)));
  $('planContrib').innerHTML = sim.contributions.map(c => `<li><span>${esc(c.name)}</span>
    <i class="bar ${c.pl < 0 ? 'neg' : 'pos'}"><b style="width:${Math.max(2, Math.round(Math.abs(c.pl) / maxAbs * 100))}%"></b></i>
    <em class="chg ${chg(c.pl)}">${c.pl > 0 ? '+' : ''}${won(c.pl)}</em></li>`).join('');
  drawChart();

  // 4) 매달 나눠 사기 계획표
  $('planDca').hidden = p.buy !== 'monthly';
  if (p.buy === 'monthly') {
    const months = p.period === '3y' ? 36 : 12;
    const per = p.amount / months;
    $('planDcaNote').textContent = `${man(p.amount)}을 ${months}개월 동안 나누면 매달 약 ${man(per)}이에요. 지금 종가로 계산한 대략적인 금액이에요.`;
    $('planDcaItems').innerHTML = p.items.map(it => {
      const m = per * it.weight / 100;
      return `<tr><td>${esc(it.name)}</td><td class="num">${won(m)}</td><td class="num">${(m / it.close).toFixed(1)}주</td></tr>`;
    }).join('');
  }
}

// 그래프: 평가 금액, 넣은 돈, 손실 감내선 (+ 비교선). 라이브러리 없이 SVG로 그림
function drawChart() {
  const box = $('planChart');
  if (!plan || !box.clientWidth) return;
  const pts = plan.sim.chart;
  const showEq = $('planLineEq').checked, showBond = $('planLineBond').checked && pts[0].bond != null;
  const limit = plan.profileSet && plan.lossLimit > 0 ? plan.lossLimit : null; // 0%(원금 손실 싫음)는 넣은 돈 선과 같음
  const lineOf = p => (limit == null ? null : p.inv * (1 - limit / 100));
  const W = box.clientWidth, H = 280, pad = { l: 8, r: 70, t: 14, b: 26 };
  const vals = pts.flatMap(p => [p.v, p.inv, showEq ? p.eq : null, showBond ? p.bond : null, lineOf(p)]).filter(v => v != null);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) { lo *= 0.95; hi *= 1.05; }
  const x = i => pad.l + (i / Math.max(1, pts.length - 1)) * (W - pad.l - pad.r);
  const y = v => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const path = get => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(get(p)).toFixed(1)}`).join('');
  const ticks = [0, 1, 2, 3].map(k => lo + ((hi - lo) * k) / 3);
  const dates = [0, Math.floor((pts.length - 1) / 2), pts.length - 1];
  const wi = pts.findIndex(p => p.d >= (plan.sim.worstDate ?? '99999999'));
  box.innerHTML = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="과거 시뮬레이션 그래프">
      ${ticks.map(v => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>
        <text class="axis" x="${W - pad.r + 6}" y="${y(v) + 4}">${man(v)}</text>`).join('')}
      ${dates.map((i, k) => `<text class="axis" x="${x(i)}" y="${H - 6}" text-anchor="${['start', 'middle', 'end'][k]}">${day(pts[i].d)}</text>`).join('')}
      ${limit == null ? '' : `<path class="ln limit" d="${path(lineOf)}"/>`}
      <path class="ln inv" d="${path(p => p.inv)}"/>
      ${showBond ? `<path class="ln bond" d="${path(p => p.bond)}"/>` : ''}
      ${showEq ? `<path class="ln eq" d="${path(p => p.eq)}"/>` : ''}
      <path class="ln val" d="${path(p => p.v)}"/>
      ${wi > 0 && plan.sim.worstPct < 0 ? `<circle class="worst" cx="${x(wi)}" cy="${y(pts[wi].v)}" r="4"/>
        <text class="axis worst-t" x="${Math.min(x(wi) + 8, W - pad.r - 90)}" y="${y(pts[wi].v) + 16}">최저 ${pct(plan.sim.worstPct)}</text>` : ''}
      <line id="planCursor" class="cursor" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>
    </svg>
    <div id="planTip" class="chart-tip" hidden></div>`;
  const svg = box.querySelector('svg'), tip = $('planTip'), cursor = $('planCursor');
  const hide = () => { tip.hidden = true; cursor.setAttribute('visibility', 'hidden'); };
  svg.addEventListener('pointermove', e => {
    const rect = svg.getBoundingClientRect();
    const i = Math.min(pts.length - 1, Math.max(0, Math.round(((e.clientX - rect.left - pad.l) / (W - pad.l - pad.r)) * (pts.length - 1))));
    const p = pts[i], px = x(i);
    cursor.setAttribute('x1', px); cursor.setAttribute('x2', px); cursor.setAttribute('visibility', 'visible');
    tip.innerHTML = `<strong>${day(p.d)}</strong><span>평가 금액 ${won(p.v)}</span><span>넣은 돈 ${won(p.inv)}</span>`
      + `<span>손익 ${pct((p.v / p.inv - 1) * 100)}</span>` + (showEq ? `<span>똑같이 나눴다면 ${won(p.eq)}</span>` : '');
    tip.hidden = false;
    tip.style.left = `${Math.min(px + 12, W - tip.offsetWidth - 4)}px`;
  });
  svg.addEventListener('pointerleave', hide);
  $('planLimitLegend').hidden = limit == null;
  if (limit != null) $('planLimitLegend').textContent = `내가 견딜 수 있는 선 (원금 −${limit}%)`;
}

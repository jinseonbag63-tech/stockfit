// 주가 흐름 화면 (#trend): 주가 온도(과열·침체), 주가 흐름(상승·하락), 그래프, 지표 표
// 계산은 서버(src/technical.js)가 하고, 여기서는 그리기만 해요.
// app.js가 initTrend({ $, esc, show, api, onAnalyze })로 필요한 도구를 넘겨줘요.

let $, esc, show, api, onAnalyze;
let data = null;   // 마지막으로 불러온 결과
let range = 120;   // 그래프 기간 (거래일)

const SIGNAL = { hot: '과열', cold: '침체', up: '상승 신호', down: '하락 신호', neutral: '중립' };
const won = v => (v == null ? '-' : `${Math.round(v).toLocaleString()}원`);
// 주가 단위 값(1,000 이상)은 원 단위까지만, 지표 값은 소수 둘째 자리까지
const num = v => (v == null ? '-' : v.toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }));
const day = d => `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}`;
const badge = s => (s ? `<span class="sig ${s}">${SIGNAL[s]}</span>` : '<span class="sig none">-</span>');

// 화면 전환: 주소가 #trend면 주가 흐름 화면, 아니면 원래 화면
function syncView() {
  const trend = location.hash === '#trend';
  document.body.dataset.view = trend ? 'trend' : 'main';
  const active = trend ? '#trend' : location.hash === '#watch' ? '#watch' : '#analysis';
  document.querySelectorAll('.menu a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === active));
  if (trend) { window.scrollTo(0, 0); if (data) drawChart(); return; }
  // 숨겨져 있던 화면이라 브라우저가 스크롤하지 못했을 수 있어서 직접 이동
  const target = location.hash && document.getElementById(location.hash.slice(1));
  if (target) requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
}

export function initTrend(deps) {
  ({ $, esc, show, api, onAnalyze } = deps);
  window.addEventListener('hashchange', syncView);
  syncView();
  $('trendForm').addEventListener('submit', e => { e.preventDefault(); load($('trendQ').value); });
  $('trendAnalyze').addEventListener('click', () => data && onAnalyze(data.stock.code, data.stock.name));
  $('trendRange').addEventListener('click', e => {
    const b = e.target.closest('[data-range]');
    if (!b) return;
    range = Number(b.dataset.range);
    $('trendRange').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    drawChart();
  });
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => data && drawChart(), 150); });
}

// 종목 분석 화면의 "이 종목 주가 흐름 보기"에서 열 때
export function openTrend(code, name) {
  $('trendQ').value = name;
  location.hash = '#trend';
  load(code);
}

async function load(query) {
  if (!query?.trim()) return;
  show($('trendError'), '');
  try {
    render(await api(`/api/technical?q=${encodeURIComponent(query.trim())}`));
  } catch (e) { show($('trendError'), e.message); }
}

function render(d) {
  data = d;
  $('trendEmpty').hidden = true;
  $('trendResult').hidden = false;
  $('trendInitial').textContent = d.stock.name.charAt(0);
  $('trendName').textContent = d.stock.name;
  $('trendMeta').textContent = `${d.stock.code} · ${day(d.asOf)} 종가 기준`;
  $('trendClose').textContent = won(d.close);
  const ch = d.change;
  $('trendChange').className = ch > 0 ? 'chg up' : ch < 0 ? 'chg down' : 'chg';
  $('trendChange').textContent = ch == null ? '' : `${ch > 0 ? '▲' : ch < 0 ? '▼' : ''} ${Math.abs(ch).toFixed(2)}% (전 거래일 대비)`;

  // 주가 온도: 0(침체) ~ 100(과열) 막대 위 위치
  const t = d.temperature;
  $('tempLabel').textContent = `${t.label} · ${t.score}`;
  $('tempLabel').className = `tile-value temp-${t.level}`;
  $('tempMarker').style.left = `${Math.min(100, Math.max(0, t.score))}%`;
  $('tempText').textContent = t.text;

  const tr = d.trend;
  $('trendLabel').textContent = tr.label;
  $('trendCounts').textContent = `상승 신호 ${tr.up} · 하락 신호 ${tr.down} · 중립 ${tr.neutral}`;
  $('trendText').textContent = tr.text;

  renderEasy(d);
  renderTables(d);
  drawChart();

  $('trendFine').textContent = `과거 주가로 계산한 참고 정보예요. 앞으로의 주가를 알려주지 않고, 사라·팔라는 뜻도 아니에요. `
    + `시세는 실시간이 아니라 하루 늦게 반영돼요.${d.adjusted ? ' 액면분할 등으로 바뀐 이전 가격은 지금과 같은 기준으로 맞춰서 계산했어요.' : ''} 출처: ${d.source}`;
}

// 초보자 모드: 핵심만 쉬운 문장으로
function renderEasy(d) {
  const ind = Object.fromEntries(d.indicators.map(i => [i.key, i]));
  const ma = Object.fromEntries(d.movingAverages.map(m => [m.period, m]));
  const vsAvg = (m, label) => {
    if (m?.sma == null) return null;
    const pct = (d.close / m.sma - 1) * 100;
    return `${label} 평균 가격보다 <strong>${Math.abs(pct).toFixed(1)}% ${pct >= 0 ? '위' : '아래'}</strong>에 있어요.`;
  };
  const rsi = ind.rsi?.value;
  const items = [
    rsi == null ? null : `최근 14일 동안 오른 힘을 점수로 보면 <strong>${Math.round(rsi)}점</strong>이에요. (70점 이상 과열, 30점 이하 침체)`,
    vsAvg(ma[20], '최근 한 달(20일)'),
    vsAvg(ma[200], '최근 1년(200일)'),
    ind.atr?.value == null ? null : `하루에 보통 <strong>${won(ind.atr.value)}</strong> 정도 움직여요. 평소와 비교하면 ${ind.atr.level?.replace('변동성 ', '') ?? '보통'}이에요.`,
  ].filter(Boolean);
  $('trendEasy').innerHTML = items.map(t => `<li>${t}</li>`).join('');
}

// 전문가 모드: 지표 표와 이동평균 표
function renderTables(d) {
  const count = signals => {
    const c = {};
    for (const s of signals.filter(Boolean)) c[s] = (c[s] ?? 0) + 1;
    return ['up', 'down', 'hot', 'cold', 'neutral'].filter(k => c[k]).map(k => `${SIGNAL[k]} ${c[k]}`).join(' · ');
  };
  $('trendIndicators').innerHTML = d.indicators.map(i => `
    <tr>
      <td><strong>${esc(i.name)}</strong><span class="ind-about">${esc(i.about)}</span></td>
      <td class="num">${num(i.value)}</td>
      <td>${i.level ? `<span class="sig none">${esc(i.level)}</span>` : badge(i.signal)}</td>
    </tr>`).join('');
  $('indCounts').textContent = count(d.indicators.map(i => i.signal));
  $('trendMas').innerHTML = d.movingAverages.map(m => `
    <tr>
      <td><strong>${m.period}일</strong></td>
      <td class="num">${num(m.sma)} ${badge(m.smaSignal)}</td>
      <td class="num">${num(m.ema)} ${badge(m.emaSignal)}</td>
    </tr>`).join('');
  $('maCounts').textContent = count(d.movingAverages.flatMap(m => [m.smaSignal, m.emaSignal]));
}

// 그래프: 종가 + 20일·60일 이동평균 (라이브러리 없이 SVG로 그림)
function drawChart() {
  const box = $('trendChart');
  if (!data || !box.clientWidth) return;
  const pts = data.chart.slice(-range);
  const W = box.clientWidth, H = 260, pad = { l: 8, r: 64, t: 12, b: 26 };
  const vals = pts.flatMap(p => [p.c, p.ma20, p.ma60]).filter(v => v != null);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) { lo *= 0.95; hi *= 1.05; }
  const x = i => pad.l + (i / Math.max(1, pts.length - 1)) * (W - pad.l - pad.r);
  const y = v => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const line = key => {
    let path = '', on = false;
    pts.forEach((p, i) => {
      if (p[key] == null) { on = false; return; }
      path += `${on ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`;
      on = true;
    });
    return path;
  };
  // 가로 눈금 4줄, 날짜는 처음·가운데·끝
  const ticks = [0, 1, 2, 3].map(k => lo + ((hi - lo) * k) / 3);
  const dates = [0, Math.floor((pts.length - 1) / 2), pts.length - 1];
  box.innerHTML = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(data.stock.name)} 최근 주가와 이동평균선 그래프">
      ${ticks.map(v => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>
        <text class="axis" x="${W - pad.r + 6}" y="${y(v) + 4}">${Math.round(v).toLocaleString()}</text>`).join('')}
      ${dates.map((i, k) => `<text class="axis" x="${x(i)}" y="${H - 6}" text-anchor="${['start', 'middle', 'end'][k]}">${day(pts[i].d)}</text>`).join('')}
      <path class="ln ma60" d="${line('ma60')}"/>
      <path class="ln ma20" d="${line('ma20')}"/>
      <path class="ln close" d="${line('c')}"/>
      <line id="chartCursor" class="cursor" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>
    </svg>
    <div id="chartTip" class="chart-tip" hidden></div>`;

  // 마우스·손가락을 올리면 그날 값 표시
  const svg = box.querySelector('svg');
  const tip = $('chartTip'), cursor = $('chartCursor');
  const hide = () => { tip.hidden = true; cursor.setAttribute('visibility', 'hidden'); };
  svg.addEventListener('pointermove', e => {
    const rect = svg.getBoundingClientRect();
    const i = Math.round(((e.clientX - rect.left - pad.l) / (W - pad.l - pad.r)) * (pts.length - 1));
    const p = pts[Math.min(pts.length - 1, Math.max(0, i))];
    if (!p) return hide();
    const px = x(pts.indexOf(p));
    cursor.setAttribute('x1', px); cursor.setAttribute('x2', px); cursor.setAttribute('visibility', 'visible');
    tip.innerHTML = `<strong>${day(p.d)}</strong><span>종가 ${won(p.c)}</span>`
      + (p.ma20 != null ? `<span>20일 ${won(p.ma20)}</span>` : '') + (p.ma60 != null ? `<span>60일 ${won(p.ma60)}</span>` : '');
    tip.hidden = false;
    tip.style.left = `${Math.min(px + 12, W - tip.offsetWidth - 4)}px`;
  });
  svg.addEventListener('pointerleave', hide);
}

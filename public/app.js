// 화면 동작: 설문 → 분석 요청 → 결과 표시, 관심종목 관리
const $ = id => document.getElementById(id);
const COLORS = { stability: 'var(--c-stability)', profitability: 'var(--c-profitability)', growth: 'var(--c-growth)', dividend: 'var(--c-dividend)' };

const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};
let profile = store.get('stockfit.profile', null);
let watchlist = store.get('stockfit.watch', []);
let current = null;

async function analyze(query) {
  const params = new URLSearchParams({ q: query, ...(profile || {}) });
  const res = await fetch(`/api/analyze?${params}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '분석에 실패했어요.');
  return data;
}

function show(el, text) { el.textContent = text || ''; el.hidden = !text; }

function renderResult(d) {
  current = d;
  $('result').hidden = false;
  $('stockName').textContent = d.stock.name;
  $('stockMeta').textContent = [d.stock.code, d.stock.market, d.stock.sector].filter(Boolean).join(' | ');
  $('summary').textContent = d.summary;
  $('fitTotal').textContent = d.fit.total;
  $('fitVerdict').textContent = d.fit.verdict;
  $('fitProfile').textContent = profile
    ? `${d.profile.riskLevel} 기준으로 계산했어요`
    : '아직 성향을 정하지 않아서 기본 기준으로 계산했어요';

  // 막대: 기준별 기여 점수를 이어 붙인 길이 = 총점
  $('fitBar').innerHTML = d.fit.parts
    .map(p => `<span style="width:${p.contribution}%;background:${COLORS[p.key]}" title="${p.label} ${p.contribution.toFixed(1)}점"></span>`)
    .join('');
  $('fitBar').setAttribute('aria-label', d.fit.parts.map(p => `${p.label} ${p.contribution.toFixed(1)}점`).join(', '));

  $('fitParts').innerHTML = d.fit.parts.map(p => `
    <li>
      <span class="dot" style="background:${COLORS[p.key]}"></span>
      <span class="part-name">${p.label}</span>
      <span class="part-pts">+${p.contribution.toFixed(1)}점</span>
      <p class="part-detail">${p.score == null
        ? '데이터가 없어 계산에서 뺐어요'
        : `기준 점수 ${Math.round(p.score)}점 × 내 비중 ${Math.round(p.appliedWeight * 100)}%`}</p>
    </li>`).join('');

  $('indicators').innerHTML = d.indicators.map(i => `
    <li>
      <div class="ind-top"><span class="ind-name">${i.label}</span><span class="ind-value">${i.value}</span></div>
      <p class="ind-reading">${i.reading}</p>
      <p class="ind-meaning">${i.meaning}</p>
      ${i.forMe ? `<p class="ind-forme">${i.forMe}</p>` : ''}
    </li>`).join('');

  $('source').textContent = `데이터 출처: ${d.source}`;
  show($('notice'), d.notice);
  updateWatchBtn();
}

async function run(query) {
  show($('error'), '');
  try {
    renderResult(await analyze(query));
    $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { show($('error'), e.message); }
}

// 관심종목
function updateWatchBtn() {
  const on = current && watchlist.includes(current.stock.code);
  $('watchBtn').setAttribute('aria-pressed', String(!!on));
  $('watchBtn').textContent = on ? '관심종목에 담김' : '관심종목에 추가';
}

async function renderWatch() {
  if (!watchlist.length) {
    $('watchSummary').textContent = '분석한 종목을 관심종목에 담으면, 내 성향과 얼마나 맞는지 한 번에 비교해볼 수 있어요.';
    $('watchList').innerHTML = '';
    return;
  }
  const results = await Promise.all(watchlist.map(code => analyze(code).catch(() => null)));
  const ok = results.filter(Boolean);
  const avg = Math.round(ok.reduce((a, r) => a + r.fit.total, 0) / ok.length);
  const low = ok.filter(r => r.fit.total < 50).map(r => r.stock.name);
  $('watchSummary').innerHTML = `관심종목 평균 적합도 <strong>${avg}점</strong>.`
    + (low.length ? ` ${low.join(', ')}은(는) 내 기준과 잘 맞지 않아서 평균을 낮추고 있어요.` : ' 모두 내 기준과 어느 정도 맞아요.');
  $('watchList').innerHTML = ok.map(r => `
    <li>
      <button type="button" data-code="${r.stock.code}">${r.stock.name}</button>
      <span class="watch-score ${r.fit.total < 50 ? 'low' : ''}">${r.fit.total}점</span>
    </li>`).join('');
}

$('watchBtn').addEventListener('click', () => {
  if (!current) return;
  const code = current.stock.code;
  watchlist = watchlist.includes(code) ? watchlist.filter(c => c !== code) : [...watchlist, code];
  store.set('stockfit.watch', watchlist);
  updateWatchBtn();
  renderWatch();
});
$('watchList').addEventListener('click', e => { const c = e.target.dataset.code; if (c) run(c); });

// 검색
$('searchForm').addEventListener('submit', e => { e.preventDefault(); run($('q').value); });

// 설문
function openSurvey() {
  if (profile) for (const [k, v] of Object.entries(profile)) {
    const input = document.querySelector(`input[name="${k}"][value="${v}"]`);
    if (input) input.checked = true;
  }
  $('survey').showModal();
}
$('profileBtn').addEventListener('click', openSurvey);
$('surveyForm').addEventListener('submit', () => {
  const f = new FormData($('surveyForm'));
  profile = { q1: f.get('q1'), q2: f.get('q2'), q3: f.get('q3') };
  store.set('stockfit.profile', profile);
  $('profileBtn').textContent = '내 투자성향 바꾸기';
  if (current) run(current.stock.code);
  renderWatch();
});

// 검색 자동완성: 입력할 때마다 서버에서 후보 10개를 받아옴
let searchTimer;
$('q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('q').value.trim();
  if (!q) return;
  searchTimer = setTimeout(async () => {
    try {
      const list = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
      $('stockList').innerHTML = list.map(s => `<option value="${s.name}">${s.code}</option>`).join('');
    } catch {}
  }, 200);
});

// 시작
(async function init() {
  const { full, picks } = await (await fetch('/api/stocks')).json();
  $('q').placeholder = full ? '상장사 이름 또는 종목코드 (예: SK텔레콤, 005930)' : '종목명 또는 종목코드 (예: 삼성전자)';
  $('quickPicks').innerHTML = picks.map(s => `<button type="button" data-q="${s.code}">${s.name}</button>`).join('');
  $('quickPicks').addEventListener('click', e => { const q = e.target.dataset.q; if (q) { $('q').value = e.target.textContent; run(q); } });

  const { criteria } = await (await fetch('/api/criteria')).json();
  $('criteriaList').innerHTML = criteria.map(c => `<li><strong>${c.label}</strong>: ${c.rule}</li>`).join('');

  if (profile) $('profileBtn').textContent = '내 투자성향 바꾸기';
  else openSurvey();
  renderWatch();
})();

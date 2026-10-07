// 화면 동작: 설문 → 분석 요청 → 결과 표시, 관심종목 관리
const $ = id => document.getElementById(id);

const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};
let profile = store.get('stockfit.profile', null);
let watchlist = store.get('stockfit.watch', []);
let current = null;

// 기업 상태 카드 6개 (가격 수준·주가 흐름은 주가 데이터 연결 후 활성화)
const STATUS = [
  { key: 'stability', label: '안정성' },
  { key: 'profitability', label: '수익성' },
  { key: 'growth', label: '성장성' },
  { key: 'price', label: '가격 수준', soon: true },
  { key: 'dividend', label: '배당' },
  { key: 'trend', label: '주가 흐름', soon: true },
];
// 0~100점 → 쉬운 평가 + 막대 칸 수
function grade(score) {
  if (score == null) return { text: '정보 없음', level: 0 };
  if (score >= 80) return { text: '매우 좋음', level: 5 };
  if (score >= 60) return { text: '좋은 편', level: 4 };
  if (score >= 40) return { text: '보통', level: 3 };
  if (score >= 20) return { text: '주의 필요', level: 2 };
  return { text: '약한 편', level: 1 };
}
const bars = level => `<span class="bars">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= level ? 'on' : ''}"></i>`).join('')}</span>`;

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
  $('empty').hidden = true;
  $('result').hidden = false;
  $('stockInitial').textContent = d.stock.name.charAt(0);
  $('stockName').textContent = d.stock.name;
  $('stockMarket').textContent = d.stock.market || '';
  $('stockMeta').textContent = [d.stock.code, d.stock.sector].filter(Boolean).join(' · ');
  $('summary').textContent = d.summary;
  $('sourceTop').textContent = d.sample ? '화면의 수치는 예시 데이터예요' : `${d.source} 기준`;

  // 기업 상태 카드
  const partsByKey = Object.fromEntries(d.fit.parts.map(p => [p.key, p]));
  $('statusGrid').innerHTML = STATUS.map(s => {
    if (s.soon) {
      return `<button type="button" class="status g0" disabled><span class="status-name">${s.label}</span>
        <span class="status-grade">준비 중</span>${bars(0)}</button>`;
    }
    const g = grade(partsByKey[s.key]?.score);
    return `<button type="button" class="status g${g.level}" data-key="${s.key}" aria-expanded="false">
      <span class="status-name">${s.label}</span><span class="status-grade">${g.text}</span>${bars(g.level)}</button>`;
  }).join('');
  $('statusDetail').hidden = true;

  // 적합도 패널
  $('fitTotal').textContent = d.fit.total;
  requestAnimationFrame(() => { $('fitFill').style.width = `${d.fit.total}%`; });
  $('fitVerdict').textContent = d.fit.verdict;
  $('fitProfile').textContent = profile
    ? `${d.profile.riskLevel} 기준으로 계산했어요`
    : '아직 성향을 정하지 않아서 기본 기준으로 계산했어요';
  $('fitParts').innerHTML = [...d.fit.parts]
    .sort((a, b) => b.contribution - a.contribution)
    .map(p => `<li><span>${p.label}<span class="why">${p.score == null
      ? '데이터가 없어 계산에서 뺐어요'
      : `기준 점수 ${Math.round(p.score)}점 × 내 비중 ${Math.round(p.appliedWeight * 100)}%`}</span></span>
      <span class="pts">+${p.contribution.toFixed(1)}</span></li>`).join('');

  // 전문 지표
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

// 상태 카드를 누르면 그 기준에 해당하는 지표 설명을 보여줌
$('statusGrid').addEventListener('click', e => {
  const btn = e.target.closest('.status[data-key]');
  if (!btn || !current) return;
  const open = btn.getAttribute('aria-expanded') === 'true';
  document.querySelectorAll('.status[data-key]').forEach(b => b.setAttribute('aria-expanded', 'false'));
  if (open) { $('statusDetail').hidden = true; return; }
  btn.setAttribute('aria-expanded', 'true');
  const part = current.fit.parts.find(p => p.key === btn.dataset.key);
  const items = current.indicators.filter(i => i.criterion === btn.dataset.key);
  $('statusDetail').innerHTML = `<h5>${part.label}은 이렇게 봤어요</h5>` + items.map(i =>
    `<p><span class="num">${i.label} ${i.value}</span> — ${i.reading}</p><p class="ind-meaning">${i.meaning}</p>`).join('')
    + (part.score != null ? `<p class="ind-meaning">평가 기준: ${part.rule}</p>` : '');
  $('statusDetail').hidden = false;
});

async function run(query) {
  show($('error'), '');
  try {
    renderResult(await analyze(query));
    $('analysis').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { show($('error'), e.message); }
}

// 관심종목
function updateWatchBtn() {
  const on = current && watchlist.includes(current.stock.code);
  $('watchBtn').setAttribute('aria-pressed', String(!!on));
  $('watchBtn').textContent = on ? '★ 관심종목' : '☆ 관심종목';
}

async function renderWatch() {
  if (!watchlist.length) {
    $('watchSummary').textContent = '분석한 종목에서 ☆를 누르면, 내 성향과 얼마나 맞는지 한 번에 비교해볼 수 있어요.';
    $('watchList').innerHTML = '';
    return;
  }
  const results = await Promise.all(watchlist.map(code => analyze(code).catch(() => null)));
  const ok = results.filter(Boolean);
  if (!ok.length) { $('watchSummary').textContent = '관심종목을 불러오지 못했어요.'; return; }
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

// 설문
const RISK_NAME = { steady: 0, dividend: 1, growth: 2 };
function updateBadge() {
  if (!profile) { $('profileBadge').textContent = '성향 미설정'; return; }
  const risk = (RISK_NAME[profile.q1] ?? 0) + (profile.q2 === 'long' ? 1 : 0) + (profile.q3 === 'growth' ? 1 : 0);
  $('profileBadge').textContent = ['안정형', '안정추구형', '위험중립형', '적극투자형', '공격투자형'][risk];
}
function openSurvey() {
  if (profile) for (const [k, v] of Object.entries(profile)) {
    const input = document.querySelector(`input[name="${k}"][value="${v}"]`);
    if (input) input.checked = true;
  }
  $('survey').showModal();
}
$('navProfile').addEventListener('click', openSurvey);
$('resurvey').addEventListener('click', openSurvey);
$('surveyForm').addEventListener('submit', () => {
  const f = new FormData($('surveyForm'));
  profile = { q1: f.get('q1'), q2: f.get('q2'), q3: f.get('q3') };
  store.set('stockfit.profile', profile);
  updateBadge();
  if (current) run(current.stock.code);
  renderWatch();
});

// 시작
(async function init() {
  updateBadge();
  try {
    const { full, picks } = await (await fetch('/api/stocks')).json();
    if (full) $('q').placeholder = '궁금한 종목명 또는 종목코드 (예: SK텔레콤, 005930)';
    $('quickPicks').innerHTML = picks.map(s => `<button type="button" data-q="${s.code}">${s.name}</button>`).join('');
    $('quickPicks').addEventListener('click', e => { const q = e.target.dataset.q; if (q) { $('q').value = e.target.textContent; run(q); } });
    const { criteria } = await (await fetch('/api/criteria')).json();
    $('criteriaList').innerHTML = criteria.map(c => `<li><strong>${c.label}</strong>: ${c.rule}</li>`).join('');
  } catch (e) { show($('error'), '서버에 연결하지 못했어요. 잠시 후 새로고침해주세요.'); }
  if (!profile) openSurvey();
  renderWatch();
})();

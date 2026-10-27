// 화면 동작: 설문 → 분석 요청 → 결과 표시, 관심종목 관리
import { SURVEY, riskFromAnswers } from './survey.js';
import { initTrend, openTrend } from './technical.js';

const $ = id => document.getElementById(id);

const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};
let profile = store.get('stockfit.profile', null);
let watchlist = store.get('stockfit.watch', []);
let current = null;
let user = null; // 로그인한 회원 (없으면 이 기기에만 저장)
let mailEnabled = false; // 서버에 메일 설정이 있을 때만 이메일 인증·비밀번호 찾기를 보여줌

async function api(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {},
                                  body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '요청에 실패했어요.');
  return data;
}

// 성향·관심종목은 이 기기에 저장하고, 로그인 중이면 계정에도 저장
function syncAccount(patch) {
  if (user) api('/api/me', { method: 'PUT', body: patch })
    .catch(() => show($('error'), '계정에 저장하지 못했어요. 잠시 후 다시 시도해주세요.'));
}
function saveProfile() { store.set('stockfit.profile', profile); syncAccount({ profile }); }
function saveWatch() { store.set('stockfit.watch', watchlist); syncAccount({ watchlist }); }

// 초보자 / 전문가 모드: body의 data-mode로 .beginner-only / .expert-only 요소를 보이거나 숨김
// 직접 고른 적이 없으면 설문의 금융 지식 답(q6)으로 정함
const MODE_KEY = 'stockfit.mode';
const defaultMode = () => (['good', 'expert'].includes(profile?.q6) ? 'expert' : 'beginner');
let mode = store.get(MODE_KEY, null) ?? defaultMode();
function applyMode(next, remember = false) {
  mode = next;
  document.body.dataset.mode = next;
  document.querySelectorAll('#modeToggle [data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === next)));
  if (remember) store.set(MODE_KEY, next);
  // 펼친 설명은 모드마다 내용이 달라서 닫음
  document.querySelectorAll('.status[data-key]').forEach(b => b.setAttribute('aria-expanded', 'false'));
  $('statusDetail').hidden = true;
}
applyMode(mode);
$('modeToggle').addEventListener('click', e => {
  const b = e.target.closest('[data-mode]');
  if (b) applyMode(b.dataset.mode, true);
});

// 기업 상태 카드 6개 (가격 수준·주가 안정성은 시세 키가 있어야 계산)
const STATUS = ['stability', 'profitability', 'growth', 'valuation', 'dividend', 'volatility'];
const NEEDS_PRICE = ['valuation', 'volatility'];
// 점수가 없을 때 이유
function missingText(d, key) {
  if (NEEDS_PRICE.includes(key) && d.sources?.price === 'off') return '시세 키 필요';
  if (NEEDS_PRICE.includes(key) && d.sources?.price === 'error') return '불러오기 실패';
  return '정보 없음';
}
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
  $('statusGrid').innerHTML = STATUS.map(key => {
    const part = partsByKey[key];
    const g = grade(part?.score);
    const text = part?.score == null ? missingText(d, key) : g.text;
    return `<button type="button" class="status g${g.level}" data-key="${key}" aria-expanded="false">
      <span class="status-name">${part?.label ?? key}</span><span class="status-grade">${text}</span>${bars(g.level)}</button>`;
  }).join('');
  $('statusDetail').hidden = true;

  // 재무 체크리스트
  const cl = d.checklist;
  $('checklist').hidden = !cl?.total;
  if (cl?.total) {
    $('checklistScore').textContent = `${cl.total}개 중 ${cl.passed}개 통과`;
    $('checklistItems').innerHTML = cl.items.filter(i => i.pass != null).map(i =>
      `<li class="${i.pass ? 'pass' : 'fail'}"><span class="mark" aria-hidden="true">${i.pass ? '✓' : '✗'}</span>
        <span class="sr-only">${i.pass ? '통과' : '미통과'}</span>${esc(i.label)}</li>`).join('');
  }

  // 적합도 패널
  $('fitTotal').textContent = d.fit.total;
  requestAnimationFrame(() => { $('fitFill').style.width = `${d.fit.total}%`; });
  $('fitVerdict').textContent = d.fit.verdict;
  $('fitProfile').textContent = !profile ? '아직 성향을 정하지 않아서 기본 기준으로 계산했어요'
    : d.profile.complete ? `${d.profile.riskLevel} 기준으로 계산했어요`
    : `${d.profile.riskLevel}(3문항 간이 진단) 기준이에요. 아래 버튼으로 7문항에 답하면 더 정확해요`;
  show($('fitNotes'), d.profile.notes?.join(' '));
  show($('fitStockNotice'), d.profile.stockNotice); // 안정형·안정추구형: 주식 자체의 원금 손실 위험 안내
  $('fitGoods').innerHTML = d.easy.goods.map(t => `<li>${esc(t)}</li>`).join('');
  $('fitCautions').innerHTML = d.easy.cautions.map(t => `<li>${esc(t)}</li>`).join('');
  $('fitWarnings').hidden = !d.fit.warnings.length;
  $('fitWarnings').innerHTML = d.fit.warnings.map(w => `<li>${esc(w)}</li>`).join('');
  $('fitParts').innerHTML = [...d.fit.parts]
    .sort((a, b) => b.contribution - a.contribution)
    .map(p => `<li><span>${p.label}<span class="why">${p.score == null
      ? (missingText(d, p.key) === '시세 키 필요' ? '시세 키를 넣으면 계산해요' : '데이터가 없어 계산에서 뺐어요')
      : `기준 점수 ${Math.round(p.score)}점 × 내 비중 ${Math.round(p.appliedWeight * 100)}%`}</span></span>
      <span class="pts">+${p.contribution.toFixed(1)}</span></li>`).join('');
  const market = [];
  if (d.macro?.baseRate != null) market.push(`기준금리 ${d.macro.baseRate}%`);
  if (d.macro?.bond3y != null) market.push(`국고채 3년 ${d.macro.bond3y}%`);
  if (d.fit.risk) market.push(`주가 위험 ${d.fit.risk.grade}등급`);
  show($('fitMarket'), market.join(' · '));

  // 전문 지표
  $('indicators').innerHTML = d.indicators.map(i => `
    <li>
      <div class="ind-top"><span class="ind-name">${esc(i.label)}</span><span class="ind-value">${esc(i.value)}</span></div>
      <p class="ind-reading">${esc(i.reading)}</p>
      <p class="ind-meaning">${esc(i.meaning)}</p>
      ${i.basis ? `<p class="ind-basis">${esc(i.basis)}</p>` : ''}
      ${i.forMe ? `<p class="ind-forme">${esc(i.forMe)}</p>` : ''}
    </li>`).join('');
  const sources = [d.source];
  if (d.price) sources.push(`주가 ${d.price.asOf.replace(/(\d{4})(\d{2})(\d{2})/, '$1.$2.$3')} 기준 (금융위원회)`);
  if (d.macro) sources.push('금리 (한국은행)');
  $('source').textContent = `데이터 출처: ${sources.join(' · ')}`;

  show($('notice'), d.notice);
  updateWatchBtn();
  loadStockFeed(d.stock.code);
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
  const missing = part.score == null ? missingText(current, part.key) : null;
  // 초보자 모드: 점수 계산 기준(“200% 이상 0점…”)은 빼고, 업종 비교 문장만
  const basisOk = i => i.basis && (mode === 'expert' || !i.basis.startsWith('평가 기준'));
  const ask = chatEnabled
    ? `<button type="button" class="link-btn ask-ai" data-ask="${esc(`${current.stock.name}의 ${part.label}이 왜 '${btn.querySelector('.status-grade').textContent}'인지 쉽게 설명해줘`)}">이 부분 AI 도우미에게 물어보기</button>` : '';
  $('statusDetail').innerHTML = `<h5>${part.label}은 이렇게 봤어요</h5>`
    + (missing === '시세 키 필요' ? '<p>주가 데이터가 필요한 기준이에요. .env에 공공데이터포털 시세 키(DATA_GO_KR_KEY)를 넣으면 계산해요.</p>'
      : items.map(i => `<p><span class="num">${esc(i.label)} ${esc(i.value)}</span> — ${esc(i.reading)}</p>
        <p class="ind-meaning">${esc(i.meaning)}</p>${basisOk(i) ? `<p class="ind-basis">${esc(i.basis)}</p>` : ''}`).join(''))
    + ask;
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
  loadWatchFeed();
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
  saveWatch();
  updateWatchBtn();
  renderWatch();
});
$('watchList').addEventListener('click', e => { const c = e.target.dataset.code; if (c) run(c); });

// 뉴스·공시 (종목 화면 카드 + 관심종목 소식)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad2 = n => String(n).padStart(2, '0');
// 공시는 날짜만(YYYY-MM-DD), 뉴스는 시각까지 있음
const feedTime = i => new Date(i.date.length === 10 ? `${i.date}T00:00:00` : i.date).getTime();
const byNewest = (a, b) => feedTime(b) - feedTime(a);
function feedDate(item) {
  const d = new Date(feedTime(item));
  const now = new Date();
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return item.date.length === 10 ? '오늘' : `오늘 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (days === 1) return '어제';
  if (days < 7) return `${days}일 전`;
  if (d.getFullYear() !== now.getFullYear()) return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}
function feedItem(i, showStock) {
  const flag = i.level === 'warning' ? '<span class="feed-flag warn">주의</span>'
    : i.level === 'important' ? '<span class="feed-flag">중요</span>' : '';
  const detail = i.explain || i.summary;
  return `<li class="feed-item${i.level === 'warning' ? ' warn' : ''}">
    <div class="feed-meta">
      ${showStock ? `<span class="feed-stock">${esc(i.stockName)}</span>` : ''}
      <span class="feed-type ${i.type}">${i.type === 'news' ? '뉴스' : '공시'}</span>${flag}
      <span>${esc(i.source)}${i.source ? ' · ' : ''}${feedDate(i)}</span>
    </div>
    <a class="feed-title" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${esc(i.title)}</a>
    ${detail ? `<p class="feed-detail${i.explain ? ' explain' : ''}">${esc(detail)}</p>` : ''}
  </li>`;
}
function feedNotice(data, kinds) {
  const notes = [];
  if (kinds.includes('news') && !data.newsEnabled) notes.push('뉴스는 .env에 네이버 검색 API 키를 넣으면 볼 수 있어요.');
  if (kinds.includes('disclosure') && !data.disclosuresEnabled) notes.push('공시는 .env에 DART 키를 넣으면 볼 수 있어요.');
  if (data.partial) notes.push('일부 소식을 불러오지 못했어요. 잠시 후 다시 시도해주세요.');
  return notes.join(' ');
}
function pressChip(el, filter) {
  el.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
}
function bindChips(el, onPick) {
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    pressChip(el, b.dataset.filter);
    onPick(b.dataset.filter);
  });
}
const feedMessage = text => `<li class="feed-empty">${text}</li>`;

// 종목 화면: 최근 뉴스 5개 또는 공시 5개
let stockFeed = null;
let stockFeedFilter = 'news';
async function loadStockFeed(code) {
  stockFeed = null;
  $('stockFeedNote').hidden = true;
  $('stockFeed').innerHTML = feedMessage('소식을 불러오는 중이에요…');
  let data;
  try { data = await api(`/api/feed?codes=${encodeURIComponent(code)}`); }
  catch { data = { error: true }; }
  if (current?.stock.code !== code) return; // 그사이 다른 종목을 열었으면 버림
  stockFeed = data;
  // 뉴스 키가 없으면 공시 탭부터
  if (!data.error && !data.newsEnabled && data.disclosuresEnabled && stockFeedFilter === 'news') {
    stockFeedFilter = 'disclosure';
    pressChip($('stockFeedFilter'), stockFeedFilter);
  }
  renderStockFeed();
}
function renderStockFeed() {
  if (!stockFeed) return;
  if (stockFeed.error) { $('stockFeed').innerHTML = feedMessage('소식을 불러오지 못했어요.'); return; }
  const isNews = stockFeedFilter === 'news';
  const enabled = isNews ? stockFeed.newsEnabled : stockFeed.disclosuresEnabled;
  const items = (isNews ? stockFeed.news : stockFeed.disclosures).slice(0, 5);
  show($('stockFeedNote'), feedNotice(stockFeed, [stockFeedFilter]));
  $('stockFeed').innerHTML = items.length ? items.map(i => feedItem(i, false)).join('')
    : enabled ? feedMessage(isNews ? '최근 뉴스가 없어요.' : '최근 3개월 동안 공시가 없어요.') : '';
}
bindChips($('stockFeedFilter'), f => { stockFeedFilter = f; renderStockFeed(); });

// 관심종목 소식: 찜한 종목 전체의 뉴스·공시를 최신순으로
const WATCH_PAGE = 15;
let watchFeed = null;
let watchFeedFilter = 'all';
let watchFeedLimit = WATCH_PAGE;
async function loadWatchFeed() {
  $('watchFeedCard').hidden = !watchlist.length;
  if (!watchlist.length) return;
  const codes = watchlist.join(',');
  if (!watchFeed) $('watchFeed').innerHTML = feedMessage('소식을 불러오는 중이에요…');
  let data;
  try { data = await api(`/api/feed?codes=${encodeURIComponent(codes)}`); }
  catch { data = { error: true }; }
  if (watchlist.join(',') !== codes) return; // 그사이 관심종목이 바뀌었으면 버림
  watchFeed = data;
  renderWatchFeed();
}
function renderWatchFeed() {
  if (!watchFeed) return;
  if (watchFeed.error) { $('watchFeed').innerHTML = feedMessage('소식을 불러오지 못했어요.'); return; }
  const f = watchFeedFilter;
  const items = f === 'news' ? watchFeed.news
    : f === 'disclosure' ? watchFeed.disclosures
    : f === 'important' ? watchFeed.disclosures.filter(i => i.level)
    : [...watchFeed.news, ...watchFeed.disclosures].sort(byNewest);
  show($('watchFeedNote'), feedNotice(watchFeed, f === 'all' ? ['news', 'disclosure'] : f === 'news' ? ['news'] : ['disclosure']));
  const empty = f === 'important' ? '최근 3개월 동안 중요 공시가 없어요.' : '아직 소식이 없어요.';
  const anyEnabled = f === 'news' ? watchFeed.newsEnabled
    : f === 'all' ? watchFeed.newsEnabled || watchFeed.disclosuresEnabled : watchFeed.disclosuresEnabled;
  $('watchFeed').innerHTML = items.length ? items.slice(0, watchFeedLimit).map(i => feedItem(i, true)).join('')
    : anyEnabled ? feedMessage(empty) : '';
  $('watchFeedMore').hidden = items.length <= watchFeedLimit;
}
bindChips($('watchFeedFilter'), f => { watchFeedFilter = f; watchFeedLimit = WATCH_PAGE; renderWatchFeed(); });
$('watchFeedMore').addEventListener('click', () => { watchFeedLimit += WATCH_PAGE; renderWatchFeed(); });

// 검색 (자동완성 목록은 종목 분석·주가 흐름 검색창이 같이 씀)
$('searchForm').addEventListener('submit', e => { e.preventDefault(); run($('q').value); });
let searchTimer;
for (const input of [$('q'), $('trendQ')]) input.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = input.value.trim();
  if (!q) return;
  searchTimer = setTimeout(async () => {
    try {
      const list = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
      $('stockList').innerHTML = list.map(s => `<option value="${s.name}">${s.code}</option>`).join('');
    } catch {}
  }, 200);
});

// 주가 흐름 화면 (#trend, technical.js)
initTrend({ $, esc, show, api, onAnalyze: (code, name) => { location.hash = '#analysis'; $('q').value = name; run(code); } });
$('trendLink').addEventListener('click', () => current && openTrend(current.stock.code, current.stock.name));

// 설문
// 설문 문항은 survey.js 한 곳에서 관리 (서버도 같은 파일로 성향을 계산)
$('surveyQuestions').innerHTML = SURVEY.map((q, i) => `
  <fieldset>
    <legend><span class="q-num">${i + 1}</span>${q.title}</legend>
    ${q.note ? `<p class="q-note">${q.note}</p>` : ''}
    ${q.options.map((o, j) => `<label><input type="radio" name="${q.key}" value="${o.value}"${j === 0 ? ' required' : ''} /> ${o.label}</label>`).join('')}
  </fieldset>`).join('');

function updateBadge() {
  if (!profile) { $('profileBadge').textContent = '성향 미설정'; return; }
  const r = riskFromAnswers(profile);
  $('profileBadge').textContent = r.complete ? r.riskLevel : `${r.riskLevel} (간이)`;
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
  profile = Object.fromEntries(SURVEY.map(q => [q.key, f.get(q.key)]));
  saveProfile();
  if (store.get(MODE_KEY, null) == null) applyMode(defaultMode());
  updateBadge();
  if (current) run(current.stock.code);
  renderWatch();
  loadPicks();
});

// 로그인·회원가입
function refreshCurrent() {
  if (current) analyze(current.stock.code).then(renderResult).catch(e => show($('error'), e.message));
}
function updateAccountUI() {
  $('loginBtn').hidden = !!user;
  $('userMenu').hidden = !user;
  $('surveyLogin').hidden = !!user;
  $('userName').textContent = user ? `${user.name}님` : '';
  $('verifyBanner').hidden = !mailEnabled || !user || user.emailVerified;
  $('verifyTo').textContent = user?.email ?? '';
}

// 화면 위쪽 안내 문구 (10초 뒤 사라짐)
let flashTimer;
function flash(text, kind = 'ok') {
  $('flash').textContent = text;
  $('flash').className = `flash ${kind}`;
  $('flash').hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { $('flash').hidden = true; }, 10000);
}
// 로그인하면 이 기기에 있던 성향·관심종목을 계정과 합침 (계정에 저장된 성향이 우선)
function applyAccount(u) {
  user = u;
  const mergedWatch = [...new Set([...u.watchlist, ...watchlist])];
  const changed = mergedWatch.length !== u.watchlist.length || (!u.profile && profile);
  watchlist = mergedWatch;
  profile = u.profile || profile;
  store.set('stockfit.watch', watchlist);
  store.set('stockfit.profile', profile);
  if (changed) syncAccount({ profile, watchlist });
  updateAccountUI();
  updateBadge();
  refreshCurrent();
  renderWatch();
  refreshChatForAccount();
  loadPicks();
}

// 로그인 창의 네 가지 화면: 로그인, 회원가입, 비밀번호 찾기, 새 비밀번호 정하기
const AUTH_NOTE = '로그인하면 내 투자성향과 관심종목을 어느 기기에서든 이어서 볼 수 있어요.';
const AUTH_MODES = {
  login: { title: '로그인', submit: '로그인', note: AUTH_NOTE, fields: ['emailField', 'pwField'] },
  signup: { title: '회원가입', submit: '가입하기', note: AUTH_NOTE,
            fields: ['nameField', 'emailField', 'pwField', 'pwHint', 'confirmField'] },
  forgot: { title: '비밀번호 찾기', submit: '재설정 메일 보내기',
            note: '가입한 이메일을 입력하면 비밀번호를 다시 정할 수 있는 링크를 보내드려요.', fields: ['emailField'] },
  reset: { title: '새 비밀번호 정하기', submit: '비밀번호 변경',
           note: '새로 쓸 비밀번호를 입력해주세요. 바꾸면 다른 기기에서는 모두 로그아웃돼요.',
           fields: ['pwField', 'pwHint', 'confirmField'] },
};
const AUTH_FIELDS = ['nameField', 'emailField', 'pwField', 'pwHint', 'confirmField'];
let authMode = 'login';
let resetToken = null; // 재설정 메일 링크로 들어왔을 때의 토큰

function setAuthMode(mode) {
  authMode = mode;
  const m = AUTH_MODES[mode];
  const tabbed = mode === 'login' || mode === 'signup';
  $('authTabs').hidden = !tabbed;
  document.querySelectorAll('#authTabs [data-mode]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
  $('authTitle').className = tabbed ? 'sr-only' : 'auth-title';
  $('authTitle').textContent = m.title;
  $('authNote').textContent = m.note;
  for (const id of AUTH_FIELDS) {
    const on = m.fields.includes(id);
    $(id).hidden = !on;
    const input = $(id).querySelector('input');
    if (input) input.disabled = !on; // 숨긴 칸은 입력 확인에서 제외
  }
  $('pwLabel').textContent = mode === 'reset' ? '새 비밀번호' : '비밀번호';
  $('authPw').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('authSubmit').textContent = m.submit;
  $('forgotLink').hidden = mode !== 'login' || !mailEnabled;
  $('backToLogin').hidden = mode !== 'forgot';
  show($('authError'), '');
  show($('authOk'), '');
}
function openAuth(mode = 'login') {
  if ($('survey').open) $('survey').close();
  setAuthMode(mode);
  $('auth').showModal();
}
$('loginBtn').addEventListener('click', () => openAuth());
$('surveyLogin').addEventListener('click', () => openAuth());
$('authClose').addEventListener('click', () => $('auth').close());
$('authTabs').addEventListener('click', e => {
  const mode = e.target.dataset.mode;
  if (mode) setAuthMode(mode);
});
$('forgotLink').addEventListener('click', () => setAuthMode('forgot'));
$('backToLogin').addEventListener('click', () => setAuthMode('login'));

$('authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const mode = authMode;
  const newPassword = mode === 'signup' || mode === 'reset';
  if (newPassword && $('authPw').value !== $('authPw2').value) return show($('authError'), '비밀번호가 서로 달라요.');
  show($('authError'), '');
  $('authSubmit').disabled = true;
  try {
    if (mode === 'forgot') {
      await api('/api/auth/forgot', { method: 'POST', body: { email: $('authEmail').value } });
      show($('authOk'), '가입된 이메일이라면 비밀번호 재설정 링크를 보냈어요. 메일함과 스팸함을 확인해주세요. 링크는 30분 동안 쓸 수 있어요.');
      return;
    }
    const body = mode === 'reset'
      ? { token: resetToken, password: $('authPw').value }
      : { email: $('authEmail').value, password: $('authPw').value };
    if (mode === 'signup') body.name = $('authName').value;
    const { user: u } = await api(`/api/auth/${mode}`, { method: 'POST', body });
    $('authForm').reset();
    $('auth').close();
    applyAccount(u);
    if (mode === 'signup') {
      flash(mailEnabled ? `${u.email}로 인증 메일을 보냈어요. 메일의 링크를 눌러 인증을 완료해주세요.` : `${u.name}님, 가입을 환영해요!`);
    }
    if (mode === 'reset') { resetToken = null; flash('비밀번호를 바꿨어요. 다른 기기에서는 모두 로그아웃됐어요.'); }
    if (!profile) openSurvey();
  } catch (err) {
    show($('authError'), err.message);
  } finally {
    $('authSubmit').disabled = false;
  }
});
$('logoutBtn').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch {}
  // 같은 기기를 다른 사람이 쓸 수 있으니 이 기기에 남은 정보도 지움
  user = null;
  profile = null;
  watchlist = [];
  store.set('stockfit.profile', null);
  store.set('stockfit.watch', []);
  chatMessages = [];
  saveChat();
  updateAccountUI();
  updateBadge();
  refreshCurrent();
  renderWatch();
  refreshChatForAccount();
  loadPicks();
});
$('resendVerify').addEventListener('click', async () => {
  try {
    await api('/api/auth/resend-verify', { method: 'POST', body: {} });
    flash(`${user.email}로 인증 메일을 다시 보냈어요.`);
  } catch (err) { flash(err.message, 'error'); }
});

// AI 도우미 (서버에 OPENAI_API_KEY가 있을 때만 버튼이 보임)
let chatEnabled = false;
const CHAT_KEY = 'stockfit.chat';
let chatMessages = (() => { try { return JSON.parse(sessionStorage.getItem(CHAT_KEY)) ?? []; } catch { return []; } })();
let chatBusy = false;
const saveChat = () => { try { sessionStorage.setItem(CHAT_KEY, JSON.stringify(chatMessages.slice(-30))); } catch {} };

// 답변 표시: 글자는 이스케이프하고 줄바꿈과 **굵게**만 살림
const formatChat = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');

// 받침에 따라 은/는 (삼성전자는, 현대자동차는, 카카오뱅크는 / LG엔솔은)
const eunNeun = w => {
  const c = w.charCodeAt(w.length - 1);
  return `${w}${c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 > 0 ? '은' : '는'}`;
};

function chatSuggestions() {
  if (current) {
    const name = current.stock.name;
    return [`${eunNeun(name)} 어떤 점이 내 성향과 맞아요?`, `적합도 ${current.fit.total}점은 어떻게 봐야 해요?`, `${name}에서 조심할 점을 쉽게 알려줘`];
  }
  return ['주식은 어떻게 돈을 버는 거예요?', '적합도 점수는 어떻게 보는 거예요?', '배당이 뭐예요?'];
}

let pendingAsk = null; // 로그인 전에 누른 질문 (로그인하면 이어서 물어봄)

function renderChat() {
  $('chatContext').textContent = current ? `${current.stock.name} 분석 결과를 보고 답해요` : '주식 용어나 분석 결과를 쉽게 설명해드려요';
  // 로그인한 회원만 쓸 수 있음
  $('chatForm').hidden = $('chatReset').hidden = !user;
  if (!user) {
    $('chatLog').innerHTML = `<div class="msg assistant">AI 도우미는 <strong>로그인한 회원</strong>만 쓸 수 있어요. 가입은 이메일과 비밀번호만 있으면 1분이면 끝나요.</div>
      <button type="button" id="chatLogin" class="primary chat-login">로그인하고 물어보기</button>`;
    $('chatSuggest').innerHTML = '';
    return;
  }
  const intro = '<div class="msg assistant">안녕하세요! 주식 용어나 지금 보는 분석 결과 중 모르는 게 있으면 편하게 물어보세요. 단, 사라·팔라는 판단은 해드릴 수 없어요.</div>';
  $('chatLog').innerHTML = intro + chatMessages.map(m => `<div class="msg ${m.role}">${formatChat(m.content)}</div>`).join('')
    + (chatBusy ? '<div class="msg assistant typing" aria-label="답변 작성 중"><i></i><i></i><i></i></div>' : '');
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
  $('chatSuggest').innerHTML = chatMessages.length ? ''
    : chatSuggestions().map(q => `<button type="button" data-ask="${esc(q)}">${esc(q)}</button>`).join('');
  $('chatSend').disabled = chatBusy;
}

function openChat(question) {
  $('chatPanel').hidden = false;
  $('chatOpen').hidden = true;
  $('chatOpen').setAttribute('aria-expanded', 'true');
  renderChat();
  if (!user) { pendingAsk = question ?? null; return; }
  if (question) sendChat(question);
  else $('chatInput').focus();
}
$('chatLog').addEventListener('click', e => { if (e.target.id === 'chatLogin') openAuth('login'); });
// 로그인·로그아웃 뒤 도우미 화면을 다시 그림 (로그인 전에 누른 질문이 있으면 이어서)
function refreshChatForAccount() {
  if ($('chatPanel').hidden) return;
  renderChat();
  if (user && pendingAsk) { const q = pendingAsk; pendingAsk = null; sendChat(q); }
}
function closeChat() {
  $('chatPanel').hidden = true;
  $('chatOpen').hidden = !chatEnabled;
  $('chatOpen').setAttribute('aria-expanded', 'false');
}

async function sendChat(text) {
  const q = text.trim();
  if (!q || chatBusy) return;
  chatMessages.push({ role: 'user', content: q });
  chatBusy = true;
  renderChat();
  try {
    const history = chatMessages.filter(m => m.role === 'user' || m.role === 'assistant').slice(-12)
      .map(m => ({ role: m.role, content: m.content.slice(0, 1500) }));
    const { reply } = await api('/api/chat', { method: 'POST', body: { messages: history, code: current?.stock.code, profile, mode } });
    chatMessages.push({ role: 'assistant', content: reply });
  } catch (err) {
    chatMessages.push({ role: 'error', content: err.message });
  } finally {
    chatBusy = false;
    saveChat();
    renderChat();
  }
}

$('chatOpen').addEventListener('click', () => openChat());
$('chatClose').addEventListener('click', closeChat);
$('chatReset').addEventListener('click', () => { chatMessages = []; saveChat(); renderChat(); });
$('chatForm').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('chatInput').value;
  $('chatInput').value = '';
  sendChat(text);
});
// Enter로 보내기, Shift+Enter는 줄바꿈 (한글 입력 중 조합 상태일 때는 보내지 않음)
$('chatInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('chatForm').requestSubmit(); }
});
// 추천 질문, 상태 설명의 "AI 도우미에게 물어보기"
document.addEventListener('click', e => {
  const b = e.target.closest('[data-ask]');
  if (b && chatEnabled) openChat(b.dataset.ask);
});

function enableChat(on) {
  chatEnabled = on;
  $('chatOpen').hidden = !on;
  document.querySelectorAll('.chat-only').forEach(el => { el.hidden = !on; });
}

// 검색창 아래: 내 성향 기준 적합도가 높은 종목 (서버가 후보 데이터를 다 모으기 전에는 예시 종목)
let examplePicks = [];
let picksTimer;
const PICK_BASIS = { marketcap: n => `시가총액 상위 ${n}개 종목`, list: n => `주요 대형주 ${n}개`, sample: () => '예시 종목' };
async function loadPicks() {
  clearTimeout(picksTimer);
  let d;
  try { d = await api(`/api/picks?${new URLSearchParams(profile || {})}`); } catch { d = { ready: false }; }
  const chip = (code, name, extra = '', title = '') =>
    `<button type="button" data-q="${code}" data-name="${esc(name)}"${title ? ` title="${esc(title)}"` : ''}><strong>${esc(name)}</strong>${extra}</button>`;
  if (d.ready && d.picks.length) {
    $('picksLabel').textContent = profile ? '내 성향에 잘 맞는 종목' : '적합도가 높은 종목';
    $('picksSub').textContent = profile ? `${riskFromAnswers(profile).riskLevel} 기준` : '기본 기준 · 성향을 정하면 바뀌어요';
    $('quickPicks').innerHTML = d.picks.map(p => chip(p.code, p.name, `<span class="pick-score">${p.total}점</span>`,
      p.reason.length ? `강점: ${p.reason.join(', ')}` : p.verdict)).join('');
    show($('picksNote'), `${(PICK_BASIS[d.basis] ?? (n => `${n}개 종목`))(d.count)} 중 내 기준 적합도가 높은 순서예요. 재무·주가 데이터로 계산한 참고용이고, 투자 추천이 아니에요.`);
  } else {
    $('picksLabel').textContent = '예시 종목';
    $('picksSub').textContent = !d.preparing ? '' : d.total
      ? `내 성향에 맞는 종목을 찾는 중이에요 (${d.done}/${d.total})` : '내 성향에 맞는 종목을 찾을 준비를 하고 있어요';
    $('quickPicks').innerHTML = examplePicks.map(s => chip(s.code, s.name)).join('');
    show($('picksNote'), '');
    if (d.preparing) picksTimer = setTimeout(loadPicks, 10000); // 다 모이면 자동으로 바뀌게
  }
}
$('quickPicks').addEventListener('click', e => {
  const b = e.target.closest('[data-q]');
  if (b) { $('q').value = b.dataset.name; run(b.dataset.q); }
});

// 데이터 연결 상태: 어떤 키가 들어갔고 무엇이 동작하는지
function renderDataStatus(s) {
  const p = s.peers;
  const peerText = !s.dart ? 'DART 키가 있어야 모을 수 있어요.'
    : p.running ? `${p.phase} (${p.done.toLocaleString()}/${p.total.toLocaleString()})`
    : p.error ? `잠시 멈췄어요: ${p.error}`
    : p.metrics ? `${p.metrics.toLocaleString()}건 준비됨` : '준비 전이에요.';
  const rows = [
    ['DART (재무제표·공시)', s.dart ? 'on' : 'off', s.dart ? (s.fullList ? '상장사 전체 분석 가능' : '상장사 목록 준비 중') : '없으면 예시 3종목만 분석해요.'],
    ['업종 비교 데이터', !s.dart ? 'off' : p.error ? 'error' : p.metrics ? 'on' : 'wait', peerText],
    ['주가 시세 (공공데이터포털)', s.price, s.price === 'off' ? '없으면 가격 수준·주가 안정성을 빼고 계산해요.' : s.priceError || '변동성·위험 등급·PER·PBR 계산'],
    ['금리 (한국은행 ECOS)', s.macro, s.macro === 'off' ? '없으면 금리 반영 없이 계산해요.' : s.macroError || '배당과 국고채 금리 비교, 고금리 반영'],
    ['뉴스 (네이버 검색)', !s.news ? 'off' : s.newsError ? 'error' : 'on', !s.news ? '없으면 공시만 보여줘요.' : s.newsError || `종목 뉴스 표시${s.newsApi ? ` (${s.newsApi} 방식)` : ''}`],
    ['AI 도우미 (OpenAI)', s.ai ? 'on' : 'off', s.ai ? `${s.aiModel} 모델 사용` : '없으면 도우미 버튼이 보이지 않아요.'],
  ];
  const LABEL = { on: '연결됨', off: '키 없음', error: '오류', wait: '준비 중' };
  $('dataStatus').innerHTML = rows.map(([name, state, text]) =>
    `<li><span class="ds-state ${state}">${LABEL[state]}</span><strong>${name}</strong><span class="ds-text">${esc(text)}</span></li>`).join('');
}

// 시작
(async function init() {
  // 메일 링크로 들어온 경우 (?verify=… 또는 ?reset=…)
  const params = new URLSearchParams(location.search);
  const verifyToken = params.get('verify');
  resetToken = params.get('reset');
  if (verifyToken || resetToken) history.replaceState(null, '', '/'); // 주소창에서 토큰 지우기
  if (verifyToken) {
    try {
      await api('/api/auth/verify', { method: 'POST', body: { token: verifyToken } });
      flash('이메일 인증이 완료됐어요.');
    } catch (err) { flash(err.message, 'error'); }
  }

  try {
    const { user: u } = await api('/api/me');
    if (u) applyAccount(u);
  } catch {}
  updateAccountUI();
  updateBadge();
  try {
    const { full, picks } = await (await fetch('/api/stocks')).json();
    if (full) $('q').placeholder = '궁금한 종목명 또는 종목코드 (예: SK텔레콤, 005930)';
    examplePicks = picks;
    loadPicks();
    const { criteria } = await (await fetch('/api/criteria')).json();
    $('criteriaList').innerHTML = criteria.map(c => `
      <div class="crit"><strong>${esc(c.label)}</strong> <span class="crit-about">${esc(c.about)}</span>
        <ul>${c.metrics.map(m => `<li>${esc(m.label)}: ${esc(m.rule)}${m.peer ? ' <span class="crit-peer">업종 비교</span>' : ''}</li>`).join('')}</ul>
      </div>`).join('');
    const status = await api('/api/status');
    renderDataStatus(status);
    enableChat(status.ai);
    mailEnabled = status.mail;
    updateAccountUI();
  } catch (e) { show($('error'), '서버에 연결하지 못했어요. 잠시 후 새로고침해주세요.'); }
  if (resetToken) openAuth('reset');
  else if (!profile) openSurvey();
  if (!user) renderWatch(); // 로그인 상태면 applyAccount에서 이미 그림
})();

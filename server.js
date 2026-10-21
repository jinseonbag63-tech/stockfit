// StockFit 서버: 화면(public/) 제공 + 검색·분석 API
// Node.js 기본 기능으로 동작하고, 배포용 Postgres 연결에만 pg 라이브러리를 써요 (npm install)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUICK_PICKS, MAJOR_STOCKS } from './src/stocks.js';
import { loadCompanies, hasFullList, search, findStock, getByCode } from './src/corpCodes.js';
import { getMetricsFromDart, getCompanyInfo } from './src/dart.js';
import { getSample } from './src/sampleData.js';
import { industryName, isFinancial, MARKET } from './src/industry.js';
import { buildProfile, computeFit, CRITERIA, METRICS, RISK_LEVELS } from './src/scoring.js';
import { SURVEY, cleanAnswers } from './public/survey.js';
import { getPriceStats, getMarketCaps } from './src/price.js';
import { getRates } from './src/macro.js';
import { initPeers, syncPeers, peerStatus, loadPeers, rankAmong, MIN_PEERS } from './src/peers.js';
import { openDb } from './src/db.js';
import { initCache, cached } from './src/cache.js';
import { createPicks } from './src/picks.js';
import { explainMetrics, summarize, beginnerSummary } from './src/explain.js';
import { askAssistant, buildContext, DEFAULT_MODEL } from './src/chat.js';
import { initAuth, signup, login, createSession, userFromToken, endSession, updateUserData, publicUser,
         findUser, issueEmailToken, verifyEmail, resetPassword, SESSION_COOKIE, SESSION_MAX_AGE } from './src/auth.js';
import { sendMail, mailConfigured, verifyMail, resetMail } from './src/mail.js';
import { getFeed, newsError, newsApiName } from './src/feed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env 파일 읽기 (KEY=VALUE 형식)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
  }
}
const DART_KEY = process.env.DART_API_KEY?.trim();
const NAVER = { id: process.env.NAVER_CLIENT_ID?.trim(), secret: process.env.NAVER_CLIENT_SECRET?.trim() };
const PRICE_KEY = process.env.DATA_GO_KR_KEY?.trim(); // 공공데이터포털 (주식시세)
const ECOS_KEY = process.env.ECOS_API_KEY?.trim();    // 한국은행 ECOS (금리)
const OPENAI_KEY = process.env.OPENAI_API_KEY?.trim(); // AI 도우미
const OPENAI_MODEL = process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
const PORT = Number(process.env.PORT) || 3000;
// 메일 속 링크의 주소. 요청 헤더가 아니라 설정값을 써야 링크가 다른 사이트로 바뀌지 않음
const APP_URL = (process.env.APP_URL?.trim() || `http://localhost:${PORT}`).replace(/\/+$/, '');

// 상장사 목록 불러오기 (검색 요청은 이게 끝날 때까지 기다림)
const ready = loadCompanies(DART_KEY, path.join(__dirname, 'data'));

// DB: DATABASE_URL이 있으면 Postgres, 없으면 data/stockfit.db (SQLite)
const DATABASE_URL = process.env.DATABASE_URL?.trim();
let db;
try {
  db = await openDb({ dataDir: path.join(__dirname, 'data'), url: DATABASE_URL });
} catch (err) {
  console.error(`DB에 연결하지 못했어요: ${err.message}`);
  console.error(DATABASE_URL ? '→ .env(또는 Render 환경 변수)의 DATABASE_URL을 확인해주세요.' : '→ data 폴더에 쓸 수 있는지 확인해주세요.');
  process.exit(1);
}
await initAuth(db);
initPeers(db);
initCache(db);
// 메일 설정이 있을 때만 이메일 인증·비밀번호 찾기를 켜요 (없으면 가입·로그인만)
const MAIL_ON = mailConfigured();

// 시세·금리는 없어도 분석은 되게: 실패하면 그 부분만 빼고 마지막 오류를 기억해 상태 화면에 보여줌
const sourceErrors = { price: null, macro: null };
async function optional(name, fn) {
  try {
    const value = await fn();
    sourceErrors[name] = null;
    return value;
  } catch (err) {
    sourceErrors[name] = err.message;
    console.error(`[${name === 'price' ? '시세' : '금리'}]`, err.message);
    return null;
  }
}
const sourceState = (key, name) => (!key ? 'off' : sourceErrors[name] ? 'error' : 'on');

// 1) 성향과 상관없는 분석 재료: 재무 지표 + 시세 + 금리 + 업종 비교
async function stockInputs(stock) {
  const data = await getData(stock);
  const [price, macro] = await Promise.all([
    PRICE_KEY ? optional('price', () => cached(`price:${stock.code}`, PRICE_TTL, () => getPriceStats(PRICE_KEY, stock.code))) : null,
    ECOS_KEY ? optional('macro', () => getRates(ECOS_KEY)) : null,
  ]);
  // 같은 업종 회사들 + 업종 PER·PBR 비교용 전체 시가총액 (업종 데이터가 있을 때만)
  const peers = await loadPeers(data.info?.industryCode, data.year);
  const caps = PRICE_KEY && peers.length >= MIN_PEERS ? await optional('price', () => getMarketCaps(PRICE_KEY)) : null;

  const m = { ...data.metrics };
  if (price) {
    m.volatility = price.volatility;
    m.maxDrawdown = price.maxDrawdown;
    if (price.marketCap) {
      if (m.netIncome > 0) m.per = price.marketCap / m.netIncome;
      else if (m.netIncome != null) m.perLoss = true;
      if (m.equity > 0) m.pbr = price.marketCap / m.equity;
    }
  }
  if (macro?.bond3y != null && m.dividendYield != null) m.dividendSpread = m.dividendYield - macro.bond3y;

  const capOf = p => caps?.get(p.stockCode);
  const PICK = {
    per: p => (capOf(p) && p.m.netIncome > 0 ? capOf(p) / p.m.netIncome : null),
    pbr: p => (capOf(p) && p.m.equity > 0 ? capOf(p) / p.m.equity : null),
  };
  const rank = (key, value) => rankAmong(peers, {
    value, higherIsBetter: METRICS[key].higher, pick: PICK[key] ?? (p => p.m[key]),
  });
  return { data, metrics: m, price, macro, rank };
}

// 2) 성향으로 적합도 계산 (가벼워서 성향이 바뀌면 바로 다시 계산)
function scoreStock(inputs, answers) {
  const profile = buildProfile(answers, inputs.macro);
  const fit = computeFit(inputs.metrics, profile, { rank: inputs.rank, risk: inputs.price?.risk ?? null });
  return { profile, fit };
}

async function analyzeStock(stock, answers) {
  const inputs = await stockInputs(stock);
  return { ...inputs, ...scoreStock(inputs, answers) };
}

// "내 성향에 맞는 종목" 후보: 시세 키가 있으면 시가총액 상위 50개(우선주·ETF 제외),
// 없으면 주요 대형주 목록, DART 키도 없으면 예시 종목
const PICK_CANDIDATES = 50;
async function listCandidates() {
  await ready;
  if (!DART_KEY) return { stocks: QUICK_PICKS.map(getByCode).filter(Boolean), basis: 'sample' };
  if (PRICE_KEY) {
    const caps = await optional('price', () => getMarketCaps(PRICE_KEY));
    // 상장사 목록에 있는 종목코드만 (우선주·ETF·ETN은 DART 상장사 목록에 없어서 자연히 빠져요)
    const stocks = [...(caps ?? [])].filter(([code, cap]) => cap > 0 && getByCode(code))
      .sort((a, b) => b[1] - a[1]).slice(0, PICK_CANDIDATES).map(([code]) => getByCode(code));
    if (stocks.length) return { stocks, basis: 'marketcap' };
  }
  return { stocks: MAJOR_STOCKS.map(getByCode).filter(Boolean), basis: 'list' };
}
const picks = createPicks({ listCandidates, stockInputs, scoreStock });

// DART 데이터는 사업보고서(1년에 한 번) 기반이라 3일, 주가는 하루 한 번 업데이트라 6시간 저장 (메모리 + DB)
const DART_TTL = 3 * 24 * 60 * 60 * 1000;
const PRICE_TTL = 6 * 60 * 60 * 1000;

async function getData(stock) {
  const fallback = reason => {
    const s = getSample(stock);
    if (!s) throw Object.assign(new Error(reason), { status: 502 });
    return { ...s, notice: `${reason} 예시 데이터로 보여주고 있어요.` };
  };
  if (!DART_KEY) return fallback('DART 키가 없어서');

  try {
    return await cached(`dart:${stock.code}`, DART_TTL, async () => {
      const [metrics, info] = await Promise.all([
        getMetricsFromDart(DART_KEY, stock),
        getCompanyInfo(DART_KEY, stock.corpCode).catch(() => ({})),
      ]);
      return { ...metrics, info };
    });
  } catch (err) {
    console.error(`[DART] ${stock.name}:`, err.message);
    return fallback(`${stock.name}의 재무 데이터를 불러오지 못했어요. (${err.message})`);
  }
}

const publicStock = s => ({ code: s.code, name: s.name });
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(body)); };

// 요청 본문(JSON) 읽기, 기본 10KB까지
function readBody(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size <= limit) chunks.push(c); });
    req.on('end', () => {
      if (size > limit) return reject(Object.assign(new Error('요청이 너무 커요.'), { status: 413 }));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('잘못된 요청이에요.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const readToken = req => req.headers.cookie?.split(';').map(c => c.trim().split('='))
  .find(([k]) => k === SESSION_COOKIE)?.[1];
// HTTPS로 접속했으면(Render 등은 중간 서버가 x-forwarded-proto로 알려줌) Secure를 붙여 HTTPS에서만 쿠키 전송
const isHttps = req => req.socket.encrypted || req.headers['x-forwarded-proto']?.split(',')[0].trim() === 'https';
const sessionCookie = (req, value, maxAge) =>
  `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

// 인증 메일·재설정 메일 보내기. 1분 안에 또 요청하면 보내지 않고 false
async function sendAccountMail(user, purpose) {
  const token = await issueEmailToken(user, purpose);
  if (!token) return false;
  const link = `${APP_URL}/?${purpose}=${token}`;
  await sendMail({ to: user.email, ...(purpose === 'verify' ? verifyMail : resetMail)(user.name, link) });
  return true;
}
const logMailError = err => console.error('[메일]', err.message);

// 회원 API: 가입·로그인·로그아웃·내 정보(성향, 관심종목)·이메일 인증·비밀번호 재설정
async function handleAuth(req, res, route) {
  const method = req.method;
  // 다른 사이트에서 몰래 보내는 요청을 막기 위해 쓰기 요청은 JSON만 받음
  if (method !== 'GET' && !req.headers['content-type']?.startsWith('application/json')) {
    return json(res, 415, { error: '잘못된 요청이에요.' });
  }
  const noStore = { 'Cache-Control': 'no-store' };
  const loggedIn = async (user, status) => json(res, status, { user: await publicUser(user) },
    { ...noStore, 'Set-Cookie': sessionCookie(req, await createSession(user), SESSION_MAX_AGE) });
  const mailOff = () => json(res, 503, { error: '이메일 기능은 아직 준비 중이에요.' });

  if (route === '/api/me' && method === 'GET') {
    const user = await userFromToken(readToken(req));
    return json(res, 200, { user: user ? await publicUser(user) : null }, noStore);
  }
  if (route === '/api/me' && method === 'PUT') {
    const user = await userFromToken(readToken(req));
    if (!user) return json(res, 401, { error: '로그인이 필요해요.' });
    return json(res, 200, { user: await publicUser(await updateUserData(user, await readBody(req))) }, noStore);
  }
  if (route === '/api/auth/signup' && method === 'POST') {
    const user = await signup(await readBody(req));
    // 메일 설정이 있을 때만 인증 메일 (늦거나 실패해도 가입은 완료)
    if (MAIL_ON) sendAccountMail(user, 'verify').catch(logMailError);
    return loggedIn(user, 201);
  }
  if (route === '/api/auth/verify' && method === 'POST') {
    if (!MAIL_ON) return mailOff();
    await verifyEmail((await readBody(req)).token);
    return json(res, 200, { ok: true });
  }
  if (route === '/api/auth/resend-verify' && method === 'POST') {
    if (!MAIL_ON) return mailOff();
    const user = await userFromToken(readToken(req));
    if (!user) return json(res, 401, { error: '로그인이 필요해요.' });
    if (user.email_verified_at) return json(res, 400, { error: '이미 인증된 이메일이에요.' });
    if (!await sendAccountMail(user, 'verify')) return json(res, 429, { error: '방금 메일을 보냈어요. 1분 뒤에 다시 시도해주세요.' });
    return json(res, 200, { ok: true });
  }
  if (route === '/api/auth/forgot' && method === 'POST') {
    if (!MAIL_ON) return mailOff();
    const user = await findUser((await readBody(req)).email);
    if (user) sendAccountMail(user, 'reset').catch(logMailError);
    // 가입 여부를 알 수 없게 항상 같은 응답
    return json(res, 200, { ok: true });
  }
  if (route === '/api/auth/reset' && method === 'POST') {
    if (!MAIL_ON) return mailOff();
    const { token, password } = await readBody(req);
    return loggedIn(await resetPassword(token, password), 200);
  }
  if (route === '/api/auth/login' && method === 'POST') return loggedIn(await login(await readBody(req)), 200);
  if (route === '/api/auth/logout' && method === 'POST') {
    await endSession(readToken(req));
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }
  return json(res, 404, { error: 'Not found' });
}

// AI 도우미: 지금 보는 종목의 분석 결과를 서버에서 다시 만들어 함께 보냄
async function handleChat(req, res) {
  if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: '잘못된 요청이에요.' });
  if (!OPENAI_KEY) return json(res, 503, { error: 'AI 도우미가 꺼져 있어요. .env에 OPENAI_API_KEY를 넣으면 켜져요.' });
  // 로그인한 회원만 (비용 관리, 횟수 제한도 계정 기준)
  const user = await userFromToken(readToken(req));
  if (!user) return json(res, 401, { error: 'AI 도우미는 로그인한 회원만 쓸 수 있어요.' });
  const body = await readBody(req, 64_000);
  await ready;
  const answers = cleanAnswers(body.profile) ?? {};
  const mode = body.mode === 'expert' ? 'expert' : 'beginner';
  const stock = typeof body.code === 'string' ? getByCode(body.code) : null;

  let context = null;
  if (stock) {
    try {
      const r = await analyzeStock(stock, answers);
      context = buildContext({
        stock: { code: stock.code, name: stock.name, market: MARKET[r.data.info?.market] || '', sector: industryName(r.data.info?.industryCode) },
        fit: r.fit, profile: r.profile, indicators: explainMetrics(r.metrics, r.profile, r.fit),
        price: r.price, macro: r.macro, sample: r.data.sample, mode,
      });
    } catch { /* 분석에 실패해도 일반 질문은 답할 수 있게 */ }
  }
  context ??= buildContext({ profile: buildProfile(answers), mode });

  const reply = await askAssistant({ apiKey: OPENAI_KEY, model: OPENAI_MODEL, who: `user:${user.id}`, messages: body.messages, context });
  return json(res, 200, { reply }, { 'Cache-Control': 'no-store' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/auth/') || url.pathname === '/api/me') {
      return await handleAuth(req, res, url.pathname);
    }

    if (url.pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res);

    if (url.pathname === '/api/stocks') {
      await ready;
      const picks = QUICK_PICKS.map(getByCode).filter(Boolean).map(publicStock);
      return json(res, 200, { full: hasFullList(), picks });
    }

    // 내 성향 기준 적합도가 높은 종목 (후보 안에서의 순서, 투자 추천 아님)
    if (url.pathname === '/api/picks') {
      const answers = Object.fromEntries(SURVEY.map(q => [q.key, url.searchParams.get(q.key) || undefined]));
      const s = picks.status();
      return json(res, 200, {
        ready: s.ready, preparing: s.preparing, done: s.done, total: s.total, basis: s.basis, count: s.count,
        picks: s.ready ? picks.top(answers, 5) : [],
      }, { 'Cache-Control': 'no-store' });
    }

    if (url.pathname === '/api/search') {
      await ready;
      return json(res, 200, search(url.searchParams.get('q'), 10).map(publicStock));
    }

    // 종목 소식(뉴스·공시): ?codes=005930,000660 (최대 20개)
    if (url.pathname === '/api/feed') {
      await ready;
      const codes = [...new Set((url.searchParams.get('codes') || '').split(','))].slice(0, 20);
      const stocks = codes.map(getByCode).filter(Boolean);
      return json(res, 200, await getFeed(stocks, { dartKey: DART_KEY, naver: NAVER }));
    }

    if (url.pathname === '/api/criteria') {
      return json(res, 200, { riskLevels: RISK_LEVELS,
        criteria: Object.entries(CRITERIA).map(([key, c]) => ({ key, label: c.label, about: c.about,
          metrics: Object.values(METRICS).filter(m => m.criterion === key).map(m => ({ label: m.label, rule: m.rule, peer: Boolean(m.peer) })) })) });
    }

    // 데이터 연결 상태 (키가 들어갔는지, 업종 비교 준비 정도)
    if (url.pathname === '/api/status') {
      return json(res, 200, {
        dart: Boolean(DART_KEY), fullList: hasFullList(),
        price: sourceState(PRICE_KEY, 'price'), priceError: sourceErrors.price,
        macro: sourceState(ECOS_KEY, 'macro'), macroError: sourceErrors.macro,
        news: Boolean(NAVER.id && NAVER.secret), newsError: newsError(), newsApi: newsApiName(), mail: MAIL_ON,
        ai: Boolean(OPENAI_KEY), aiModel: OPENAI_KEY ? OPENAI_MODEL : null,
        db: db.kind, peers: await peerStatus(),
      }, { 'Cache-Control': 'no-store' });
    }

    if (url.pathname === '/api/analyze') {
      await ready;
      const stock = findStock(url.searchParams.get('q'));
      if (!stock) {
        return json(res, 404, { error: hasFullList()
          ? '찾을 수 없는 종목이에요. 상장사 이름이나 6자리 종목코드로 검색해보세요.'
          : '지금은 DART 키가 없어서 삼성전자, SK하이닉스, 현대자동차만 분석할 수 있어요.' });
      }
      const answers = Object.fromEntries(SURVEY.map(q => [q.key, url.searchParams.get(q.key) || undefined]));
      let r;
      try { r = await analyzeStock(stock, answers); }
      catch (err) { return json(res, err.status || 500, { error: err.message }); }
      const { data, metrics, price, macro, profile, fit } = r;

      const notices = [data.notice];
      if (isFinancial(data.info?.industryCode)) notices.push('금융회사는 재무제표 구조가 일반 기업과 달라서 부채비율 같은 지표가 실제보다 나쁘게 보일 수 있어요.');
      if (data.interestSource?.startsWith('금융비용')) notices.push('이자보상배율은 이자 외 항목이 섞인 금융비용으로 계산해서 실제보다 낮게 나올 수 있어요.');
      return json(res, 200, {
        stock: { code: stock.code, name: stock.name,
                 market: MARKET[data.info?.market] || '', sector: industryName(data.info?.industryCode) },
        source: data.source, sample: data.sample,
        notice: notices.filter(Boolean).join(' ') || null,
        profile, fit, summary: summarize(fit), easy: beginnerSummary(fit),
        indicators: explainMetrics(metrics, profile, fit),
        checklist: data.checklist ?? null,
        price: price ? { asOf: price.asOf, close: price.close, return1y: price.return1y } : null,
        macro,
        sources: { price: sourceState(PRICE_KEY, 'price'), macro: sourceState(ECOS_KEY, 'macro') },
      });
    }

    // 정적 파일
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const full = path.join(__dirname, 'public', path.normalize(file));
    if (!full.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(full)) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    if (err.status) return json(res, err.status, { error: err.message });
    console.error(err);
    json(res, 500, { error: '서버에서 문제가 생겼어요. 터미널의 에러 메시지를 확인해주세요.' });
  }
});

server.on('error', err => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`${PORT}번 포트를 이미 쓰고 있어요. StockFit 서버가 다른 터미널에서 이미 켜져 있을 수 있어요.`);
  console.error(`→ 그 서버를 그대로 쓰려면 http://localhost:${PORT} 을 여세요.`);
  console.error('→ 다시 켜려면 켜져 있는 터미널에서 Ctrl+C로 끈 뒤 npm start 하세요.');
  process.exit(1);
});

server.listen(PORT, async () => {
  console.log(`StockFit 실행 중 → http://localhost:${PORT}`);
  console.log(db.kind === 'postgres'
    ? `DB: Postgres (${new URL(DATABASE_URL).hostname})`
    : 'DB: 내 컴퓨터의 data/stockfit.db (배포할 때는 DATABASE_URL에 Postgres 주소를 넣어요)');
  console.log(MAIL_ON
    ? `메일 설정 확인됨: ${process.env.SMTP_HOST}로 인증·재설정 메일을 보내요.`
    : '메일 설정 없음: 이메일 인증·비밀번호 찾기는 꺼두고 가입·로그인만 써요. (.env의 SMTP_ 항목 확인)');
  console.log(NAVER.id && NAVER.secret
    ? '네이버 검색 키 확인됨: 종목 뉴스를 보여줘요.'
    : '네이버 검색 키 없음: 종목 뉴스는 빼고 공시만 보여줘요. (.env의 NAVER_ 항목 확인)');
  console.log(PRICE_KEY
    ? '시세 키 확인됨: 주가 변동성·위험 등급·PER·PBR을 계산해요.'
    : '시세 키 없음: 가격 수준·주가 안정성은 빼고 계산해요. (.env의 DATA_GO_KR_KEY 확인)');
  console.log(ECOS_KEY
    ? '한국은행 키 확인됨: 금리를 적합도에 반영해요.'
    : '한국은행 키 없음: 금리 반영 없이 계산해요. (.env의 ECOS_API_KEY 확인)');
  console.log(OPENAI_KEY
    ? `AI 도우미 켜짐: ${OPENAI_MODEL} 모델, 로그인한 회원만 사용해요.`
    : 'AI 도우미 꺼짐: 화면에 도우미 버튼이 보이지 않아요. (.env의 OPENAI_API_KEY 확인)');
  // 내 성향에 맞는 종목: 후보 데이터를 백그라운드로 모으고 하루에 한 번 갱신
  // 업종 비교 데이터가 있어야 종목 화면과 같은 점수가 나와서, 업종 비교 수집이 끝난 뒤에 시작해요
  if (!DART_KEY) {
    picks.schedule();
    return console.log('DART 키 없음: 예시 데이터(3종목)로 동작해요. (.env 파일 확인)');
  }
  console.log('DART 키 확인됨: 상장사 목록을 준비하는 중...');
  const r = await ready;
  console.log(r.full ? `상장사 ${r.count.toLocaleString()}개 준비 완료 (${r.from})` : `상장사 목록 준비 실패: ${r.error}`);
  if (!r.full) return picks.schedule();
  // 업종 비교 데이터: 백그라운드에서 모으고 하루에 한 번 갱신 (처음엔 10분 넘게 걸려요)
  const p = await peerStatus();
  console.log(p.metrics ? `업종 비교 데이터 ${p.metrics.toLocaleString()}건 있음, 오래된 것만 새로 받아요.`
    : '업종 비교 데이터를 처음 모으는 중이에요. 끝날 때까지는 기준표로 계산해요.');
  syncPeers(DART_KEY).finally(() => picks.schedule());
  setInterval(() => syncPeers(DART_KEY), 24 * 60 * 60 * 1000).unref();
});

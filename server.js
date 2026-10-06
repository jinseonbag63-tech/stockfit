// StockFit 서버: 화면(public/) 제공 + 검색·분석 API
// 외부 라이브러리 없이 Node.js 기본 기능만 사용 (npm install 불필요)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUICK_PICKS } from './src/stocks.js';
import { loadCompanies, hasFullList, search, findStock, getByCode } from './src/corpCodes.js';
import { getMetricsFromDart, getCompanyInfo } from './src/dart.js';
import { getSample } from './src/sampleData.js';
import { industryName, isFinancial, MARKET } from './src/industry.js';
import { buildProfile, computeFit, CRITERIA, RISK_LEVELS } from './src/scoring.js';
import { explainMetrics, summarize } from './src/explain.js';

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
const PORT = Number(process.env.PORT) || 3000;

// 상장사 목록 불러오기 (검색 요청은 이게 끝날 때까지 기다림)
const ready = loadCompanies(DART_KEY, path.join(__dirname, 'data'));

// DART 응답을 12시간 동안 저장해서 같은 종목을 반복 호출하지 않음
const cache = new Map();
const TTL = 12 * 60 * 60 * 1000;

async function getData(stock) {
  const fallback = reason => {
    const s = getSample(stock);
    if (!s) throw Object.assign(new Error(reason), { status: 502 });
    return { ...s, notice: `${reason} 예시 데이터로 보여주고 있어요.` };
  };
  if (!DART_KEY) return fallback('DART 키가 없어서');

  const hit = cache.get(stock.code);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  try {
    const [metrics, info] = await Promise.all([
      getMetricsFromDart(DART_KEY, stock),
      getCompanyInfo(DART_KEY, stock.corpCode).catch(() => ({})),
    ]);
    const data = { ...metrics, info };
    cache.set(stock.code, { at: Date.now(), data });
    return data;
  } catch (err) {
    console.error(`[DART] ${stock.name}:`, err.message);
    return fallback(`${stock.name}의 재무 데이터를 불러오지 못했어요. (${err.message})`);
  }
}

const publicStock = s => ({ code: s.code, name: s.name });
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/stocks') {
      await ready;
      const picks = QUICK_PICKS.map(getByCode).filter(Boolean).map(publicStock);
      return json(res, 200, { full: hasFullList(), picks });
    }

    if (url.pathname === '/api/search') {
      await ready;
      return json(res, 200, search(url.searchParams.get('q'), 10).map(publicStock));
    }

    if (url.pathname === '/api/criteria') {
      return json(res, 200, { riskLevels: RISK_LEVELS,
        criteria: Object.entries(CRITERIA).map(([key, c]) => ({ key, label: c.label, rule: c.rule })) });
    }

    if (url.pathname === '/api/analyze') {
      await ready;
      const stock = findStock(url.searchParams.get('q'));
      if (!stock) {
        return json(res, 404, { error: hasFullList()
          ? '찾을 수 없는 종목이에요. 상장사 이름이나 6자리 종목코드로 검색해보세요.'
          : '지금은 DART 키가 없어서 삼성전자, SK하이닉스, 현대자동차만 분석할 수 있어요.' });
      }
      const profile = buildProfile(Object.fromEntries(['q1', 'q2', 'q3'].map(k => [k, url.searchParams.get(k) || undefined])));
      let data;
      try { data = await getData(stock); }
      catch (err) { return json(res, err.status || 500, { error: err.message }); }

      const fit = computeFit(data.metrics, profile);
      const notices = [data.notice];
      if (isFinancial(data.info?.industryCode)) notices.push('금융회사는 재무제표 구조가 일반 기업과 달라서 부채비율 같은 지표가 실제보다 나쁘게 보일 수 있어요.');
      return json(res, 200, {
        stock: { code: stock.code, name: stock.name,
                 market: MARKET[data.info?.market] || '', sector: industryName(data.info?.industryCode) },
        source: data.source, sample: data.sample,
        notice: notices.filter(Boolean).join(' ') || null,
        profile, fit, summary: summarize(fit),
        indicators: explainMetrics(data.metrics, profile, fit),
      });
    }

    // 정적 파일
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const full = path.join(__dirname, 'public', path.normalize(file));
    if (!full.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(full)) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    console.error(err);
    json(res, 500, { error: '서버에서 문제가 생겼어요. 터미널의 에러 메시지를 확인해주세요.' });
  }
});

server.listen(PORT, async () => {
  console.log(`StockFit 실행 중 → http://localhost:${PORT}`);
  if (!DART_KEY) return console.log('DART 키 없음: 예시 데이터(3종목)로 동작해요. (.env 파일 확인)');
  console.log('DART 키 확인됨: 상장사 목록을 준비하는 중...');
  const r = await ready;
  console.log(r.full ? `상장사 ${r.count.toLocaleString()}개 준비 완료 (${r.from})` : `상장사 목록 준비 실패: ${r.error}`);
});

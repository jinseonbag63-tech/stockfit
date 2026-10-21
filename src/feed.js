// 종목 소식 모으기: DART 공시 목록 + 네이버 뉴스 검색
// - 공시는 DART 키, 뉴스는 NAVER API HUB 검색 키(NAVER_CLIENT_ID, NAVER_CLIENT_SECRET)가 있어야 동작
// - 같은 종목은 15분 동안 다시 부르지 않음
import { callDart } from './dart.js';

const TTL = 15 * 60 * 1000;
const DISCLOSURE_DAYS = 90;
const NEWS_PER_STOCK = 10;
const DISCLOSURES_PER_STOCK = 20;
const cache = new Map(); // "news:005930" → { at, items }
let lastNewsError = null; // 데이터 연결 상태 화면에 보여줄 마지막 뉴스 오류 (키 값은 들어 있지 않음)
export const newsError = () => lastNewsError;
export const newsApiName = () => (naverApi ? NAVER_APIS[naverApi].name : null);

async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.items;
  const items = await load();
  cache.set(key, { at: Date.now(), items });
  return items;
}

// 공시 이름 → 초보자용 설명 + 중요도 (위에서부터 먼저 맞는 것 하나)
// level: warning(꼭 확인) > important(주가·주주에 영향) > null(참고)
const DISCLOSURE_TYPES = [
  [/횡령|배임/, '회사 돈과 관련된 범죄 혐의가 생겼다는 알림이에요. 꼭 확인해야 해요.', 'warning'],
  [/관리종목|상장폐지|상장적격성|매매거래정지|거래정지/, '상장 유지에 문제가 생겼다는 알림이에요. 꼭 확인해야 해요.', 'warning'],
  [/불성실공시/, '공시 규정을 어겨서 제재를 받았어요. 주의가 필요해요.', 'warning'],
  [/감자결정/, '자본금을 줄인다는 뜻이에요. 손실을 메우려는 경우가 많아 주의가 필요해요.', 'warning'],
  [/영업\(잠정\)실적|잠정실적/, '확정 전에 미리 알려주는 최근 실적이에요. 주가에 영향을 주는 경우가 많아요.', 'important'],
  [/매출액또는손익구조/, '매출이나 이익이 전년보다 크게 바뀌었다는 알림이에요.', 'important'],
  [/무상증자/, '주주에게 새 주식을 공짜로 나눠준다는 뜻이에요. 회사 가치 자체가 바뀌지는 않아요.', 'important'],
  [/유상증자/, '새 주식을 발행해 돈을 모은다는 뜻이에요. 주식 수가 늘어 기존 주주의 몫이 줄어들 수 있어요.', 'important'],
  [/전환사채|신주인수권부사채|교환사채/, '나중에 주식으로 바꿀 수 있는 채권을 발행했어요. 주식으로 바뀌면 주식 수가 늘 수 있어요.', 'important'],
  [/소각/, '회사가 자기 주식을 없앤다는 뜻이에요. 주식 수가 줄어 주주 한 명의 몫이 커져요.', 'important'],
  [/자기주식.*취득|자사주.*취득/, '회사가 자기 회사 주식을 사들인다는 뜻이에요. 주주에게 이익을 돌려주는 방법 중 하나예요.', 'important'],
  [/자기주식.*처분/, '회사가 갖고 있던 자기 주식을 판다는 뜻이에요.', null],
  [/배당/, '배당금(주주에게 나눠주는 돈)과 관련된 결정이에요.', 'important'],
  [/단일판매|공급계약/, '큰 계약을 맺었다는 알림이에요. 매출에 도움이 될 수 있어요.', 'important'],
  [/최대주주.*변경/, '회사의 최대주주가 바뀌었어요. 경영 방향이 달라질 수 있어요.', 'important'],
  [/합병|분할/, '다른 회사와 합치거나 회사를 나눈다는 알림이에요. 주주에게 큰 영향을 줄 수 있어요.', 'important'],
  [/사업보고서/, '1년 동안의 실적과 재무 상태를 정리한 연간 성적표예요.', null],
  [/반기보고서/, '6개월 동안의 실적을 정리한 중간 성적표예요.', null],
  [/분기보고서/, '3개월 동안의 실적을 정리한 보고서예요.', null],
  [/주식등의대량보유/, '회사 지분을 5% 이상 가진 큰 주주의 지분이 바뀌었다는 보고예요.', null],
  [/특정증권등소유상황|임원.*주요주주/, '임원이나 주요주주가 이 회사 주식을 사거나 팔았다는 보고예요.', null],
  [/조회공시/, '소문이나 주가 급변에 대해 거래소가 확인을 요청했거나, 그에 대한 회사의 답변이에요.', null],
  [/감사보고서/, '외부 회계법인이 재무제표를 검토한 결과예요.', null],
  [/기업설명회/, '투자자를 대상으로 설명회를 연다는 알림이에요.', null],
  [/주주총회/, '주주총회 관련 안내예요.', null],
];
function describeDisclosure(name) {
  const hit = DISCLOSURE_TYPES.find(([re]) => re.test(name.replace(/\s/g, '')));
  return { explain: hit?.[1] ?? null, level: hit?.[2] ?? null };
}

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

async function fetchDisclosures(key, stock) {
  const end = new Date();
  const begin = new Date(end.getTime() - DISCLOSURE_DAYS * 24 * 60 * 60 * 1000);
  const data = await callDart('list', {
    crtfc_key: key, corp_code: stock.corpCode, bgn_de: ymd(begin), end_de: ymd(end),
    page_count: String(DISCLOSURES_PER_STOCK),
  });
  if (data.status === '013') return []; // 해당 기간 공시 없음
  if (data.status !== '000') throw new Error(`DART 오류 ${data.status}: ${data.message}`);
  return data.list.map(r => {
    const title = r.report_nm.replace(/\s+/g, ' ').trim();
    const d = r.rcept_dt;
    return {
      type: 'disclosure', code: stock.code, stockName: stock.name, title,
      date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
      source: r.flr_nm,
      url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${encodeURIComponent(r.rcept_no)}`,
      ...describeDisclosure(title),
    };
  });
}

// 네이버 뉴스 결과에는 <b> 태그와 HTML 엔티티가 섞여 있어서 글자만 남김
const ENTITIES = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ' };
const plain = s => String(s ?? '').replace(/<[^>]*>/g, '')
  .replace(/&(#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCharCode(Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m)
  .trim();

// 기사 주소 → 언론사 이름 (모르는 곳은 도메인 그대로)
const PUBLISHERS = {
  'yna.co.kr': '연합뉴스', 'yonhapnewstv.co.kr': '연합뉴스TV', 'hankyung.com': '한국경제', 'mk.co.kr': '매일경제',
  'biz.chosun.com': '조선비즈', 'chosun.com': '조선일보', 'joongang.co.kr': '중앙일보', 'donga.com': '동아일보',
  'hani.co.kr': '한겨레', 'khan.co.kr': '경향신문', 'edaily.co.kr': '이데일리', 'mt.co.kr': '머니투데이',
  'sedaily.com': '서울경제', 'fnnews.com': '파이낸셜뉴스', 'asiae.co.kr': '아시아경제', 'heraldcorp.com': '헤럴드경제',
  'news1.kr': '뉴스1', 'newsis.com': '뉴시스', 'etnews.com': '전자신문', 'zdnet.co.kr': '지디넷코리아',
  'thebell.co.kr': '더벨', 'inews24.com': '아이뉴스24', 'newspim.com': '뉴스핌', 'etoday.co.kr': '이투데이',
  'dt.co.kr': '디지털타임스', 'ajunews.com': '아주경제', 'bizwatch.co.kr': '비즈니스워치',
  'businesspost.co.kr': '비즈니스포스트', 'sbs.co.kr': 'SBS', 'kbs.co.kr': 'KBS', 'imbc.com': 'MBC',
  'jtbc.co.kr': 'JTBC', 'ytn.co.kr': 'YTN', 'news.naver.com': '네이버 뉴스',
};
const PUBLISHER_KEYS = Object.keys(PUBLISHERS).sort((a, b) => b.length - a.length);
function publisher(link) {
  try {
    const host = new URL(link).hostname.replace(/^(www|m)\./, '');
    const key = PUBLISHER_KEYS.find(k => host === k || host.endsWith(`.${k}`));
    return key ? PUBLISHERS[key] : host;
  } catch { return ''; }
}

// 네이버 검색 API는 2026년에 개발자센터에서 NAVER API HUB(네이버클라우드)로 옮겨졌어요.
// 검색 조건과 응답 형식은 같고, 주소와 인증 헤더 이름만 달라요.
// 키를 어디서 받았는지에 따라 맞는 쪽이 달라서, HUB가 인증을 거절하면(401) 예전 개발자센터 방식으로 한 번 더 시도하고
// 되는 쪽을 기억해요.
const NAVER_APIS = {
  hub: { name: 'NAVER API HUB', url: 'https://naverapihub.apigw.ntruss.com/search/v1/news', idHeader: 'X-NCP-APIGW-API-KEY-ID', secretHeader: 'X-NCP-APIGW-API-KEY' },
  legacy: { name: '개발자센터', url: 'https://openapi.naver.com/v1/search/news.json', idHeader: 'X-Naver-Client-Id', secretHeader: 'X-Naver-Client-Secret' },
};
let naverApi = null; // 한 번 성공한 쪽 ('hub' | 'legacy')

async function callNaver(kind, { id, secret }, stock) {
  const api = NAVER_APIS[kind];
  const url = new URL(api.url);
  url.searchParams.set('query', `"${stock.name}"`); // 따옴표: 이름이 정확히 들어간 기사만
  url.searchParams.set('display', String(NEWS_PER_STOCK));
  url.searchParams.set('sort', 'date');
  if (kind === 'hub') url.searchParams.set('format', 'json');
  const res = await fetch(url, { headers: { [api.idHeader]: id, [api.secretHeader]: secret } })
    .catch(err => { throw Object.assign(new Error(`${api.name} 연결 실패: ${err.cause?.code ?? err.message}`), { status: 0 }); });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.errorMessage ?? data.error?.message ?? data.error?.errorCode ?? data.message ?? JSON.stringify(data).slice(0, 200);
    throw Object.assign(new Error(`${api.name} HTTP ${res.status} ${msg}`.trim()), { status: res.status });
  }
  return data;
}

async function fetchNews(keys, stock) {
  let data;
  try {
    if (naverApi) {
      data = await callNaver(naverApi, keys, stock);
    } else {
      try {
        data = await callNaver('hub', keys, stock);
        naverApi = 'hub';
      } catch (err) {
        if (err.status !== 401) throw err;
        try {
          data = await callNaver('legacy', keys, stock);
          naverApi = 'legacy';
        } catch (err2) {
          throw new Error(`${err.message} / ${err2.message}`);
        }
      }
    }
  } catch (err) {
    lastNewsError = `네이버 뉴스 오류: ${err.message}`;
    throw new Error(lastNewsError);
  }
  lastNewsError = null;
  return (data.items ?? [])
    .map(it => ({ ...it, link: it.originallink || it.link }))
    .filter(it => /^https?:\/\//.test(it.link))
    .map(it => ({
      type: 'news', code: stock.code, stockName: stock.name,
      title: plain(it.title), summary: plain(it.description),
      date: new Date(it.pubDate).toISOString(),
      source: publisher(it.link), url: it.link,
    }));
}

// 여러 종목의 소식을 모아 최신순으로. 일부 종목이 실패해도 나머지는 보여줌
export async function getFeed(stocks, { dartKey, naver }) {
  const newsEnabled = Boolean(naver?.id && naver?.secret);
  const disclosuresEnabled = Boolean(dartKey);
  const jobs = [];
  for (const s of stocks) {
    if (newsEnabled) jobs.push(cached(`news:${s.code}`, () => fetchNews(naver, s)));
    if (disclosuresEnabled && s.corpCode) jobs.push(cached(`disc:${s.code}`, () => fetchDisclosures(dartKey, s)));
  }
  const results = await Promise.allSettled(jobs);
  const failed = results.filter(r => r.status === 'rejected');
  for (const f of failed) console.error('[소식]', f.reason.message);
  const items = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
  const byDate = (a, b) => b.date.localeCompare(a.date);
  return {
    newsEnabled,
    disclosuresEnabled,
    partial: failed.length > 0,
    news: items.filter(i => i.type === 'news').sort(byDate),
    disclosures: items.filter(i => i.type === 'disclosure').sort(byDate),
  };
}

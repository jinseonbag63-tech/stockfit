// DART 고유번호 목록(상장사 전체)을 받아와서 검색할 수 있게 만드는 모듈
// - 서버가 켜질 때 한 번 받아서 data/corp-codes.json에 저장
// - 저장한 지 하루가 지나면 다시 받음
// - 키가 없거나 받기에 실패하면 기본 3종목으로 동작
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { FALLBACK_STOCKS, ALIASES } from './stocks.js';

const MAX_AGE = 24 * 60 * 60 * 1000;
let companies = FALLBACK_STOCKS;
let isFull = false;

// DART가 주는 파일은 zip이라서, 외부 라이브러리 없이 직접 풀어요
export function unzipFirstFile(buf) {
  // 1) 파일 끝에서 "중앙 디렉터리 끝" 표시(PK\x05\x06)를 찾음
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 형식이 아니에요');
  // 2) 중앙 디렉터리에서 첫 번째 파일 정보를 읽음
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('zip 목록을 읽지 못했어요');
  const method = buf.readUInt16LE(cd + 10);
  const compSize = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  // 3) 실제 데이터 위치로 가서 압축 해제
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + compSize);
  if (method === 0) return data;
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`지원하지 않는 압축 방식(${method})`);
}

// XML에서 상장사(종목코드가 있는 회사)만 골라냄
export function parseCorpXml(xml) {
  const tag = (block, name) => (block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)) || [])[1]?.trim() || '';
  const list = [];
  for (const m of xml.matchAll(/<list>([\s\S]*?)<\/list>/g)) {
    const code = tag(m[1], 'stock_code');
    if (!/^\w{6}$/.test(code)) continue; // 비상장 회사는 종목코드가 비어 있음
    list.push({ code, corpCode: tag(m[1], 'corp_code'), name: tag(m[1], 'corp_name'), engName: tag(m[1], 'corp_eng_name') });
  }
  return list;
}

async function download(key) {
  const res = await fetch(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${encodeURIComponent(key)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // 정상이면 zip(PK로 시작), 키 오류 등이면 오류 메시지가 옴
  if (buf.subarray(0, 2).toString() !== 'PK') {
    const msg = (buf.toString('utf8').match(/<message>(.*?)<\/message>/) || [])[1] || buf.toString('utf8').slice(0, 120);
    throw new Error(`고유번호 목록 다운로드 실패: ${msg}`);
  }
  return parseCorpXml(unzipFirstFile(buf).toString('utf8'));
}

export async function loadCompanies(key, dataDir) {
  if (!key) return { count: companies.length, full: false };
  const file = path.join(dataDir, 'corp-codes.json');
  try {
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Date.now() - saved.savedAt < MAX_AGE && saved.list?.length) {
        companies = saved.list; isFull = true;
        return { count: companies.length, full: true, from: '저장된 파일' };
      }
    }
    const list = await download(key);
    if (!list.length) throw new Error('목록이 비어 있어요');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ savedAt: Date.now(), list }));
    companies = list; isFull = true;
    return { count: list.length, full: true, from: 'DART에서 새로 받음' };
  } catch (err) {
    console.error('[고유번호 목록]', err.message, '→ 기본 3종목으로 동작해요.');
    return { count: companies.length, full: false, error: err.message };
  }
}

export const hasFullList = () => isFull;
export const getByCode = code => companies.find(c => c.code === code);

// 영문 약자를 한글 발음으로 바꿔서 비교 (SK텔레콤 = 에스케이텔레콤, KT = 케이티)
const READ = { a: '에이', b: '비', c: '씨', d: '디', e: '이', f: '에프', g: '지', h: '에이치', i: '아이', j: '제이',
  k: '케이', l: '엘', m: '엠', n: '엔', o: '오', p: '피', q: '큐', r: '알', s: '에스', t: '티', u: '유', v: '브이',
  w: '더블유', x: '엑스', y: '와이', z: '지' };
const norm = s => String(s || '').toLowerCase().replace(/[\s&.,()]/g, '').replace(/[a-z]/g, ch => READ[ch]);

// 검색 순위: 종목코드 일치 > 이름 일치 > 별명 > 이름으로 시작 > 이름 포함 > 영문 이름 포함
export function search(query, limit = 10) {
  const raw = String(query || '').trim();
  if (!raw) return [];
  const q = norm(ALIASES[raw] || raw);
  const qe = raw.toLowerCase().replace(/\s/g, '');
  const rank = c => {
    const n = norm(c.name);
    const e = (c.engName || '').toLowerCase().replace(/\s/g, '');
    if (c.code === q) return 0;
    if (n === q) return 1;
    if (n.startsWith(q)) return 2;
    if (n.includes(q)) return 3;
    if (qe.length >= 2 && e.includes(qe)) return 4;
    return -1;
  };
  return companies
    .map(c => ({ c, r: rank(c) }))
    .filter(x => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.c.name.length - b.c.name.length)
    .slice(0, limit)
    .map(x => x.c);
}

export const findStock = query => search(query, 1)[0] || null;

// 회원가입·로그인·세션 관리 (users, sessions, watchlist, email_tokens 테이블)
// - 비밀번호는 scrypt 해시로만 저장
// - 세션 토큰은 브라우저 쿠키에만 있고, DB에는 토큰의 해시값만 저장
// - DB는 src/db.js (Postgres 또는 SQLite), 모든 함수는 await
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { isUniqueViolation } from './db.js';
import { cleanAnswers } from '../public/survey.js';

const scrypt = promisify(crypto.scrypt);
export const SESSION_COOKIE = 'sf_session';
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 초 단위 (30일)
const MAX_FAILS = 5;                // 이 횟수만큼 틀리면
const LOCK_MS = 5 * 60 * 1000;      // 5분 동안 로그인 잠금
const MAX_WATCH = 50;
const TOKEN_TTL = { verify: 24 * 60 * 60 * 1000, reset: 30 * 60 * 1000 }; // 인증 24시간, 재설정 30분
const RESEND_GAP = 60 * 1000;       // 같은 메일은 1분에 한 번만

let db;
const fails = new Map(); // 이메일 → { count, until } 로그인 실패 기록

const fail = (status, message) => Object.assign(new Error(message), { status });
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const normEmail = e => String(e ?? '').trim().toLowerCase();
const now = () => new Date().toISOString();
const userById = id => db.get('SELECT * FROM users WHERE id = ?', [id]);

export async function initAuth(database) {
  db = database;
  await db.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
  await db.run('DELETE FROM email_tokens WHERE expires_at < ?', [Date.now()]);
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = await scrypt(password.normalize('NFC'), salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}
async function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const actual = Buffer.from((await hashPassword(password, salt)).split(':')[1], 'hex');
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}
// 없는 이메일로 로그인해도 같은 시간이 걸리게 해서, 가입 여부를 응답 속도로 알 수 없게 함
const DUMMY_HASH = hashPassword('stockfit-dummy-password');

// 투자성향 설문 답변 (public/survey.js 규칙으로 확인)
export const cleanProfile = cleanAnswers;
export function cleanWatchlist(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter(c => typeof c === 'string' && /^[0-9A-Z]{6}$/.test(c)))].slice(0, MAX_WATCH);
}

// 화면에 보내는 회원 정보 (비밀번호 해시 등은 빼고)
export async function publicUser(u) {
  const rows = await db.all('SELECT code FROM watchlist WHERE user_id = ? ORDER BY pos, added_at', [u.id]);
  return {
    email: u.email,
    name: u.name,
    emailVerified: Boolean(u.email_verified_at),
    profile: u.profile ? JSON.parse(u.profile) : null,
    watchlist: rows.map(r => r.code),
  };
}

function checkNewPassword(password) {
  password = typeof password === 'string' ? password : '';
  if (password.length < 8 || password.length > 72) throw fail(400, '비밀번호는 8~72자로 입력해주세요.');
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) throw fail(400, '비밀번호에 영문과 숫자를 모두 넣어주세요.');
  return password;
}

export async function signup({ email, password, name } = {}) {
  email = normEmail(email);
  name = String(name ?? '').trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, '이메일 형식을 확인해주세요.');
  if (!name || name.length > 20) throw fail(400, '닉네임은 1~20자로 입력해주세요.');
  password = checkNewPassword(password);
  if (await db.get('SELECT id FROM users WHERE email = ?', [email])) throw fail(409, '이미 가입된 이메일이에요. 로그인해주세요.');

  const passwordHash = await hashPassword(password);
  try {
    const { id } = await db.get('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?) RETURNING id',
      [email, name, passwordHash, now()]);
    return userById(id);
  } catch (err) {
    // 같은 이메일로 거의 동시에 가입한 경우 (DB의 UNIQUE 조건이 막아줌)
    if (isUniqueViolation(err)) throw fail(409, '이미 가입된 이메일이에요. 로그인해주세요.');
    throw err;
  }
}

export async function login({ email, password } = {}) {
  email = normEmail(email);
  const record = fails.get(email);
  if (record?.until > Date.now()) throw fail(429, '로그인을 여러 번 실패했어요. 5분 뒤에 다시 시도해주세요.');

  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  const ok = await checkPassword(typeof password === 'string' ? password : '', user?.password_hash ?? await DUMMY_HASH);
  if (!user || !ok) {
    if (fails.size > 10000) fails.clear();
    const count = (record?.count ?? 0) + 1;
    fails.set(email, count >= MAX_FAILS ? { count: 0, until: Date.now() + LOCK_MS } : { count, until: 0 });
    throw fail(401, '이메일 또는 비밀번호가 맞지 않아요.');
  }
  fails.delete(email);
  await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [now(), user.id]);
  return user;
}

export async function createSession(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.run('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
    [sha256(token), user.id, Date.now() + SESSION_MAX_AGE * 1000, now()]);
  return token;
}

export async function userFromToken(token) {
  if (!token) return null;
  const key = sha256(token);
  const s = await db.get('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?', [key]);
  if (!s) return null;
  if (s.expires_at < Date.now()) { await db.run('DELETE FROM sessions WHERE token_hash = ?', [key]); return null; }
  return (await userById(s.user_id)) ?? null;
}

export async function endSession(token) {
  if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
}

export const findUser = async email => (await db.get('SELECT * FROM users WHERE email = ?', [normEmail(email)])) ?? null;

// 메일 링크용 일회용 토큰 발급 (purpose: verify | reset)
// 1분 안에 또 요청하면 null → 메일이 연달아 가지 않게 막음
export async function issueEmailToken(user, purpose) {
  const last = (await db.get('SELECT MAX(created_at) AS at FROM email_tokens WHERE user_id = ? AND purpose = ?', [user.id, purpose]))?.at;
  if (last && Date.now() - last < RESEND_GAP) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  await db.tx(async t => {
    await t.run('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?', [user.id, purpose]); // 예전 링크는 무효
    await t.run('INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      [sha256(token), user.id, purpose, Date.now() + TOKEN_TTL[purpose], Date.now()]);
  });
  return token;
}

// 토큰을 한 번 쓰면 바로 지워서 같은 링크를 다시 못 쓰게 함
async function takeEmailToken(token, purpose) {
  const key = sha256(String(token ?? ''));
  const row = await db.get('SELECT user_id, expires_at FROM email_tokens WHERE token_hash = ? AND purpose = ?', [key, purpose]);
  if (row) await db.run('DELETE FROM email_tokens WHERE token_hash = ?', [key]);
  if (!row || row.expires_at < Date.now()) {
    throw fail(400, purpose === 'verify'
      ? '인증 링크가 만료됐거나 이미 사용됐어요. 로그인해서 인증 메일을 다시 받아주세요.'
      : '재설정 링크가 만료됐거나 이미 사용됐어요. 비밀번호 찾기를 다시 해주세요.');
  }
  return userById(row.user_id);
}

const setVerified = (q, id) => q.run('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?', [now(), id]);

export async function verifyEmail(token) {
  const user = await takeEmailToken(token, 'verify');
  await setVerified(db, user.id);
  return userById(user.id);
}

// 새 비밀번호 저장 + 모든 기기 로그아웃. 메일 링크로 들어왔으니 이메일 인증도 된 것으로 봄
export async function resetPassword(token, password) {
  password = checkNewPassword(password); // 토큰을 쓰기 전에 확인해야 비밀번호를 잘못 써도 링크가 살아 있음
  const user = await takeEmailToken(token, 'reset');
  const passwordHash = await hashPassword(password);
  await db.tx(async t => {
    await t.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, user.id]);
    await t.run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
    await setVerified(t, user.id);
  });
  fails.delete(user.email);
  return userById(user.id);
}

// 투자성향·관심종목 저장 (보낸 항목만 바꿈)
export async function updateUserData(user, { profile, watchlist } = {}) {
  const p = profile == null ? null : cleanProfile(profile);
  if (profile != null && !p) throw fail(400, '투자성향 값이 올바르지 않아요.');
  await db.tx(async t => {
    if (profile !== undefined) await t.run('UPDATE users SET profile = ? WHERE id = ?', [p ? JSON.stringify(p) : null, user.id]);
    if (watchlist !== undefined) {
      await t.run('DELETE FROM watchlist WHERE user_id = ?', [user.id]);
      const list = cleanWatchlist(watchlist);
      for (const [pos, code] of list.entries()) {
        await t.run('INSERT INTO watchlist (user_id, code, added_at, pos) VALUES (?, ?, ?, ?)', [user.id, code, now(), pos]);
      }
    }
  });
  return userById(user.id);
}

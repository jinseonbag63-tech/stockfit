// 데이터베이스
// - .env(또는 Render 환경 변수)에 DATABASE_URL이 있으면 Postgres (배포용: Neon, Supabase, Render Postgres 등)
// - 없으면 Node.js 내장 SQLite: data/stockfit.db 파일 하나 (내 컴퓨터에서 개발할 때, 설치 불필요)
// 두 가지를 같은 방식으로 쓰도록 감싼 작은 도구: db.all / db.get / db.run / db.tx (모두 await)
// SQL은 ? 자리표시자로 쓰면 Postgres에서는 $1, $2 ...로 바꿔줘요.
import fs from 'node:fs';
import path from 'node:path';

// SQLite용 테이블 정의 (예전 버전과 같은 구조)
const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT    NOT NULL,
    password_hash TEXT    NOT NULL,
    profile       TEXT,                 -- 투자성향 설문 답변 (JSON)
    created_at    TEXT    NOT NULL,
    last_login_at TEXT,
    email_verified_at TEXT              -- 이메일 인증한 시각 (안 했으면 NULL)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT    PRIMARY KEY,     -- 쿠키 토큰의 SHA-256 (토큰 원문은 저장 안 함)
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,        -- 밀리초
    created_at TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS watchlist (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code     TEXT    NOT NULL,          -- 종목코드 6자리
    added_at TEXT    NOT NULL,
    pos      INTEGER NOT NULL DEFAULT 0, -- 화면에 보여줄 순서
    PRIMARY KEY (user_id, code)
  );
  -- 메일 링크용 일회용 토큰 (이메일 인증, 비밀번호 재설정)
  CREATE TABLE IF NOT EXISTS email_tokens (
    token_hash TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose    TEXT    NOT NULL,        -- verify | reset
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens(user_id, purpose);
  -- 업종 비교용: 상장사별 업종 코드 (DART 기업개황)
  CREATE TABLE IF NOT EXISTS company_info (
    corp_code     TEXT    PRIMARY KEY,
    stock_code    TEXT    NOT NULL,
    industry_code TEXT,
    market        TEXT,
    updated_at    INTEGER NOT NULL
  );
  -- 업종 비교용: 상장사별 연간 재무 지표 (JSON)
  CREATE TABLE IF NOT EXISTS peer_metrics (
    corp_code  TEXT    NOT NULL,
    year       INTEGER NOT NULL,
    metrics    TEXT    NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (corp_code, year)
  );
`;

// Postgres용 테이블 정의 (이메일은 항상 소문자로 저장해서 대소문자 구분이 필요 없음)
const POSTGRES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    email         TEXT   NOT NULL UNIQUE,
    name          TEXT   NOT NULL,
    password_hash TEXT   NOT NULL,
    profile       TEXT,
    created_at    TEXT   NOT NULL,
    last_login_at TEXT,
    email_verified_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT  NOT NULL,
    created_at TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS watchlist (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code     TEXT    NOT NULL,
    added_at TEXT    NOT NULL,
    pos      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, code)
  );
  CREATE TABLE IF NOT EXISTS email_tokens (
    token_hash TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose    TEXT    NOT NULL,
    expires_at BIGINT  NOT NULL,
    created_at BIGINT  NOT NULL
  );
  CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens(user_id, purpose);
  CREATE TABLE IF NOT EXISTS company_info (
    corp_code     TEXT   PRIMARY KEY,
    stock_code    TEXT   NOT NULL,
    industry_code TEXT,
    market        TEXT,
    updated_at    BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS peer_metrics (
    corp_code  TEXT    NOT NULL,
    year       INTEGER NOT NULL,
    metrics    TEXT    NOT NULL,
    updated_at BIGINT  NOT NULL,
    PRIMARY KEY (corp_code, year)
  );
`;

async function openSqlite(dataDir) {
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(dataDir, { recursive: true });
  const raw = new DatabaseSync(path.join(dataDir, 'stockfit.db'));
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(SQLITE_SCHEMA);
  // 이전 버전에서 만든 DB에는 없는 칸 추가
  const cols = table => raw.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols('users').includes('email_verified_at')) raw.exec('ALTER TABLE users ADD COLUMN email_verified_at TEXT');
  if (!cols('watchlist').includes('pos')) raw.exec('ALTER TABLE watchlist ADD COLUMN pos INTEGER NOT NULL DEFAULT 0');

  const stmts = new Map();
  const prep = sql => { if (!stmts.has(sql)) stmts.set(sql, raw.prepare(sql)); return stmts.get(sql); };
  const api = {
    kind: 'sqlite',
    all: async (sql, params = []) => prep(sql).all(...params),
    get: async (sql, params = []) => prep(sql).get(...params),
    run: async (sql, params = []) => ({ changes: Number(prep(sql).run(...params).changes) }),
    // 여러 작업을 한 번에: 중간에 실패하면 전부 취소
    tx: async fn => {
      raw.exec('BEGIN');
      try { const r = await fn(api); raw.exec('COMMIT'); return r; }
      catch (err) { raw.exec('ROLLBACK'); throw err; }
    },
    close: async () => raw.close(),
  };
  return api;
}

async function openPostgres(url) {
  let pg;
  try { pg = (await import('pg')).default; }
  catch { throw new Error('Postgres 라이브러리가 없어요. 이 폴더에서 npm install 을 먼저 실행해주세요.'); }
  pg.types.setTypeParser(20, v => Number(v)); // BIGINT(밀리초 시각, COUNT)를 숫자로

  // 주소의 sslmode는 여기서 직접 처리 (pg가 주소의 sslmode=require를 보면 "앞으로 의미가 바뀐다"는 경고를 남겨서)
  const parsed = new URL(url);
  const sslmode = parsed.searchParams.get('sslmode');
  parsed.searchParams.delete('sslmode');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  // 클라우드 DB는 인증서까지 확인하는 암호화 연결. 확인이 안 되는 곳이면 DATABASE_SSL=no-verify
  const ssl = local || sslmode === 'disable' ? false
    : process.env.DATABASE_SSL === 'no-verify' ? { rejectUnauthorized: false } : true;
  const pool = new pg.Pool({ connectionString: parsed.toString(), ssl, max: Number(process.env.DATABASE_POOL_MAX) || 5 });
  pool.on('error', err => console.error('[DB]', err.message));

  // ? → $1, $2 ...
  const toPg = sql => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  const wrap = q => ({
    kind: 'postgres',
    all: async (sql, params = []) => (await q.query(toPg(sql), params)).rows,
    get: async (sql, params = []) => (await q.query(toPg(sql), params)).rows[0],
    run: async (sql, params = []) => ({ changes: (await q.query(toPg(sql), params)).rowCount }),
  });
  await pool.query(POSTGRES_SCHEMA);
  return {
    ...wrap(pool),
    tx: async fn => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await fn(wrap(client));
        await client.query('COMMIT');
        return r;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

let opened = null; // 여러 모듈이 같은 연결을 같이 씀

export async function openDb({ dataDir, url }) {
  opened ??= url ? openPostgres(url) : openSqlite(dataDir);
  return opened;
}

// 같은 값이 이미 있을 때 나는 오류인지 (SQLite / Postgres)
export const isUniqueViolation = err => err?.code === '23505' || /UNIQUE/.test(err?.message ?? '');

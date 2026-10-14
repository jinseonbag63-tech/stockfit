// 외부 API 결과 저장: 메모리 + DB(api_cache 테이블)
// Render 무료 플랜은 잠들면 메모리가 지워져서, DB에도 저장해 두고 깨어난 뒤 다시 받지 않게 해요.
let db;
const memory = new Map(); // key → { at, value }

export function initCache(database) { db = database; }

// key의 값이 ttl(밀리초)보다 새것이면 저장된 값을, 아니면 load()로 새로 받아 저장
// load가 실패하면 저장하지 않고 오류를 그대로 던져요
export async function cached(key, ttl, load) {
  const now = Date.now();
  const hit = memory.get(key);
  if (hit && now - hit.at < ttl) return hit.value;
  if (db) {
    const row = await db.get('SELECT value, updated_at FROM api_cache WHERE key = ?', [key]);
    if (row && now - Number(row.updated_at) < ttl) {
      const value = JSON.parse(row.value);
      memory.set(key, { at: Number(row.updated_at), value });
      return value;
    }
  }
  const value = await load();
  memory.set(key, { at: now, value });
  if (db) {
    await db.run(`INSERT INTO api_cache (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), now]).catch(err => console.error('[캐시 저장]', err.message));
  }
  return value;
}

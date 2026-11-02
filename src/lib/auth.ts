import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';

export type AuthKind = 'host' | 'player';
export interface AuthenticatedActor { kind: AuthKind; playerId?: string }

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function newSecret(): string { return randomBytes(24).toString('base64url'); }

export function newRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(6), value => alphabet[value % alphabet.length]).join('');
}

export function cookieName(code: string, kind: AuthKind): string {
  return `deadline_${kind}_${code}`;
}

export function issueCredential(db: Database.Database, code: string, kind: AuthKind, actorId: string, now = Date.now()): string {
  const token = newSecret();
  db.prepare(`INSERT INTO credentials (room_code, actor_kind, actor_id, token_hash, last_seen_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(room_code, actor_kind, actor_id)
    DO UPDATE SET token_hash = excluded.token_hash, last_seen_at = excluded.last_seen_at`).run(code, kind, actorId, hashSecret(token), now);
  return token;
}

export function authenticate(db: Database.Database, code: string, kind: AuthKind, token?: string, now = Date.now()): AuthenticatedActor | null {
  if (!token || token.length > 128) return null;
  const row = db.prepare(`SELECT actor_id, last_seen_at FROM credentials
    WHERE room_code = ? AND actor_kind = ? AND token_hash = ?`).get(code, kind, hashSecret(token)) as { actor_id: string; last_seen_at: number } | undefined;
  if (row && row.last_seen_at <= now - 10_000) db.prepare('UPDATE credentials SET last_seen_at = ? WHERE room_code = ? AND actor_kind = ? AND actor_id = ?').run(now, code, kind, row.actor_id);
  return row ? kind === 'host' ? { kind } : { kind, playerId: row.actor_id } : null;
}

export function createRecoveryCode(db: Database.Database, code: string, kind: AuthKind, actorId: string, expiresAt: number, singleUse: boolean): string {
  const recoveryCode = newSecret();
  db.prepare(`INSERT INTO recovery_codes (room_code, actor_kind, actor_id, code_hash, expires_at, single_use)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(room_code, actor_kind, actor_id)
    DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, single_use = excluded.single_use`)
    .run(code, kind, actorId, hashSecret(recoveryCode), expiresAt, singleUse ? 1 : 0);
  return recoveryCode;
}

export function redeemRecoveryCode(db: Database.Database, code: string, kind: AuthKind, recoveryCode: string, now: number): { actorId: string; token: string } | null {
  if (!recoveryCode || recoveryCode.length > 128) return null;
  const row = db.prepare(`SELECT actor_id, single_use FROM recovery_codes
    WHERE room_code = ? AND actor_kind = ? AND code_hash = ? AND expires_at > ?`)
    .get(code, kind, hashSecret(recoveryCode), now) as { actor_id: string; single_use: number } | undefined;
  if (!row) return null;
  if (row.single_use) db.prepare('DELETE FROM recovery_codes WHERE room_code = ? AND actor_kind = ? AND actor_id = ?').run(code, kind, row.actor_id);
  return { actorId: row.actor_id, token: issueCredential(db, code, kind, row.actor_id, now) };
}

export function matchesSecret(received: string | null, expected: string): boolean {
  if (!received || received.length > 128) return false;
  return timingSafeEqual(Buffer.from(hashSecret(received)), Buffer.from(hashSecret(expected)));
}

export function fingerprint(value: unknown): string {
  const stable = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(stable);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, stable(val)]));
    return item;
  };
  return hashSecret(JSON.stringify(stable(value)));
}

import { randomInt, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { advanceTo, applyCommand, canStartRoom, createRoom, getRoster, getSnapshot, joinRoom } from './engine';
import { getScenario, isScenarioVersion } from './scenario';
import type { Actor, Command, LeaveResult, LobbySnapshot, RoomMode, RoomState, Snapshot, TeamSize } from './types';
import { DomainError } from './types';
import { authenticate, createRecoveryCode, fingerprint, issueCredential, matchesSecret, newRoomCode, newSecret, redeemRecoveryCode, type AuthKind } from './auth';
import { getDatabase, readStoredRoom, saveRoom, type StoredRoom } from './db';
import { HttpError, roomCode } from './http';

const DAY = 24 * 60 * 60 * 1000;
export type View = 'host' | 'player' | 'projector';
export interface HostLinks { projectorToken: string; joinUrl: string; projectorUrl: string }
export type RoomSnapshot = Snapshot & { host?: HostLinks };
export type ServiceCommandResult = RoomSnapshot | LeaveResult;

function textField(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) throw new HttpError(400, 'invalid_input', `${label} must contain 1–${maximum} characters.`);
  return value.trim();
}

function stored(db: Database.Database, code: string, now: number): StoredRoom {
  const record = readStoredRoom(db, code);
  if (!record) throw new HttpError(404, 'room_not_found', 'This room code was not found.');
  const state: unknown = JSON.parse(record.state_json);
  if (!state || typeof state !== 'object' || !('version' in state) || state.version !== 2 || !('scenarioVersion' in state) || !isScenarioVersion(state.scenarioVersion)) throw new HttpError(409, 'game_updated', 'This game has been updated. Create a new room to play.');
  if (record.expires_at <= now) throw new HttpError(410, 'room_expired', 'This room has expired. Create a new room to play again.');
  return record;
}

function reconcile(db: Database.Database, record: StoredRoom, now: number): StoredRoom {
  const state = advanceTo(JSON.parse(record.state_json) as RoomState, now);
  const json = JSON.stringify(state);
  if (json !== record.state_json) saveRoom(db, record.code, state);
  return { ...record, state_json: json };
}

function actorFor(db: Database.Database, code: string, kind: AuthKind, token: string | undefined, now: number): Actor {
  const actor = authenticate(db, code, kind, token, now);
  if (!actor) throw new HttpError(401, 'authentication_required', kind === 'host' ? 'Host access is required. Recover your host access if needed.' : 'Join this room or recover your player seat first.');
  return actor.kind === 'host' ? { kind: 'host' } : { kind: 'player', playerId: actor.playerId! };
}

function presence(db: Database.Database, code: string, now: number): Map<string, { connected: boolean; lastSeenAt: number }> {
  const rows = db.prepare(`SELECT actor_id, last_seen_at FROM credentials WHERE room_code = ? AND actor_kind = 'player'`).all(code) as { actor_id: string; last_seen_at: number }[];
  return new Map(rows.map(row => [row.actor_id, { connected: now - row.last_seen_at < 20_000, lastSeenAt: row.last_seen_at }]));
}

function projection(db: Database.Database, record: StoredRoom, actor: Actor, origin: string, now: number): RoomSnapshot {
  const state = JSON.parse(record.state_json) as RoomState;
  const snapshot: RoomSnapshot = getSnapshot(state, actor, now);
  const active = presence(db, record.code, now);
  for (const team of snapshot.teams) for (const seat of team.seats) if (seat.player) Object.assign(seat.player, active.get(seat.player.id) ?? { connected: false, lastSeenAt: null });
  if (actor.kind === 'host') snapshot.host = {
    projectorToken: record.projector_token,
    joinUrl: `${origin}/join/${record.code}`,
    projectorUrl: `${origin}/projector/${record.code}?token=${encodeURIComponent(record.projector_token)}`,
  };
  return snapshot;
}

export function createSession(input: Record<string, unknown>, now = Date.now()): { code: string; recoveryCode: string; projectorToken: string; token: string; expiresAt: number } {
  const mode = input.mode as RoomMode;
  if (mode !== 'coop' && mode !== 'competition') throw new HttpError(400, 'invalid_mode', 'Choose cooperative or team competition mode.');
  if (input.rosterMode !== undefined && input.rosterMode !== 'flexible') throw new HttpError(400, 'invalid_roster_mode', 'Choose a supported team roster mode.');
  const flexible = input.rosterMode === 'flexible';
  let rawTeams: unknown = input.teams;
  if (rawTeams === undefined) {
    const count = input.teamCount ?? (mode === 'coop' ? 1 : 2);
    const size = input.teamSize ?? 4;
    if (!Number.isInteger(count) || Number(count) < 1 || Number(count) > 10) throw new HttpError(400, 'invalid_teams', 'Choose between one and ten teams.');
    rawTeams = Array.from({ length: Number(count) }, (_, index) => ({ name: `Team ${index + 1}`, size }));
  }
  if (!Array.isArray(rawTeams) || rawTeams.length < (mode === 'coop' ? 1 : 2) || rawTeams.length > (mode === 'coop' ? 1 : 10)) throw new HttpError(400, 'invalid_teams', mode === 'coop' ? 'Cooperative mode uses one team.' : 'Competition mode needs two to ten teams.');
  const teams = rawTeams.map((raw: unknown, index: number) => {
    if (!raw || typeof raw !== 'object') throw new HttpError(400, 'invalid_team', 'Each team needs a name and a size.');
    const team = raw as Record<string, unknown>;
    const name = textField(team.name, 'Team name', 32);
    const size = flexible ? 5 : team.size;
    if (size !== 2 && size !== 3 && size !== 4 && size !== 5) throw new HttpError(400, 'invalid_team_size', 'Each team must have two, three, four or five seats.');
    return { id: `team-${index + 1}`, name, size: size as TeamSize };
  });
  if (new Set(teams.map(team => team.name.toLowerCase())).size !== teams.length) throw new HttpError(400, 'duplicate_team_name', 'Use a different name for each team.');
  const db = getDatabase();
  return db.transaction(() => {
    let code = newRoomCode();
    while (readStoredRoom(db, code)) code = newRoomCode();
    const expiresAt = now + DAY;
    const state = createRoom({ code, mode, teams, expiresAt, ...(flexible ? { rosterMode: 'flexible' as const } : {}) }, now);
    const projectorToken = newSecret();
    db.prepare('INSERT INTO rooms (code, state_json, created_at, expires_at, projector_token) VALUES (?, ?, ?, ?, ?)').run(code, JSON.stringify(state), now, expiresAt, projectorToken);
    const token = issueCredential(db, code, 'host', 'host', now);
    const recoveryCode = createRecoveryCode(db, code, 'host', 'host', expiresAt, false);
    return { code, recoveryCode, projectorToken, token, expiresAt };
  }).immediate();
}

export function getLobby(rawCode: string, now = Date.now()): LobbySnapshot {
  const code = roomCode(rawCode);
  const db = getDatabase();
  const record = stored(db, code, now);
  const state = JSON.parse(record.state_json) as RoomState;
  const active = presence(db, code, now);
  return {
    code, mode: state.mode, status: state.status, rosterMode: state.rosterMode ?? 'fixed', canStart: canStartRoom(state), currency: getScenario(state.scenarioVersion).currency,
    teams: getRoster(state).map(team => ({ ...team, seats: team.seats.map(seat => ({ ...seat,
      player: seat.player ? { ...seat.player, ...(active.get(seat.player.id) ?? { connected: false, lastSeenAt: null }) } : null,
    })) })),
  };
}

export function joinSession(rawCode: string, input: Record<string, unknown>, existingToken?: string, now = Date.now()) {
  const code = roomCode(rawCode);
  const nickname = textField(input.nickname, 'Nickname', 24);
  const teamId = textField(input.teamId, 'Team', 64);
  if (input.seatIndex !== undefined && (!Number.isInteger(input.seatIndex) || Number(input.seatIndex) < 0 || Number(input.seatIndex) > 4)) throw new HttpError(400, 'invalid_seat', 'Choose an available seat.');
  const db = getDatabase();
  return db.transaction(() => {
    const record = stored(db, code, now);
    if (authenticate(db, code, 'player', existingToken, now)) throw new HttpError(409, 'already_joined', 'This browser already has a player seat in this room.');
    const state = JSON.parse(record.state_json) as RoomState;
    const playerId = randomUUID();
    saveRoom(db, code, joinRoom(state, { nickname, teamId, ...(input.seatIndex === undefined ? {} : { seatIndex: Number(input.seatIndex) }), playerId }, now));
    const token = issueCredential(db, code, 'player', playerId, now);
    return { playerId, token, expiresAt: record.expires_at };
  }).immediate();
}

export function getState(rawCode: string, view: View, token: string | undefined, origin: string, at?: number): RoomSnapshot {
  const code = roomCode(rawCode);
  const db = getDatabase();
  return db.transaction(() => {
    const now = at ?? Date.now();
    const record = stored(db, code, now);
    let actor: Actor;
    if (view === 'projector') {
      if (!matchesSecret(token ?? null, record.projector_token)) throw new HttpError(401, 'projector_access_required', 'Use the projector link supplied by the host.');
      actor = { kind: 'projector' };
    } else actor = actorFor(db, code, view, token, now);
    return projection(db, reconcile(db, record, now), actor, origin, now);
  }).immediate();
}

export function validateCommand(input: Record<string, unknown>): Command {
  if (typeof input.actionId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.actionId)) throw new HttpError(400, 'invalid_action_id', 'A unique action identifier is required.');
  const types = ['start', 'pause', 'resume', 'end', 'vote', 'remove_player', 'remove_team', 'change_team', 'leave'];
  if (typeof input.type !== 'string' || !types.includes(input.type)) throw new HttpError(400, 'invalid_command', 'This game action is not recognised.');
  if (input.round !== undefined && (!Number.isInteger(input.round) || Number(input.round) < 0 || Number(input.round) > 5)) throw new HttpError(400, 'invalid_round', 'The round number is invalid.');
  if (input.phase !== undefined && (typeof input.phase !== 'string' || !['lobby', 'decision', 'reveal', 'finished', 'ended', 'expired'].includes(input.phase))) throw new HttpError(400, 'invalid_phase', 'The game phase is invalid.');
  const command = { type: input.type, actionId: input.actionId,
    ...(input.round === undefined ? {} : { round: input.round }),
    ...(input.phase === undefined ? {} : { phase: input.phase }),
  };
  if (input.type === 'vote') {
    if (typeof input.choice !== 'string' || !['A', 'B', 'pass'].includes(input.choice)) throw new HttpError(400, 'invalid_choice', 'Choose option A, option B or Pass.');
    if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 1) throw new HttpError(400, 'invalid_revision', 'A positive vote revision is required.');
    return { ...command, choice: input.choice, revision: input.revision } as Command;
  }
  if (input.type === 'remove_player') return { ...command, playerId: textField(input.playerId, 'Player', 80) } as Command;
  if (input.type === 'remove_team') return { ...command, teamId: textField(input.teamId, 'Team', 80) } as Command;
  if (input.type === 'change_team' || input.type === 'leave') {
    const expectedPlayerId = textField(input.expectedPlayerId, 'Expected player', 80);
    return input.type === 'change_team'
      ? { ...command, expectedPlayerId, teamId: textField(input.teamId, 'Team', 80) } as Command
      : { ...command, expectedPlayerId } as Command;
  }
  return command as Command;
}

export function executeCommand(rawCode: string, kind: AuthKind, token: string | undefined, input: Record<string, unknown>, origin: string, at?: number): ServiceCommandResult {
  const code = roomCode(rawCode);
  const db = getDatabase();
  const outcome = db.transaction((): { result: ServiceCommandResult } | { error: HttpError | DomainError } => {
    const now = at ?? Date.now();
    let record = stored(db, code, now);
    const actor = actorFor(db, code, kind, token, now);
    record = reconcile(db, record, now);
    const actorKey = actor.kind === 'player' ? `player:${actor.playerId}` : 'host';
    let command: Command;
    let requestHash: string;
    let state: RoomState;
    try {
      command = validateCommand(input);
      requestHash = fingerprint(command);
      const receipt = db.prepare('SELECT request_hash FROM command_receipts WHERE room_code = ? AND actor_key = ? AND action_id = ?').get(code, actorKey, command.actionId) as { request_hash: string } | undefined;
      if (receipt) {
        if (receipt.request_hash !== requestHash) throw new HttpError(409, 'action_id_reused', 'This action identifier has already been used for a different action.');
        return { result: command.type === 'leave' ? { left: true } : projection(db, record, actor, origin, now) };
      }
      const draws = command.type === 'start' && actor.kind === 'host' ? Array.from({ length: 5 }, () => randomInt(100)) : undefined;
      state = applyCommand(JSON.parse(record.state_json) as RoomState, actor, command, now, draws);
    } catch (error) {
      // Deadline transitions must commit even when a late or stale action is rejected.
      if (error instanceof HttpError || error instanceof DomainError) return { error };
      throw error;
    }
    saveRoom(db, code, state);
    const removedPlayerId = command.type === 'remove_player' ? command.playerId : command.type === 'leave' && actor.kind === 'player' ? actor.playerId : null;
    if (removedPlayerId) {
      db.prepare("DELETE FROM credentials WHERE room_code = ? AND actor_kind = 'player' AND actor_id = ?").run(code, removedPlayerId);
      db.prepare("DELETE FROM recovery_codes WHERE room_code = ? AND actor_kind = 'player' AND actor_id = ?").run(code, removedPlayerId);
    }
    db.prepare('INSERT INTO command_receipts (room_code, actor_key, action_id, request_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(code, actorKey, command.actionId, requestHash, now);
    return { result: command.type === 'leave' ? { left: true } : projection(db, { ...record, state_json: JSON.stringify(state) }, actor, origin, now) };
  }).immediate();
  if ('error' in outcome) throw outcome.error;
  return outcome.result;
}

export function recoverSession(rawCode: string, input: Record<string, unknown>, now = Date.now()) {
  const code = roomCode(rawCode);
  if (input.kind !== 'host' && input.kind !== 'player') throw new HttpError(400, 'invalid_recovery_kind', 'Choose host or player recovery.');
  const kind: AuthKind = input.kind;
  const recoveryCode = textField(input.recoveryCode, 'Recovery code', 128);
  const db = getDatabase();
  return db.transaction(() => {
    const record = stored(db, code, now);
    const recovered = redeemRecoveryCode(db, code, kind, recoveryCode, now);
    if (!recovered) throw new HttpError(401, 'invalid_recovery_code', 'This recovery code is invalid, expired or has already been used.');
    return { kind, token: recovered.token, expiresAt: record.expires_at };
  }).immediate();
}

export function reissuePlayer(rawCode: string, hostToken: string | undefined, input: Record<string, unknown>, now = Date.now()) {
  const code = roomCode(rawCode);
  const playerId = textField(input.playerId, 'Player', 80);
  const db = getDatabase();
  return db.transaction(() => {
    const record = stored(db, code, now);
    actorFor(db, code, 'host', hostToken, now);
    const state = JSON.parse(record.state_json) as RoomState;
    if (!state.players.some(player => player.id === playerId)) throw new HttpError(404, 'player_not_found', 'This player seat was not found.');
    db.prepare("DELETE FROM credentials WHERE room_code = ? AND actor_kind = 'player' AND actor_id = ?").run(code, playerId);
    return { recoveryCode: createRecoveryCode(db, code, 'player', playerId, Math.min(record.expires_at, now + 15 * 60_000), true) };
  }).immediate();
}

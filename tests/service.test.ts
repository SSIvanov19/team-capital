import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabases, getDatabase, readStoredRoom } from '../src/lib/db';
import { authenticate, cookieName, createRecoveryCode, hashSecret } from '../src/lib/auth';
import { baseUrl } from '../src/lib/http';
import { createSession, executeCommand as executeRawCommand, getLobby, getState, joinSession, recoverSession, reissuePlayer, type RoomSnapshot } from '../src/lib/service';
import type { Choice, RoomState } from '../src/lib/types';
import { advanceTo, getSnapshot } from '../src/lib/engine';
import { getClues, getDeal } from '../src/lib/scenario';
import { NextRequest } from 'next/server';
import { POST as createRoute } from '../src/app/api/rooms/route';
import { POST as joinRoute } from '../src/app/api/rooms/[code]/join/route';
import { GET as stateRoute } from '../src/app/api/rooms/[code]/state/route';
import { POST as commandRoute } from '../src/app/api/rooms/[code]/commands/route';

const NOW = 1_800_000_000_000;
const ORIGIN = 'http://localhost:3000';
function executeCommand(...args: Parameters<typeof executeRawCommand>): RoomSnapshot {
  const result = executeRawCommand(...args);
  if ('left' in result) throw new Error('This test expected a room snapshot, not a leave acknowledgement.');
  return result;
}
let directory: string;
let oldPath: string | undefined;
let oldUrl: string | undefined;

beforeEach(() => {
  closeDatabases();
  directory = mkdtempSync(path.join(os.tmpdir(), 'deadline-service-'));
  oldPath = process.env.DATABASE_PATH;
  oldUrl = process.env.APP_URL;
  process.env.DATABASE_PATH = path.join(directory, 'game.sqlite');
  delete process.env.APP_URL;
});
afterEach(() => {
  closeDatabases();
  if (oldPath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = oldPath;
  if (oldUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = oldUrl;
  rmSync(directory, { recursive: true, force: true });
});

function filledRoom(size: 2 | 3 | 4 | 5 = 3, count = 1) {
  const host = createSession({ mode: count === 1 ? 'coop' : 'competition', teams: Array.from({ length: count }, (_, i) => ({ name: `Team ${i + 1}`, size })) }, NOW);
  const players = Array.from({ length: size * count }, (_, index) => joinSession(host.code, { nickname: `Player ${index + 1}`, teamId: `team-${Math.floor(index / size) + 1}`, seatIndex: index % size }, undefined, NOW));
  executeCommand(host.code, 'host', host.token, { type: 'start', actionId: 'start-round-1' }, ORIGIN, NOW);
  return { host, players };
}
function rawRoom(code: string): RoomState { return JSON.parse(readStoredRoom(getDatabase(), code)!.state_json) as RoomState; }
function ballot(choice: Choice, revision = 1, actionId = `vote-${choice}-revision-${revision}`, round = 1) {
  return { type: 'vote', actionId, round, phase: 'decision', choice, revision };
}

function post(url: string, body: unknown, cookie?: string, origin = ORIGIN) {
  return new NextRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
}

describe('persistent multiplayer service v2', () => {
  it.each([2, 3, 4, 5] as const)('joins %s distinct seats with the same complete five-clue role set', size => {
    const host = createSession({ mode: 'coop', teams: [{ name: 'Team', size }] }, NOW);
    expect(rawRoom(host.code).draws).toEqual([]);
    for (let seatIndex = 0; seatIndex < size; seatIndex++) joinSession(host.code, { nickname: `Seat ${seatIndex}`, teamId: 'team-1', seatIndex }, undefined, NOW);
    const lobby = getLobby(host.code, NOW);
    expect(lobby.teams[0].seats.filter(seat => seat.player)).toHaveLength(size);
    expect(lobby.teams[0].seats.flatMap(seat => seat.roles).sort()).toEqual(['accountant', 'analyst', 'coordinator', 'developer', 'operations']);
    expect(() => joinSession(host.code, { nickname: 'Extra', teamId: 'team-1', seatIndex: 0 }, undefined, NOW)).toThrow();
    expect(JSON.stringify(lobby)).not.toMatch(/privateClues|draws|projectorToken|recoveryCode|votes/);
  });

  it('enforces named-team configuration and keeps host and player credentials separate', () => {
    expect(() => createSession({ mode: 'coop', teamCount: 2, teamSize: 3 }, NOW)).toThrow();
    expect(() => createSession({ mode: 'competition', teams: [{ name: 'Only', size: 3 }] }, NOW)).toThrow();
    expect(() => createSession({ mode: 'competition', teams: [{ name: 'same', size: 3 }, { name: 'SAME', size: 5 }] }, NOW)).toThrow();
    const host = createSession({ mode: 'coop', teams: [{ name: 'Our team', size: 3 }] }, NOW);
    const player = joinSession(host.code, { nickname: 'Hosting player', teamId: 'team-1', seatIndex: 0 }, undefined, NOW);
    expect(authenticate(getDatabase(), host.code, 'host', host.token, NOW)?.kind).toBe('host');
    expect(authenticate(getDatabase(), host.code, 'player', player.token, NOW)?.playerId).toBe(player.playerId);
    expect(authenticate(getDatabase(), host.code, 'host', player.token, NOW)).toBeNull();
    expect(cookieName(host.code, 'host')).not.toBe(cookieName(host.code, 'player'));
    expect(() => joinSession(host.code, { nickname: 'Second seat', teamId: 'team-1', seatIndex: 1 }, player.token, NOW)).toThrow();
  });

  it('generates five bounded private draws only at start and never accepts client draws', () => {
    const host = createSession({ mode: 'coop', teamCount: 1, teamSize: 3 }, NOW);
    for (let seatIndex = 0; seatIndex < 3; seatIndex++) joinSession(host.code, { nickname: `P${seatIndex}`, teamId: 'team-1', seatIndex }, undefined, NOW);
    const command = { type: 'start', actionId: 'start-private-draws', draws: [999, 999, 999, 999, 999], seed: 'client-seed' };
    executeCommand(host.code, 'host', host.token, command, ORIGIN, NOW);
    const draws = rawRoom(host.code).draws;
    expect(draws).toHaveLength(5);
    expect(draws.every(value => Number.isInteger(value) && value >= 0 && value < 100)).toBe(true);
    executeCommand(host.code, 'host', host.token, command, ORIGIN, NOW + 1);
    expect(rawRoom(host.code).draws).toEqual(draws);
    closeDatabases();
    expect(rawRoom(host.code).draws).toEqual(draws);
  });

  it('exposes only assigned current clues and each player’s own editable ballot', () => {
    const { host, players } = filledRoom();
    executeCommand(host.code, 'player', players[0].token, ballot('A'), ORIGIN, NOW + 1);
    executeCommand(host.code, 'player', players[1].token, ballot('B'), ORIGIN, NOW + 2);
    const first = getState(host.code, 'player', players[0].token, ORIGIN, NOW + 3);
    const second = getState(host.code, 'player', players[1].token, ORIGIN, NOW + 3);
    expect(first.privateClues.map(clue => clue.role).sort()).toEqual(['accountant', 'analyst']);
    expect(second.privateClues.map(clue => clue.role)).toEqual(['developer']);
    expect(first.myVote?.choice).toBe('A');
    expect(first.team?.votesSubmitted).toBe(2);
    expect(JSON.stringify(first)).not.toContain('"choice":"B"');
    for (const clue of second.privateClues) expect(JSON.stringify(first)).not.toContain(clue.text);
    const future = getSnapshot(advanceTo(rawRoom(host.code), NOW + 75_000), { kind: 'player', playerId: players[0].playerId }, NOW + 75_000);
    for (const clue of future.privateClues) expect(JSON.stringify(first)).not.toContain(clue.text);
    for (const view of ['host', 'projector'] as const) {
      const snapshot = getState(host.code, view, view === 'host' ? host.token : host.projectorToken, ORIGIN, NOW + 3);
      expect(snapshot.privateClues).toEqual([]);
      expect(snapshot.myVote).toBeNull();
      expect(snapshot.team).toBeNull();
      expect(snapshot.currentReveal).toBeNull();
      expect(JSON.stringify(snapshot)).not.toMatch(/"draws"|"seed"|"choice"|"votes"/);
    }
    expect(JSON.stringify(first)).not.toMatch(/"draws"|"seed"|"votes"/);
    expect(() => getState(host.code, 'host', host.projectorToken, ORIGIN, NOW)).toThrow();
    expect(() => getState(host.code, 'player', host.projectorToken, ORIGIN, NOW)).toThrow();
  });

  it('keeps the newest vote when old receipts or out-of-order revisions arrive', () => {
    const { host, players } = filledRoom();
    const first = ballot('A', 1);
    const second = ballot('B', 2);
    executeCommand(host.code, 'player', players[0].token, first, ORIGIN, NOW + 1);
    expect(() => executeCommand(host.code, 'player', players[0].token, ballot('pass', 3), ORIGIN, NOW + 2)).toThrow();
    executeCommand(host.code, 'player', players[0].token, second, ORIGIN, NOW + 3);
    const replay = executeCommand(host.code, 'player', players[0].token, first, ORIGIN, NOW + 4);
    expect(replay.myVote).toMatchObject({ choice: 'B', revision: 2 });
    expect(() => executeCommand(host.code, 'player', players[0].token, { ...first, choice: 'pass' }, ORIGIN, NOW + 5)).toThrow();
    expect(() => executeCommand(host.code, 'player', players[0].token, ballot('pass', 1, 'stale-new-action'), ORIGIN, NOW + 6)).toThrow();
    expect(rawRoom(host.code).teams[0].votes[1]?.[players[0].playerId]).toMatchObject({ choice: 'B', revision: 2 });
    const receipts = getDatabase().prepare("SELECT COUNT(*) AS count FROM command_receipts WHERE actor_key LIKE 'player:%'").get() as { count: number };
    expect(receipts.count).toBe(2);
  });

  it('settles a boundary once under simultaneous snapshots and preserves one common event across teams', async () => {
    const { host, players } = filledRoom(3, 2);
    for (const player of players.slice(0, 2)) executeCommand(host.code, 'player', player.token, ballot('A'), ORIGIN, NOW + 1);
    for (const player of players.slice(3, 5)) executeCommand(host.code, 'player', player.token, ballot('B'), ORIGIN, NOW + 1);
    await Promise.all(Array.from({ length: 20 }, async (_, i) => getState(host.code, i % 2 ? 'host' : 'projector', i % 2 ? host.token : host.projectorToken, ORIGIN, NOW + 60_000)));
    const state = rawRoom(host.code);
    expect(state.teams.map(team => team.results.length)).toEqual([1, 1]);
    const [first, second] = state.teams.map(team => team.results[0]);
    expect(first.eventId).toBe(second.eventId);
    expect(first.counterfactuals).toEqual(second.counterfactuals);
    expect(first.choice).toBe('A');
    expect(second.choice).toBe('B');
    expect(first.balanceAfter).toBe(10_000 + first.counterfactuals.A);
    expect(second.balanceAfter).toBe(10_000 + second.counterfactuals.B);
    expect(first.settledAt).toBe(NOW + 60_000);
    getState(host.code, 'host', host.token, ORIGIN, NOW + 60_001);
    expect(rawRoom(host.code).teams.map(team => team.results.length)).toEqual([1, 1]);
  });

  it('commits automatic settlement before rejecting late, malformed or receipt-conflicting votes', () => {
    const { host, players } = filledRoom();
    const first = ballot('A');
    executeCommand(host.code, 'player', players[0].token, first, ORIGIN, NOW + 1);
    executeCommand(host.code, 'player', players[1].token, ballot('A'), ORIGIN, NOW + 2);
    expect(() => executeCommand(host.code, 'player', players[0].token, ballot('B', 2), ORIGIN, NOW + 60_000)).toThrow();
    expect(rawRoom(host.code).teams[0].results).toHaveLength(1);
    expect(rawRoom(host.code).teams[0].results[0].choice).toBe('A');
    expect(() => executeCommand(host.code, 'player', players[0].token, { ...first, choice: 'B' }, ORIGIN, NOW + 135_000)).toThrow();
    expect(rawRoom(host.code).teams[0].results).toHaveLength(2);
    expect(() => executeCommand(host.code, 'player', players[0].token, { type: 'vote', actionId: 'invalid-vote-input', choice: 'invalid' }, ORIGIN, NOW + 210_000)).toThrow();
    expect(rawRoom(host.code).teams[0].results).toHaveLength(3);
    const replay = executeCommand(host.code, 'player', players[0].token, first, ORIGIN, NOW + 300_000);
    expect(replay.round).toBe(5);
    expect(replay.myVote).toBeNull();
    expect(rawRoom(host.code).teams[0].results).toHaveLength(4);
  });

  it('catches up idle time using scheduled deadlines and finishes after the fifth result interval', () => {
    const { host } = filledRoom();
    const first = getState(host.code, 'host', host.token, ORIGIN, NOW + 75_123);
    expect(first.round).toBe(2);
    expect(first.phase).toBe('decision');
    expect(first.remainingMs).toBe(59_877);
    closeDatabases();
    const finalResult = getState(host.code, 'host', host.token, ORIGIN, NOW + 360_000);
    expect(finalResult.round).toBe(5);
    expect(finalResult.phase).toBe('reveal');
    expect(finalResult.teams[0].results).toHaveLength(5);
    const finished = getState(host.code, 'host', host.token, ORIGIN, NOW + 375_000);
    expect(finished.phase).toBe('finished');
    expect(finished.teams[0].balance).toBe(10_000);
    expect(finished.teams[0].results.map(result => result.settledAt)).toEqual([60_000, 135_000, 210_000, 285_000, 360_000].map(offset => NOW + offset));
    expect(finished.teams[0].results.every(result => result.selectionReason === 'no_quorum' && result.choice === 'pass')).toBe(true);
  });

  it.each([2, 3, 4, 5] as const)('counts submitted Pass votes toward quorum for %s seats but does not count missing votes', size => {
    const { host, players } = filledRoom(size);
    const quorum = Math.max(2, Math.ceil(size / 2));
    for (const player of players.slice(0, quorum - 1)) executeCommand(host.code, 'player', player.token, ballot('A'), ORIGIN, NOW + 1);
    const first = getState(host.code, 'host', host.token, ORIGIN, NOW + 60_000).teams[0].results[0];
    expect(first.selectionReason).toBe('no_quorum');
    expect(first.submittedVotes).toBe(quorum - 1);
    expect(first.voteCounts.pass).toBe(0);
    getState(host.code, 'host', host.token, ORIGIN, NOW + 75_000);
    for (const player of players.slice(0, quorum)) executeCommand(host.code, 'player', player.token, ballot('pass', 1, 'round-two-pass', 2), ORIGIN, NOW + 75_001);
    const second = getState(host.code, 'host', host.token, ORIGIN, NOW + 135_000).teams[0].results[1];
    expect(second.selectionReason).toBe('plurality');
    expect(second.submittedVotes).toBe(quorum);
    expect(second.voteCounts.pass).toBe(quorum);
    expect(second.choice).toBe('pass');
  });

  it('pauses deadlines across restart and does not replay an old pause after resuming', () => {
    const { host, players } = filledRoom();
    const pause = { type: 'pause', actionId: 'host-pause-retry', round: 1, phase: 'decision' };
    executeCommand(host.code, 'host', host.token, pause, ORIGIN, NOW + 10_000);
    const draws = rawRoom(host.code).draws;
    closeDatabases();
    const paused = getState(host.code, 'player', players[0].token, ORIGIN, NOW + 180_000);
    expect(paused.paused).toBe(true);
    expect(paused.remainingMs).toBe(50_000);
    expect(paused.teams[0].results).toEqual([]);
    executeCommand(host.code, 'host', host.token, { type: 'resume', actionId: 'host-resume-new', round: 1, phase: 'decision' }, ORIGIN, NOW + 200_000);
    const replay = executeCommand(host.code, 'host', host.token, pause, ORIGIN, NOW + 205_000);
    expect(replay.paused).toBe(false);
    expect(replay.remainingMs).toBe(45_000);
    expect(getState(host.code, 'host', host.token, ORIGIN, NOW + 250_000).phase).toBe('reveal');
    expect(rawRoom(host.code).draws).toEqual(draws);
  });

  it('authenticates before reconciliation and binds all capability types to their room', () => {
    const first = filledRoom();
    const second = filledRoom();
    expect(() => getState(second.host.code, 'host', first.host.token, ORIGIN, NOW + 60_000)).toThrow();
    expect(() => getState(second.host.code, 'player', first.players[0].token, ORIGIN, NOW + 60_000)).toThrow();
    expect(() => getState(second.host.code, 'projector', first.host.projectorToken, ORIGIN, NOW + 60_000)).toThrow();
    expect(rawRoom(second.host.code).teams[0].results).toEqual([]);
    expect(() => recoverSession(second.host.code, { kind: 'host', recoveryCode: first.host.recoveryCode }, NOW)).toThrow();
    expect(() => reissuePlayer(second.host.code, first.host.token, { playerId: second.players[0].playerId }, NOW)).toThrow();
    expect(() => executeCommand(first.host.code, 'player', first.players[0].token, { type: 'end', actionId: 'forged-host-end', actor: { kind: 'host' } }, ORIGIN, NOW)).toThrow();
    executeCommand(first.host.code, 'player', first.players[0].token, { ...ballot('A'), playerId: first.players[1].playerId }, ORIGIN, NOW + 1);
    expect(rawRoom(first.host.code).teams[0].votes[1]?.[first.players[1].playerId]).toBeUndefined();
  });

  it('restores the same seat and ballot revision while revoking superseded credentials', () => {
    const { host, players } = filledRoom();
    executeCommand(host.code, 'player', players[0].token, ballot('A'), ORIGIN, NOW + 1);
    const recovery = reissuePlayer(host.code, host.token, { playerId: players[0].playerId }, NOW + 2);
    expect(() => getState(host.code, 'player', players[0].token, ORIGIN, NOW + 3)).toThrow();
    expect(() => executeCommand(host.code, 'player', players[0].token, ballot('pass', 2), ORIGIN, NOW + 3)).toThrow();
    const restored = recoverSession(host.code, { kind: 'player', recoveryCode: recovery.recoveryCode }, NOW + 4);
    expect(getState(host.code, 'player', restored.token, ORIGIN, NOW + 5).myVote).toMatchObject({ choice: 'A', revision: 1 });
    expect(() => recoverSession(host.code, { kind: 'player', recoveryCode: recovery.recoveryCode }, NOW + 5)).toThrow();
    expect(executeCommand(host.code, 'player', restored.token, ballot('B', 2), ORIGIN, NOW + 6).myVote?.choice).toBe('B');
    const recoveredHost = recoverSession(host.code, { kind: 'host', recoveryCode: host.recoveryCode }, NOW + 7);
    expect(() => getState(host.code, 'host', host.token, ORIGIN, NOW + 8)).toThrow();
    expect(getState(host.code, 'host', recoveredHost.token, ORIGIN, NOW + 8).host?.projectorToken).toBe(host.projectorToken);
    const credentials = JSON.stringify(getDatabase().prepare('SELECT * FROM credentials').all());
    expect(credentials).not.toContain(restored.token);
    expect(credentials).toContain(hashSecret(restored.token));
  });

  it.each([{ version: 1, scenarioVersion: 'legacy' }, { version: 2, scenarioVersion: 'obsolete' }])('leaves unsupported rooms %j and their credentials untouched on every access path', async unsupported => {
    const { host, players } = filledRoom();
    const legacy = { ...rawRoom(host.code), ...unsupported, oldData: 'preserve exactly' };
    getDatabase().prepare('UPDATE rooms SET state_json = ? WHERE code = ?').run(JSON.stringify(legacy), host.code);
    const before = JSON.stringify({ room: readStoredRoom(getDatabase(), host.code), credentials: getDatabase().prepare('SELECT * FROM credentials').all(), recoveries: getDatabase().prepare('SELECT * FROM recovery_codes').all(), receipts: getDatabase().prepare('SELECT * FROM command_receipts').all() });
    const paths = [
      () => getLobby(host.code, NOW + 30_000),
      () => getState(host.code, 'host', host.token, ORIGIN, NOW + 30_000),
      () => getState(host.code, 'projector', host.projectorToken, ORIGIN, NOW + 30_000),
      () => executeCommand(host.code, 'host', host.token, { type: 'end', actionId: 'legacy-end-attempt' }, ORIGIN, NOW + 30_000),
      () => joinSession(host.code, { nickname: 'New', teamId: 'team-1', seatIndex: 0 }, undefined, NOW + 30_000),
      () => recoverSession(host.code, { kind: 'host', recoveryCode: host.recoveryCode }, NOW + 30_000),
      () => reissuePlayer(host.code, host.token, { playerId: players[0].playerId }, NOW + 30_000),
    ];
    for (const action of paths) expect(action).toThrowError(expect.objectContaining({ status: 409, code: 'game_updated' }));
    const response = await stateRoute(new NextRequest(`${ORIGIN}/api/rooms/${host.code}/state?view=host`), { params: Promise.resolve({ code: host.code }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'game_updated' });
    expect(JSON.stringify({ room: readStoredRoom(getDatabase(), host.code), credentials: getDatabase().prepare('SELECT * FROM credentials').all(), recoveries: getDatabase().prepare('SELECT * FROM recovery_codes').all(), receipts: getDatabase().prepare('SELECT * FROM command_receipts').all() })).toBe(before);
  });

  it('expires access after 24 hours and throttles presence writes', () => {
    const { host, players } = filledRoom();
    getState(host.code, 'player', players[0].token, ORIGIN, NOW + 5_000);
    let row = getDatabase().prepare('SELECT last_seen_at FROM credentials WHERE actor_id = ?').get(players[0].playerId) as { last_seen_at: number };
    expect(row.last_seen_at).toBe(NOW);
    getState(host.code, 'player', players[0].token, ORIGIN, NOW + 11_000);
    row = getDatabase().prepare('SELECT last_seen_at FROM credentials WHERE actor_id = ?').get(players[0].playerId) as { last_seen_at: number };
    expect(row.last_seen_at).toBe(NOW + 11_000);
    const lobby = getLobby(host.code, NOW + 21_000);
    expect(lobby.teams[0].seats[0].player?.connected).toBe(true);
    expect(lobby.teams[0].seats[1].player?.connected).toBe(false);
    expect(() => getLobby(host.code, NOW + 24 * 60 * 60 * 1000)).toThrow(/expired/);
  });
});

describe('flexible roster service', () => {
  function flexible(sizes: number[]) {
    const host = createSession({ rosterMode: 'flexible', mode: sizes.length === 1 ? 'coop' : 'competition', teams: sizes.map((_, index) => ({ name: `Group ${index + 1}` })) }, NOW);
    const players = sizes.map((size, teamIndex) => Array.from({ length: size }, (_, seat) => joinSession(host.code, { teamId: `team-${teamIndex + 1}`, nickname: `P${teamIndex}-${seat}` }, undefined, NOW)));
    return { host, players };
  }
  const remove = (playerId: string, actionId = 'host-remove-player') => ({ type: 'remove_player', playerId, actionId, phase: 'lobby', round: 0 });
  const start = { type: 'start', actionId: 'flexible-host-start', phase: 'lobby', round: 0 };

  it('publishes automatic 2–5 rosters and freezes mixed registered counts, including disconnected members', () => {
    const { host, players } = flexible([2, 3, 4, 5]);
    const waiting = getLobby(host.code, NOW + 30_000);
    expect(waiting).toMatchObject({ rosterMode: 'flexible', canStart: true });
    expect(waiting.teams.map(team => team.joinedCount)).toEqual([2, 3, 4, 5]);
    expect(waiting.teams.map(team => team.seats.length)).toEqual([2, 3, 4, 5]);
    expect(waiting.teams.every(team => team.ready && team.minPlayers === 2 && team.maxPlayers === 5 && team.size === 5)).toBe(true);
    expect(waiting.teams.flatMap(team => team.seats).every(seat => seat.roles.length === 0 && seat.player?.connected === false)).toBe(true);
    const preStart = getState(host.code, 'player', players[0][0].token, ORIGIN, NOW + 30_000);
    expect(preStart.player?.roles).toEqual([]);
    expect(preStart.privateClues).toEqual([]);
    executeCommand(host.code, 'host', host.token, start, ORIGIN, NOW + 30_001);
    const frozen = getState(host.code, 'host', host.token, ORIGIN, NOW + 30_002);
    expect(frozen.canStart).toBe(false);
    expect(frozen.teams.map(team => team.size)).toEqual([2, 3, 4, 5]);
    expect(frozen.teams.map(team => team.quorum)).toEqual([2, 2, 2, 3]);
    for (const members of players) {
      const clues = members.flatMap(member => getState(host.code, 'player', member.token, ORIGIN, NOW + 30_002).privateClues);
      expect(clues.map(clue => clue.role).sort()).toEqual(['accountant', 'analyst', 'coordinator', 'developer', 'operations']);
    }
    expect(getState(host.code, 'projector', host.projectorToken, ORIGIN, NOW + 30_002).privateClues).toEqual([]);
    expect(() => joinSession(host.code, { teamId: 'team-1', nickname: 'Late arrival' }, undefined, NOW + 30_003)).toThrow();
    closeDatabases();
    expect(rawRoom(host.code).teams.map(team => team.size)).toEqual([2, 3, 4, 5]);
  });

  it('allocates five unique seats and rejects overflow when admissions arrive together', async () => {
    const { host } = flexible([0]);
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, async (_, index) => joinSession(host.code, { teamId: 'team-1', nickname: `Concurrent ${index}` }, undefined, NOW)));
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(5);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(rawRoom(host.code).players.map(member => member.seatIndex).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(getLobby(host.code, NOW).teams[0]).toMatchObject({ joinedCount: 5, maxPlayers: 5, ready: true });
  });

  it('serializes both join/start orders without admitting a player into a frozen roster', () => {
    const before = flexible([2]);
    joinSession(before.host.code, { teamId: 'team-1', nickname: 'Before start' }, undefined, NOW + 1);
    executeCommand(before.host.code, 'host', before.host.token, start, ORIGIN, NOW + 2);
    expect(rawRoom(before.host.code).teams[0].size).toBe(3);
    const after = flexible([2]);
    executeCommand(after.host.code, 'host', after.host.token, start, ORIGIN, NOW + 1);
    expect(() => joinSession(after.host.code, { teamId: 'team-1', nickname: 'After start' }, undefined, NOW + 2)).toThrowError(expect.objectContaining({ code: 'game_started' }));
    expect(rawRoom(after.host.code).teams[0].size).toBe(2);
    expect(rawRoom(after.host.code).players).toHaveLength(2);
  });

  it('revokes removed credentials and recovery codes atomically, and replays removal without deleting a replacement', () => {
    const { host, players: [members] } = flexible([3]);
    const recovery = reissuePlayer(host.code, host.token, { playerId: members[1].playerId }, NOW + 1);
    const firstRemoval = remove(members[0].playerId, 'remove-active-credential');
    executeCommand(host.code, 'host', host.token, firstRemoval, ORIGIN, NOW + 2);
    expect(() => getState(host.code, 'player', members[0].token, ORIGIN, NOW + 3)).toThrowError(expect.objectContaining({ status: 401 }));
    executeCommand(host.code, 'host', host.token, remove(members[1].playerId, 'remove-recovery-seat'), ORIGIN, NOW + 3);
    expect(() => recoverSession(host.code, { kind: 'player', recoveryCode: recovery.recoveryCode }, NOW + 4)).toThrow();
    expect(getDatabase().prepare("SELECT actor_id FROM credentials WHERE room_code = ? AND actor_kind = 'player'").all(host.code)).toEqual([{ actor_id: members[2].playerId }]);
    expect(getDatabase().prepare("SELECT actor_id FROM recovery_codes WHERE room_code = ? AND actor_kind = 'player'").all(host.code)).toEqual([]);
    expect(getLobby(host.code, NOW + 4).canStart).toBe(false);
    const replacement = joinSession(host.code, { teamId: 'team-1', nickname: 'Replacement' }, undefined, NOW + 5);
    executeCommand(host.code, 'host', host.token, firstRemoval, ORIGIN, NOW + 6);
    expect(rawRoom(host.code).players.map(member => member.id)).toEqual([members[2].playerId, replacement.playerId]);
    executeCommand(host.code, 'host', host.token, start, ORIGIN, NOW + 7);
    expect(rawRoom(host.code).players.map(member => member.seatIndex)).toEqual([0, 1]);
    expect(getState(host.code, 'player', replacement.token, ORIGIN, NOW + 8).privateClues.map(clue => clue.role).sort()).toEqual(['coordinator', 'developer', 'operations']);
  });

  it('restricts team cleanup to empty lobby teams while preserving stable identifiers and minimum counts', () => {
    const { host, players } = flexible([2, 2, 0]);
    const removeEmpty = { type: 'remove_team', teamId: 'team-3', actionId: 'remove-empty-team', round: 0, phase: 'lobby' };
    expect(() => executeCommand(host.code, 'player', players[0][0].token, removeEmpty, ORIGIN, NOW + 1)).toThrowError(expect.objectContaining({ status: 403 }));
    expect(() => executeCommand(host.code, 'host', host.token, { ...removeEmpty, teamId: 'team-1' }, ORIGIN, NOW + 1)).toThrowError(expect.objectContaining({ code: 'team_not_empty' }));
    executeCommand(host.code, 'host', host.token, removeEmpty, ORIGIN, NOW + 2);
    expect(getLobby(host.code, NOW + 3).teams.map(team => team.id)).toEqual(['team-1', 'team-2']);
    expect(() => joinSession(host.code, { teamId: 'team-3', nickname: 'Removed team' }, undefined, NOW + 4)).toThrowError(expect.objectContaining({ code: 'team_not_found' }));
    executeCommand(host.code, 'host', host.token, start, ORIGIN, NOW + 5);
    expect(() => executeCommand(host.code, 'host', host.token, { type: 'remove_team', teamId: 'team-1', actionId: 'late-team-removal' }, ORIGIN, NOW + 6)).toThrowError(expect.objectContaining({ code: 'roster_frozen' }));
    const emptyCompetition = flexible([0, 0]);
    expect(() => executeCommand(emptyCompetition.host.code, 'host', emptyCompetition.host.token, { ...removeEmpty, teamId: 'team-1' }, ORIGIN, NOW)).toThrowError(expect.objectContaining({ code: 'minimum_teams' }));
    const emptyCoop = flexible([0]);
    expect(() => executeCommand(emptyCoop.host.code, 'host', emptyCoop.host.token, { ...removeEmpty, teamId: 'team-1' }, ORIGIN, NOW)).toThrowError(expect.objectContaining({ code: 'minimum_teams' }));
  });

  it('keeps start/removal races atomic and does not revoke a frozen participant', () => {
    const before = flexible([2]);
    executeCommand(before.host.code, 'host', before.host.token, remove(before.players[0][0].playerId), ORIGIN, NOW + 1);
    expect(() => executeCommand(before.host.code, 'host', before.host.token, start, ORIGIN, NOW + 2)).toThrowError(expect.objectContaining({ code: 'empty_seats' }));
    expect(rawRoom(before.host.code).status).toBe('lobby');
    expect(rawRoom(before.host.code).draws).toEqual([]);
    const after = flexible([2]);
    executeCommand(after.host.code, 'host', after.host.token, start, ORIGIN, NOW + 1);
    expect(() => executeCommand(after.host.code, 'host', after.host.token, { type: 'remove_player', playerId: after.players[0][0].playerId, actionId: 'late-player-removal' }, ORIGIN, NOW + 2)).toThrowError(expect.objectContaining({ code: 'roster_frozen' }));
    expect(getState(after.host.code, 'player', after.players[0][0].token, ORIGIN, NOW + 3).player?.id).toBe(after.players[0][0].playerId);
  });

  it('accepts the public flexible create and join payloads without size or seatIndex', async () => {
    const created = await createRoute(post(`${ORIGIN}/api/rooms`, { rosterMode: 'flexible', mode: 'coop', teams: [{ name: 'Automatic' }] }));
    expect(created.status).toBe(201);
    const { code } = await created.json();
    expect(getLobby(code).teams[0]).toMatchObject({ joinedCount: 0, ready: false, seats: [] });
    const joined = await joinRoute(post(`${ORIGIN}/api/rooms/${code}/join`, { nickname: 'First member', teamId: 'team-1' }), { params: Promise.resolve({ code }) });
    expect(joined.status).toBe(201);
    expect(getLobby(code)).toMatchObject({ rosterMode: 'flexible', canStart: false });
    expect(getLobby(code).teams[0].seats[0].roles).toEqual([]);
  });
});

describe('player lobby membership service', () => {
  function waiting(sizes = [2, 2]) {
    const host = createSession({ rosterMode: 'flexible', mode: sizes.length === 1 ? 'coop' : 'competition', teams: sizes.map((_, i) => ({ name: `Group ${i + 1}` })) }, NOW);
    const players = sizes.map((size, team) => Array.from({ length: size }, (_, seat) => joinSession(host.code, { teamId: `team-${team + 1}`, nickname: `Member ${team}-${seat}` }, undefined, NOW)));
    return { host, players };
  }
  const move = (expectedPlayerId: string, teamId: string, actionId = 'move-team-first') => ({ type: 'change_team', actionId, round: 0, phase: 'lobby', expectedPlayerId, teamId });
  const leave = (expectedPlayerId: string, actionId = 'leave-team-first') => ({ type: 'leave', actionId, round: 0, phase: 'lobby', expectedPlayerId });

  it('preserves identity and recovery on a move, appends join order, and replays without moving again', () => {
    const { host, players } = waiting();
    const member = players[0][0];
    const recovery = createRecoveryCode(getDatabase(), host.code, 'player', member.playerId, NOW + 900_000, true);
    const request = move(member.playerId, 'team-2');
    const moved = executeCommand(host.code, 'player', member.token, request, ORIGIN, NOW + 1);
    expect(moved.player).toMatchObject({ id: member.playerId, nickname: 'Member 0-0', teamId: 'team-2', roles: [] });
    expect(moved.teams[1].seats.map(seat => seat.player?.id)).toEqual([...players[1].map(player => player.playerId), member.playerId]);
    expect(moved.canStart).toBe(false);
    expect(moved.privateClues).toEqual([]);
    expect(moved.myVote).toBeNull();
    executeCommand(host.code, 'player', member.token, move(member.playerId, 'team-1', 'move-back-again'), ORIGIN, NOW + 2);
    const replay = executeCommand(host.code, 'player', member.token, request, ORIGIN, NOW + 3);
    expect(replay.player?.teamId).toBe('team-1');
    expect(replay.teams[0].seats.map(seat => seat.player?.id)).toEqual([players[0][1].playerId, member.playerId]);
    expect(() => executeCommand(host.code, 'player', member.token, { ...request, teamId: 'team-1' }, ORIGIN, NOW + 4)).toThrowError(expect.objectContaining({ code: 'action_id_reused' }));
    const restored = recoverSession(host.code, { kind: 'player', recoveryCode: recovery }, NOW + 5);
    expect(getState(host.code, 'player', restored.token, ORIGIN, NOW + 6).player?.id).toBe(member.playerId);
  });

  it('serializes competition for the last seat without dropping the losing source member', async () => {
    const { host, players } = waiting([2, 2, 4]);
    const candidates = [players[0][0], players[1][0]];
    const results = await Promise.allSettled(candidates.map(async member => executeCommand(host.code, 'player', member.token, move(member.playerId, 'team-3'), ORIGIN, NOW + 1)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409, code: 'team_full' });
    expect(rawRoom(host.code).players).toHaveLength(8);
    expect(getLobby(host.code, NOW + 1).teams.map(team => team.joinedCount).sort()).toEqual([1, 2, 5]);
    const fullMember = players[2][0];
    const before = rawRoom(host.code);
    executeCommand(host.code, 'player', fullMember.token, move(fullMember.playerId, 'team-3'), ORIGIN, NOW + 2);
    expect(rawRoom(host.code)).toEqual(before);
    expect(() => executeCommand(host.code, 'player', fullMember.token, move(fullMember.playerId, 'missing', 'move-missing-team'), ORIGIN, NOW + 3)).toThrowError(expect.objectContaining({ code: 'team_not_found' }));
    expect(rawRoom(host.code)).toEqual(before);
  });

  it('revokes only the leaving membership and recovery, keeps host access, and rejects retries with the revoked credential', () => {
    const { host, players: [players] } = waiting([3]);
    const member = players[0];
    const recovery = createRecoveryCode(getDatabase(), host.code, 'player', member.playerId, NOW + 900_000, true);
    const request = leave(member.playerId);
    expect(executeRawCommand(host.code, 'player', member.token, request, ORIGIN, NOW + 1)).toEqual({ left: true });
    expect(rawRoom(host.code).players.map(player => player.id)).toEqual(players.slice(1).map(player => player.playerId));
    expect(getDatabase().prepare('SELECT 1 FROM credentials WHERE room_code = ? AND actor_id = ?').get(host.code, member.playerId)).toBeUndefined();
    expect(getDatabase().prepare('SELECT 1 FROM recovery_codes WHERE room_code = ? AND actor_id = ?').get(host.code, member.playerId)).toBeUndefined();
    expect(getDatabase().prepare('SELECT 1 FROM command_receipts WHERE room_code = ? AND actor_key = ? AND action_id = ?').get(host.code, `player:${member.playerId}`, request.actionId)).toBeDefined();
    expect(() => executeRawCommand(host.code, 'player', member.token, request, ORIGIN, NOW + 2)).toThrowError(expect.objectContaining({ status: 401, code: 'authentication_required' }));
    expect(() => getState(host.code, 'player', member.token, ORIGIN, NOW + 2)).toThrowError(expect.objectContaining({ status: 401 }));
    expect(() => recoverSession(host.code, { kind: 'player', recoveryCode: recovery }, NOW + 2)).toThrowError(expect.objectContaining({ status: 401 }));
    expect(getState(host.code, 'host', host.token, ORIGIN, NOW + 2).canStart).toBe(true);
  });

  it('guards a newly joined membership against stale leave and move requests from an old tab', () => {
    const { host, players } = waiting();
    const member = players[0][0];
    const oldLeave = leave(member.playerId);
    executeRawCommand(host.code, 'player', member.token, oldLeave, ORIGIN, NOW + 1);
    const replacement = joinSession(host.code, { teamId: 'team-1', nickname: 'Rejoined' }, member.token, NOW + 2);
    expect(replacement.playerId).not.toBe(member.playerId);
    for (const request of [oldLeave, move(member.playerId, 'team-2')]) expect(() => executeRawCommand(host.code, 'player', replacement.token, request, ORIGIN, NOW + 3)).toThrowError(expect.objectContaining({ status: 409, code: 'membership_changed' }));
    const state = getState(host.code, 'player', replacement.token, ORIGIN, NOW + 4);
    expect(state.player).toMatchObject({ id: replacement.playerId, teamId: 'team-1' });
    expect(() => executeCommand(host.code, 'player', replacement.token, move(players[1][0].playerId, 'team-1'), ORIGIN, NOW + 5)).toThrowError(expect.objectContaining({ code: 'membership_changed' }));
  });

  it.each(['leave', 'change_team'] as const)('serializes %s against Start in both arrival orders', type => {
    const before = waiting();
    const member = before.players[0][0];
    const command = type === 'leave' ? leave(member.playerId) : move(member.playerId, 'team-2');
    executeRawCommand(before.host.code, 'player', member.token, command, ORIGIN, NOW + 1);
    expect(() => executeCommand(before.host.code, 'host', before.host.token, { type: 'start', actionId: 'start-after-membership' }, ORIGIN, NOW + 2)).toThrowError(expect.objectContaining({ code: 'empty_seats' }));
    expect(rawRoom(before.host.code).draws).toEqual([]);
    const after = waiting();
    const frozen = after.players[0][0];
    executeCommand(after.host.code, 'host', after.host.token, { type: 'start', actionId: 'start-before-membership' }, ORIGIN, NOW + 1);
    const late = type === 'leave' ? leave(frozen.playerId) : move(frozen.playerId, 'team-2');
    expect(() => executeRawCommand(after.host.code, 'player', frozen.token, late, ORIGIN, NOW + 2)).toThrowError(expect.objectContaining({ status: 409 }));
    expect(getState(after.host.code, 'player', frozen.token, ORIGIN, NOW + 3).player?.teamId).toBe('team-1');
    expect(rawRoom(after.host.code).teams.map(team => team.size)).toEqual([2, 2]);
  });

  it('supports the same membership actions in existing fixed-seat lobbies', () => {
    const host = createSession({ mode: 'competition', teams: [{ name: 'A', size: 2 }, { name: 'B', size: 2 }] }, NOW);
    const member = joinSession(host.code, { teamId: 'team-1', nickname: 'Fixed', seatIndex: 1 }, undefined, NOW);
    const moved = executeCommand(host.code, 'player', member.token, move(member.playerId, 'team-2'), ORIGIN, NOW + 1);
    expect(moved.player).toMatchObject({ teamId: 'team-2', seatIndex: 0 });
    expect(moved.rosterMode).toBe('fixed');
    expect(executeRawCommand(host.code, 'player', member.token, leave(member.playerId), ORIGIN, NOW + 2)).toEqual({ left: true });
  });
});

describe('persisted scenario registry compatibility', () => {
  it('keeps existing GBP rooms pinned through restart, private clues, settlement and the next deal', () => {
    const { host, players } = filledRoom();
    expect(rawRoom(host.code).scenarioVersion).toBe('team-capital-2');
    expect(getLobby(host.code, NOW).currency).toBe('EUR');
    expect(getState(host.code, 'host', host.token, ORIGIN, NOW).currency).toBe('EUR');
    const original = rawRoom(host.code);
    original.scenarioVersion = 'team-capital-1';
    original.draws = [99, 99, 99, 99, 99];
    getDatabase().prepare('UPDATE rooms SET state_json = ? WHERE code = ?').run(JSON.stringify(original), host.code);
    closeDatabases();
    expect(getLobby(host.code, NOW + 1).currency).toBe('GBP');
    const privateView = getState(host.code, 'player', players[0].token, ORIGIN, NOW + 1);
    expect(privateView.currency).toBe('GBP');
    expect(privateView.roundInfo).toEqual(getDeal(1, 'team-capital-1').info);
    expect(privateView.privateClues).toEqual(getClues(1, 'team-capital-1').filter(clue => ['accountant', 'analyst'].includes(clue.role)));
    for (const member of players.slice(0, 2)) executeCommand(host.code, 'player', member.token, ballot('A'), ORIGIN, NOW + 2);
    const reveal = getState(host.code, 'projector', host.projectorToken, ORIGIN, NOW + 60_000);
    expect(reveal.currentReveal).toMatchObject({ eventId: 'licence_failed', counterfactuals: { A: -2000, B: 1000, pass: 0 } });
    expect(reveal.teams[0].balance).toBe(8000);
    closeDatabases();
    const next = getState(host.code, 'player', players[0].token, ORIGIN, NOW + 75_000);
    expect(next.currency).toBe('GBP');
    expect(next.roundInfo).toEqual(getDeal(2, 'team-capital-1').info);
    expect(rawRoom(host.code).scenarioVersion).toBe('team-capital-1');
    expect(rawRoom(host.code).teams[0].results).toHaveLength(1);
  });
});

describe('HTTP boundary', () => {
  it.each([false, true])('expires only the room player cookie on leave (HTTPS=%s) and guards rejoined seats', async secure => {
    const origin = secure ? 'https://game.example' : ORIGIN;
    if (secure) process.env.APP_URL = origin;
    const host = createSession({ rosterMode: 'flexible', mode: 'competition', teams: [{ name: 'A' }, { name: 'B' }] });
    const member = joinSession(host.code, { teamId: 'team-1', nickname: 'Host playing' });
    const url = `${origin}/api/rooms/${host.code}/commands?view=player`;
    const context = { params: Promise.resolve({ code: host.code }) };
    const cookies = `${cookieName(host.code, 'host')}=${host.token}; ${cookieName(host.code, 'player')}=${member.token}`;
    const leave = { type: 'leave', actionId: 'http-leave-player', round: 0, phase: 'lobby', expectedPlayerId: member.playerId };
    const response = await commandRoute(post(url, leave, cookies, origin), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ left: true });
    const cleared = response.headers.get('set-cookie');
    expect(cleared).toContain(`${cookieName(host.code, 'player')}=;`);
    expect(cleared).toContain(`Path=/api/rooms/${host.code}`);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Expires=Thu, 01 Jan 1970');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('SameSite=lax');
    expect(cleared?.includes('Secure')).toBe(secure);
    expect(cleared).not.toContain(cookieName(host.code, 'host'));
    expect(getState(host.code, 'host', host.token, origin).host).toBeDefined();
    const retry = await commandRoute(post(url, leave, cookies, origin), context);
    expect(retry.status).toBe(401);
    expect(await retry.json()).toMatchObject({ error: 'authentication_required' });
    expect(retry.headers.get('set-cookie')).toBeNull();
    const rejoined = joinSession(host.code, { teamId: 'team-1', nickname: 'Rejoined' }, member.token);
    const newCookies = `${cookieName(host.code, 'host')}=${host.token}; ${cookieName(host.code, 'player')}=${rejoined.token}`;
    for (const command of [leave, { ...leave, type: 'change_team', teamId: 'team-2', actionId: 'http-stale-move' }]) {
      const stale = await commandRoute(post(url, command, newCookies, origin), context);
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: 'membership_changed' });
      expect(stale.headers.get('set-cookie')).toBeNull();
    }
    expect(getState(host.code, 'player', rejoined.token, origin).player?.teamId).toBe('team-1');
  });

  it('keeps authentication when a delayed leave arrives after the host starts', async () => {
    const { host, players } = filledRoom(2);
    const member = players[0];
    const response = await commandRoute(post(`${ORIGIN}/api/rooms/${host.code}/commands`, {
      type: 'leave', actionId: 'http-leave-after-start', round: 0, phase: 'lobby', expectedPlayerId: member.playerId,
    }, `${cookieName(host.code, 'player')}=${member.token}`), { params: Promise.resolve({ code: host.code }) });
    expect(response.status).toBe(409);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(getState(host.code, 'player', member.token, ORIGIN, NOW + 1).player?.id).toBe(member.playerId);
  });

  it('accepts the browser Host when Next uses a bind address and rejects unrelated origins', async () => {
    const request = (origin: string) => new NextRequest('http://0.0.0.0:3100/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: '127.0.0.1:3100', Origin: origin, 'X-Forwarded-Host': 'attacker.example', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ mode: 'coop', teams: [{ name: 'Local team', size: 3 }] }),
    });
    const localRequest = request('http://127.0.0.1:3100');
    expect(baseUrl(localRequest)).toBe('http://127.0.0.1:3100');
    const response = await createRoute(localRequest);
    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).not.toContain('Secure');
    expect((await createRoute(request('https://attacker.example'))).status).toBe(403);
    expect((await createRoute(request('http://0.0.0.0:3100'))).status).toBe(403);
  });

  it('uses configured APP_URL for origin validation, links and secure cookies', async () => {
    process.env.APP_URL = 'https://game.example';
    const request = (origin: string) => new NextRequest('http://0.0.0.0:3100/api/rooms', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Host: '127.0.0.1:3100', Origin: origin },
      body: JSON.stringify({ mode: 'coop', teams: [{ name: 'Hosted team', size: 3 }] }),
    });
    const canonicalRequest = request('https://game.example');
    expect(baseUrl(canonicalRequest)).toBe('https://game.example');
    const response = await createRoute(canonicalRequest);
    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).toContain('Secure');
    expect((await createRoute(request('http://127.0.0.1:3100'))).status).toBe(403);
  });

  it('creates with a protected cookie and never sends its raw authentication token in JSON', async () => {
    const response = await createRoute(post(`${ORIGIN}/api/rooms`, { mode: 'coop', teams: [{ name: 'HTTP team', size: 3 }] }));
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(['code', 'projectorToken', 'recoveryCode']);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('SameSite=lax');
    expect(response.headers.get('set-cookie')).toContain(`Path=/api/rooms/${body.code}`);
    const joining = await joinRoute(post(`${ORIGIN}/api/rooms/${body.code}/join`, { nickname: 'Player', teamId: 'team-1', seatIndex: 0 }), { params: Promise.resolve({ code: body.code }) });
    expect(joining.status).toBe(201);
    expect(joining.headers.get('set-cookie')).toContain(`deadline_player_${body.code}`);
    expect(await joining.json()).toHaveProperty('playerId');
  });

  it('rejects cross-origin writes, malformed JSON, oversized bodies and projector commands', async () => {
    expect((await createRoute(post(`${ORIGIN}/api/rooms`, {}, undefined, 'https://attacker.example'))).status).toBe(403);
    const malformed = new NextRequest(`${ORIGIN}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    expect((await createRoute(malformed)).status).toBe(400);
    expect((await createRoute(post(`${ORIGIN}/api/rooms`, { value: 'x'.repeat(17_000) }))).status).toBe(413);
    const host = createSession({ mode: 'coop', teamCount: 1, teamSize: 3 });
    const projectedCommand = await commandRoute(post(`${ORIGIN}/api/rooms/${host.code}/commands?view=projector`, { type: 'start', actionId: 'projector-start-1' }), { params: Promise.resolve({ code: host.code }) });
    expect(projectedCommand.status).toBe(403);
    const unauthenticated = await stateRoute(new NextRequest(`${ORIGIN}/api/rooms/${host.code}/state?view=host`), { params: Promise.resolve({ code: host.code }) });
    expect(unauthenticated.status).toBe(401);
  });
});

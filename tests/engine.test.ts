import { describe, expect, it } from 'vitest';
import { advanceTo, applyCommand, createRoom, DomainError, getPhase, getSnapshot, joinRoom } from '../src/lib/engine';
import { eventFor, getClues, getScenario } from '../src/lib/scenario';
import { COOP_TARGET, getRolePackets, quorumFor, SCENARIO_VERSION } from '../src/lib/public';
import type { Actor, Choice, Command, RoomState, RoundNumber, TeamSize } from '../src/lib/types';

const NOW = 1_000_000;
const LEGACY_VERSION = 'team-capital-1' as const;
const DEALS = getScenario(LEGACY_VERSION).deals;
const HOST: Actor = { kind: 'host' };
const PROJECTOR: Actor = { kind: 'projector' };
const player = (id = 'a0'): Actor => ({ kind: 'player', playerId: id });
let action = 0;
const actionId = () => 'action-' + ++action;
function lobby(size: TeamSize = 3, competition = false): RoomState {
  const teams = [{ id: 'a', name: 'Alpha', size }, ...(competition ? [{ id: 'b', name: 'Beta', size }] : [])];
  // Retain the original GBP fixture as an explicit compatibility regression.
  let room: RoomState = { ...createRoom({ code: 'TEST', mode: competition ? 'competition' : 'coop', teams }, NOW), scenarioVersion: LEGACY_VERSION };
  for (const team of teams) for (let seatIndex = 0; seatIndex < size; seatIndex++) {
    room = joinRoom(room, { teamId: team.id, seatIndex, nickname: team.name + seatIndex, playerId: team.id + seatIndex }, NOW);
  }
  return room;
}
function start(size: TeamSize = 3, competition = false, draws = [0, 0, 0, 0, 0]): RoomState {
  return applyCommand(lobby(size, competition), HOST, { type: 'start', actionId: actionId(), round: 0, phase: 'lobby' }, NOW, draws);
}
function host(room: RoomState, type: 'pause' | 'resume' | 'end', now: number): RoomState {
  return applyCommand(room, HOST, { type, actionId: actionId() }, now);
}
function vote(room: RoomState, id: string, choice: Choice, now = room.roundStartedAt! + 100): RoomState {
  const view = getSnapshot(room, player(id), now);
  return applyCommand(room, player(id), {
    actionId: actionId(), type: 'vote', round: view.round, phase: view.phase,
    choice, revision: (view.myVote?.revision ?? 0) + 1,
  }, now);
}
function voteTeam(room: RoomState, teamId: string, choice: Choice, now = room.roundStartedAt! + 100): RoomState {
  for (const member of room.players.filter(p => p.teamId === teamId)) room = vote(room, member.id, choice, now);
  return room;
}
function play(choices: Choice[], draws: number[], size: TeamSize = 3): RoomState {
  let room = start(size, false, draws);
  for (const choice of choices) {
    room = voteTeam(room, 'a', choice);
    room = advanceTo(room, room.roundStartedAt! + 75_000);
  }
  return room;
}
function errorCode(fn: () => unknown, code: string) {
  try { fn(); throw new Error('Expected DomainError'); }
  catch (error) { expect(error).toBeInstanceOf(DomainError); expect((error as DomainError).code).toBe(code); }
}

describe('authored scenarios and shared probabilities', () => {
  it('contains five complete deals and exactly the authored probability frequencies', () => {
    expect(DEALS).toHaveLength(5);
    for (const deal of DEALS) {
      expect(deal.info.options.map(o => o.value)).toEqual(['A', 'B', 'pass']);
      expect(getClues(deal.info.number, LEGACY_VERSION).map(c => c.role).sort()).toEqual(['accountant', 'analyst', 'coordinator', 'developer', 'operations']);
      const counts: Record<string, number> = {};
      for (let draw = 0; draw < 100; draw++) {
        const event = eventFor(deal.info.number, draw, LEGACY_VERSION);
        counts[event.id] = (counts[event.id] ?? 0) + 1;
        expect(event.counterfactuals.pass).toBe(0);
      }
      expect(counts).toEqual(Object.fromEntries(deal.events.map(e => [e.id, e.weight])));
      expect(deal.events.reduce((sum, e) => sum + e.weight, 0)).toBe(100);
    }
  });
  it.each([
    [1, 69, 3000, 1000], [1, 70, -2000, 1000],
    [2, 39, 1800, 4000], [2, 40, 1800, -1000],
    [3, 19, 1000, 500], [3, 20, -2000, 500], [3, 59, -2000, 500], [3, 60, -2000, -1500],
    [4, 74, 4000, 1500], [4, 75, -1500, 1500],
    [5, 49, 1200, 3500], [5, 50, 1200, -1000],
  ])('round %i draw %i has approved payoffs', (round, draw, A, B) => {
    expect(eventFor(round as RoundNumber, draw, LEGACY_VERSION).counterfactuals).toEqual({ A, B, pass: 0 });
  });
  it('rejects invalid random values', () => {
    for (const draw of [-1, 100, 0.5, NaN, Infinity]) errorCode(() => eventFor(1, draw), 'invalid_draw');
  });
  it('does not make the largest quote universally preferable', () => {
    const expected = (round: RoundNumber, choice: 'A' | 'B') => DEALS[round - 1].events.reduce((n, e) => n + e.weight * e.counterfactuals[choice] / 100, 0);
    expect(expected(3, 'A')).toBe(-1400); expect(expected(3, 'B')).toBe(-300);
    expect(expected(2, 'A')).toBeGreaterThan(expected(2, 'B'));
    expect(expected(4, 'A')).toBeGreaterThan(expected(4, 'B'));
  });
  it('produces approved safe, best, worst and all-pass cash totals', () => {
    const risky: Choice[] = ['A', 'B', 'A', 'A', 'B'];
    expect(play(['B', 'A', 'pass', 'B', 'A'], [99, 99, 99, 99, 99]).teams[0].balance).toBe(15500);
    expect(play(risky, [0, 0, 0, 0, 0]).teams[0].balance).toBe(25500);
    expect(play(risky, [99, 99, 99, 99, 99]).teams[0].balance).toBe(2500);
    expect(play(['pass', 'pass', 'pass', 'pass', 'pass'], [0, 0, 0, 0, 0]).teams[0].balance).toBe(10000);
    expect(COOP_TARGET).toBe(15000);
  });
});

describe('room, roles, version and trusted draws', () => {
  it.each([2, 3, 4, 5] as const)('distributes the same five clues to %i players', size => {
    const room = start(size);
    expect(getRolePackets(size).flat().sort()).toEqual(['accountant', 'analyst', 'coordinator', 'developer', 'operations']);
    expect(room.players.flatMap(p => getSnapshot(room, player(p.id), NOW).privateClues)).toHaveLength(5);
    expect(quorumFor(size)).toBe(size === 5 ? 3 : 2);
    expect(room.scenarioVersion).toBe(LEGACY_VERSION);
  });
  it('requires filled seats and rejects duplicate claims or joins after start', () => {
    let room = createRoom({ code: 'TEST', mode: 'coop', teams: [{ id: 'a', name: 'Alpha', size: 3 }] }, NOW);
    errorCode(() => applyCommand(room, HOST, { type: 'start', actionId: actionId() }, NOW, [0, 0, 0, 0, 0]), 'empty_seats');
    room = joinRoom(room, { teamId: 'a', seatIndex: 0, nickname: 'A', playerId: 'one' }, NOW);
    errorCode(() => joinRoom(room, { teamId: 'a', seatIndex: 0, nickname: 'B', playerId: 'two' }, NOW), 'seat_taken');
    expect(joinRoom(room, { teamId: 'a', seatIndex: 0, nickname: 'A', playerId: 'one' }, NOW)).toEqual(room);
    errorCode(() => joinRoom(start(), { teamId: 'a', seatIndex: 0, nickname: 'B', playerId: 'two' }, NOW), 'game_started');
  });
  it('rejects unsupported versions and invalid room sizes', () => {
    errorCode(() => advanceTo({ ...lobby(), version: 1 } as unknown as RoomState, NOW), 'game_updated');
    errorCode(() => getSnapshot({ ...lobby(), scenarioVersion: 'other' } as unknown as RoomState, HOST, NOW), 'game_updated');
    for (const size of [1, 6]) errorCode(() => createRoom({ code: 'TEST', mode: 'coop', teams: [{ id: 'a', name: 'A', size: size as TeamSize }] }, NOW), 'invalid_size');
    errorCode(() => createRoom({ code: 'TEST', mode: 'competition', teams: Array.from({ length: 11 }, (_, i) => ({ id: '' + i, name: '' + i, size: 3 })) }, NOW), 'invalid_teams');
  });
  it('requires trusted draws, ignores client draws, copies once and cannot reroll', () => {
    const room = lobby();
    for (const draws of [undefined, [], [0, 0, 0, 0], [0, 0, 0, 0, 100], [0, 0, 0, 0, -1], [0, 0, 0, 0, 0.5]]) {
      errorCode(() => applyCommand(room, HOST, { type: 'start', actionId: actionId() }, NOW, draws), 'invalid_draws');
    }
    errorCode(() => applyCommand(room, HOST, { type: 'start', actionId: actionId(), draws: [0, 0, 0, 0, 0] } as Command, NOW), 'invalid_draws');
    const draws = [11, 22, 33, 44, 55];
    const running = applyCommand(room, HOST, { type: 'start', actionId: actionId() }, NOW, draws);
    draws[0] = 99;
    expect(running.draws).toEqual([11, 22, 33, 44, 55]);
    errorCode(() => applyCommand(running, HOST, { type: 'start', actionId: actionId() }, NOW, [0, 0, 0, 0, 0]), 'already_started');
  });
});

describe('flexible rosters', () => {
  function flexible(count = 1): RoomState {
    return createRoom({ code: 'FLEX', mode: count === 1 ? 'coop' : 'competition', rosterMode: 'flexible',
      teams: Array.from({ length: count }, (_, i) => ({ id: `team-${i}`, name: `Team ${i}` })) }, NOW);
  }
  function add(room: RoomState, id: string, teamId = 'team-0'): RoomState {
    return joinRoom(room, { teamId, nickname: id, playerId: id }, NOW);
  }
  function remove(room: RoomState, id: string): RoomState {
    return applyCommand(room, HOST, { type: 'remove_player', playerId: id, actionId: actionId() }, NOW);
  }
  it('keeps lobby roles unassigned and freezes mixed 2/3/4/5-person teams at Start', () => {
    let room = flexible(4);
    for (const [index, size] of [2, 3, 4, 5].entries()) for (let seat = 0; seat < size; seat++) room = add(room, `${index}-${seat}`, `team-${index}`);
    const waiting = getSnapshot(room, HOST, NOW);
    expect(waiting.rosterMode).toBe('flexible');
    expect(waiting.canStart).toBe(true);
    expect(waiting.teams.map(team => team.size)).toEqual([5, 5, 5, 5]);
    expect(waiting.teams.map(team => team.joinedCount)).toEqual([2, 3, 4, 5]);
    expect(waiting.teams.every(team => team.ready && team.minPlayers === 2 && team.maxPlayers === 5)).toBe(true);
    expect(waiting.teams.flatMap(team => team.seats).every(seat => seat.roles.length === 0)).toBe(true);
    expect(getSnapshot(room, player('0-0'), NOW).player?.roles).toEqual([]);
    expect(getSnapshot(room, player('0-0'), NOW).privateClues).toEqual([]);
    room = applyCommand(room, HOST, { type: 'start', actionId: actionId() }, NOW, [99, 0, 99, 0, 99]);
    expect(room.teams.map(team => team.size)).toEqual([2, 3, 4, 5]);
    expect(getSnapshot(room, HOST, NOW).canStart).toBe(false);
    for (const team of room.teams) {
      const members = room.players.filter(member => member.teamId === team.id);
      const clues = members.flatMap(member => getSnapshot(room, player(member.id), NOW).privateClues);
      expect(clues.map(clue => clue.role).sort()).toEqual(['accountant', 'analyst', 'coordinator', 'developer', 'operations']);
      expect(members.map(member => member.seatIndex)).toEqual(Array.from({ length: team.size }, (_, i) => i));
      room = voteTeam(room, team.id, 'A');
    }
    room = advanceTo(room, NOW + 60_000);
    expect(new Set(room.teams.map(team => team.results[0].eventId)).size).toBe(1);
    expect(new Set(room.teams.map(team => team.balance)).size).toBe(1);
    errorCode(() => add(room, 'late'), 'game_started');
    errorCode(() => remove(room, '0-0'), 'roster_frozen');
  });
  it('requires 2 players per team, caps admission at 5 and preserves join order after removals', () => {
    let room = flexible();
    expect(getSnapshot(room, HOST, NOW).teams[0].seats).toEqual([]);
    room = add(room, 'first');
    expect(getSnapshot(room, HOST, NOW).canStart).toBe(false);
    errorCode(() => applyCommand(room, HOST, { type: 'start', actionId: actionId() }, NOW, [0, 0, 0, 0, 0]), 'empty_seats');
    room = add(add(room, 'removed'), 'third');
    room = remove(room, 'removed');
    room = add(room, 'fourth');
    expect(room.players.map(member => member.seatIndex)).toEqual([0, 2, 1]);
    const joined = room.players.map(member => member.id);
    const running = applyCommand(room, HOST, { type: 'start', actionId: actionId() }, NOW, [0, 0, 0, 0, 0]);
    expect(running.players.map(member => member.id)).toEqual(joined);
    expect(running.players.map(member => member.seatIndex)).toEqual([0, 1, 2]);
    expect(getSnapshot(running, player('third'), NOW).player?.roles).toEqual(['developer']);
    room = add(add(room, 'fifth'), 'sixth');
    errorCode(() => add(room, 'overflow'), 'team_full');
  });
  it('allows only host removal, requires empty teams, and keeps the minimum team count', () => {
    let room = add(flexible(3), 'first');
    const removal: Command = { type: 'remove_team', teamId: 'team-0', actionId: actionId() };
    errorCode(() => applyCommand(room, player('first'), removal, NOW), 'host_required');
    errorCode(() => applyCommand(room, HOST, removal, NOW), 'team_not_empty');
    room = applyCommand(room, HOST, { ...removal, teamId: 'team-1' }, NOW);
    expect(room.teams.map(team => team.id)).toEqual(['team-0', 'team-2']);
    errorCode(() => applyCommand(room, HOST, { ...removal, teamId: 'team-2' }, NOW), 'minimum_teams');
    errorCode(() => applyCommand(flexible(), HOST, removal, NOW), 'minimum_teams');
  });
  it('keeps existing fixed rooms fixed while supporting automatic free-seat admission', () => {
    let room = createRoom({ code: 'FIXED', mode: 'coop', teams: [{ id: 'a', name: 'Legacy', size: 4 }] }, NOW);
    expect(room.rosterMode).toBeUndefined();
    for (const id of ['first', 'second', 'third']) room = joinRoom(room, { teamId: 'a', playerId: id, nickname: id }, NOW);
    const waiting = getSnapshot(room, HOST, NOW);
    expect(waiting.rosterMode).toBe('fixed');
    expect(waiting.canStart).toBe(false);
    expect(waiting.teams[0]).toMatchObject({ size: 4, minPlayers: 4, maxPlayers: 4, joinedCount: 3 });
    expect(waiting.teams[0].seats).toHaveLength(4);
    expect(waiting.teams[0].seats[0].roles).toEqual(['accountant']);
    room = joinRoom(room, { teamId: 'a', seatIndex: 3, playerId: 'fourth', nickname: 'Fourth' }, NOW);
    const running = applyCommand(room, HOST, { type: 'start', actionId: actionId() }, NOW, [0, 0, 0, 0, 0]);
    expect(running.teams[0].size).toBe(4);
    expect(running.players.map(member => member.seatIndex)).toEqual([0, 1, 2, 3]);
  });
});

describe('player lobby membership', () => {
  function waiting(sizes = [2, 2]): RoomState {
    let room = createRoom({ code: 'MOVES', mode: 'competition', rosterMode: 'flexible', teams: sizes.map((_, index) => ({ id: `t${index}`, name: `Team ${index}` })) }, NOW);
    for (const [team, size] of sizes.entries()) for (let seat = 0; seat < size; seat++) room = joinRoom(room, { teamId: `t${team}`, playerId: `p${team}-${seat}`, nickname: `Player ${team}-${seat}` }, NOW);
    return room;
  }
  function move(id: string, teamId: string): Command {
    return { type: 'change_team', expectedPlayerId: id, teamId, actionId: actionId(), round: 0, phase: 'lobby' };
  }
  function leave(id: string): Command {
    return { type: 'leave', expectedPlayerId: id, actionId: actionId(), round: 0, phase: 'lobby' };
  }
  it('moves only the authenticated member to the end of the target join order', () => {
    const original = waiting();
    let moved = applyCommand(original, player('p0-0'), move('p0-0', 't1'), NOW + 10);
    expect(moved.players.filter(member => member.teamId === 't1').map(member => member.id)).toEqual(['p1-0', 'p1-1', 'p0-0']);
    expect(moved.players.find(member => member.id === 'p0-0')).toMatchObject({ id: 'p0-0', nickname: 'Player 0-0', teamId: 't1', joinedAt: NOW + 10 });
    expect(getSnapshot(moved, HOST, NOW + 10).canStart).toBe(false);
    expect(original.players.filter(member => member.teamId === 't0')).toHaveLength(2);
    moved = applyCommand(moved, player('p1-0'), move('p1-0', 't0'), NOW + 20);
    moved = applyCommand(moved, HOST, { type: 'start', actionId: actionId() }, NOW + 30, [0, 0, 0, 0, 0]);
    expect(moved.teams.map(team => team.size)).toEqual([2, 2]);
    expect(getSnapshot(moved, player('p0-0'), NOW + 30).player?.roles).toEqual(['developer', 'operations', 'coordinator']);
  });
  it('keeps same-team moves as no-ops and full or missing-target moves atomic', () => {
    const room = waiting([2, 5]);
    expect(applyCommand(room, player('p1-0'), move('p1-0', 't1'), NOW + 1)).toEqual(room);
    errorCode(() => applyCommand(room, player('p0-0'), move('p0-0', 't1'), NOW + 1), 'team_full');
    errorCode(() => applyCommand(room, player('p0-0'), move('p0-0', 'missing'), NOW + 1), 'team_not_found');
    expect(room.players.filter(member => member.teamId === 't0')).toHaveLength(2);
  });
  it('uses expectedPlayerId only as a guard and disallows membership changes after Start', () => {
    const room = waiting();
    errorCode(() => applyCommand(room, player('p0-0'), move('p1-0', 't1'), NOW), 'membership_changed');
    errorCode(() => applyCommand(room, player('p0-0'), leave('p1-0'), NOW), 'membership_changed');
    errorCode(() => applyCommand(room, HOST, leave('p0-0'), NOW), 'player_required');
    errorCode(() => applyCommand(room, player('p0-0'), { type: 'leave', expectedPlayerId: 'p0-0', actionId: actionId() }, NOW), 'missing_version');
    const running = applyCommand(room, HOST, { type: 'start', actionId: actionId() }, NOW, [0, 0, 0, 0, 0]);
    errorCode(() => applyCommand(running, player('p0-0'), { ...move('p0-0', 't1'), round: 1, phase: 'decision' }, NOW), 'roster_frozen');
    errorCode(() => applyCommand(running, player('p0-0'), { ...leave('p0-0'), round: 1, phase: 'decision' }, NOW), 'roster_frozen');
  });
  it('removes only the departing member and makes readiness reflect the remaining roster', () => {
    const room = waiting();
    const departed = applyCommand(room, player('p0-0'), leave('p0-0'), NOW + 1);
    expect(departed.players.map(member => member.id)).toEqual(['p0-1', 'p1-0', 'p1-1']);
    expect(getSnapshot(departed, HOST, NOW + 1).canStart).toBe(false);
    errorCode(() => applyCommand(departed, HOST, { type: 'start', actionId: actionId() }, NOW + 2, [0, 0, 0, 0, 0]), 'empty_seats');
  });
});

describe('pinned scenario compatibility', () => {
  it('creates EUR rooms by default while old GBP rooms keep their original clues and payoffs', () => {
    const fresh = createRoom({ code: 'EUROS', mode: 'coop', rosterMode: 'flexible', teams: [{ id: 'a', name: 'Euro' }] }, NOW);
    expect(fresh.scenarioVersion).toBe(SCENARIO_VERSION);
    expect(fresh.scenarioVersion).toBe('team-capital-2');
    expect(getSnapshot(fresh, HOST, NOW).currency).toBe('EUR');
    let legacy = start(3, false, [99, 99, 99, 99, 99]);
    expect(getSnapshot(legacy, player(), NOW).currency).toBe('GBP');
    expect(getSnapshot(legacy, player(), NOW).roundInfo?.title).toBe(DEALS[0].info.title);
    expect(getSnapshot(legacy, player(), NOW).privateClues).toEqual(getClues(1, LEGACY_VERSION).filter(clue => ['accountant', 'analyst'].includes(clue.role)));
    legacy = voteTeam(legacy, 'a', 'A');
    const locked = getSnapshot(advanceTo(legacy, NOW + 60_000), HOST, NOW + 60_000);
    expect(locked.currentReveal?.eventId).toBe('licence_failed');
    expect(locked.teams[0].balance).toBe(8000);
    expect(locked.currency).toBe('GBP');
  });
});

describe('editable private ballots and selection', () => {
  it('requires exactly the next revision, replaces a vote and resets revisions each round', () => {
    const original = start();
    let room = vote(original, 'a0', 'A');
    const request = (revision: number): Command => ({ type: 'vote', actionId: actionId(), round: 1, phase: 'decision', choice: 'B', revision });
    for (const revision of [0, 1, 3, 1.5]) errorCode(() => applyCommand(room, player(), request(revision), NOW + 200), 'vote_revision');
    room = applyCommand(room, player(), request(2), NOW + 200);
    expect(room.teams[0].votes[1]?.a0).toMatchObject({ choice: 'B', revision: 2 });
    expect(getSnapshot(room, HOST, NOW + 300).teams[0].votesSubmitted).toBe(1);
    expect(original.teams[0].votes).toEqual({});
    room = vote(advanceTo(room, NOW + 75000), 'a0', 'A');
    expect(room.teams[0].votes[2]?.a0.revision).toBe(1);
  });
  const cases: { size: TeamSize; votes: Choice[]; selected: Choice; reason: string }[] = [
    { size: 2, votes: [], selected: 'pass', reason: 'no_quorum' },
    { size: 2, votes: ['A'], selected: 'pass', reason: 'no_quorum' },
    { size: 2, votes: ['A', 'A'], selected: 'A', reason: 'plurality' },
    { size: 2, votes: ['A', 'B'], selected: 'pass', reason: 'tie' },
    { size: 2, votes: ['A', 'pass'], selected: 'pass', reason: 'tie' },
    { size: 2, votes: ['pass', 'pass'], selected: 'pass', reason: 'plurality' },
    { size: 3, votes: ['A'], selected: 'pass', reason: 'no_quorum' },
    { size: 3, votes: ['A', 'A'], selected: 'A', reason: 'plurality' },
    { size: 3, votes: ['A', 'B'], selected: 'pass', reason: 'tie' },
    { size: 3, votes: ['A', 'B', 'pass'], selected: 'pass', reason: 'tie' },
    { size: 3, votes: ['pass', 'pass'], selected: 'pass', reason: 'plurality' },
    { size: 4, votes: ['B', 'B'], selected: 'B', reason: 'plurality' },
    { size: 4, votes: ['A', 'A', 'B', 'pass'], selected: 'A', reason: 'plurality' },
    { size: 5, votes: ['A', 'A'], selected: 'pass', reason: 'no_quorum' },
    { size: 5, votes: ['B', 'B', 'A'], selected: 'B', reason: 'plurality' },
  ];
  it.each(cases)('uses quorum and plurality: $size seats, $votes', ({ size, votes, selected, reason }) => {
    let room = start(size);
    votes.forEach((choice, i) => { room = vote(room, 'a' + i, choice); });
    expect(advanceTo(room, NOW + 60000).teams[0].results[0]).toMatchObject({ choice: selected, selectionReason: reason, submittedVotes: votes.length });
  });
  it('rejects late, stale, unauthorised and missing-version votes; ignores spoofed IDs', () => {
    const room = start();
    const command: Command = { type: 'vote', actionId: actionId(), round: 1, phase: 'decision', choice: 'A', revision: 1 };
    errorCode(() => applyCommand(room, player(), command, NOW + 60000), 'stale_phase');
    errorCode(() => applyCommand(room, player(), command, NOW + 75000), 'stale_round');
    errorCode(() => applyCommand(room, HOST, command, NOW), 'player_required');
    errorCode(() => applyCommand(room, PROJECTOR, command, NOW), 'read_only');
    errorCode(() => applyCommand(room, player('unknown'), command, NOW), 'player_not_found');
    errorCode(() => applyCommand(room, player(), { type: 'vote', actionId: actionId(), choice: 'A', revision: 1 }, NOW), 'missing_version');
    errorCode(() => applyCommand(room, player(), { type: 'pause', actionId: actionId() }, NOW), 'host_required');
    const spoofed = applyCommand(room, player(), { ...command, teamId: 'b', playerId: 'a1' } as Command, NOW);
    expect(Object.keys(spoofed.teams[0].votes[1]!)).toEqual(['a0']);
  });
});

describe('projections and immutable ledger', () => {
  it('shows only current assigned clues and the player’s own ballot before reveal', () => {
    let room = vote(start(3, true), 'a0', 'B');
    room = vote(room, 'a1', 'A');
    const own = getSnapshot(room, player(), NOW + 200);
    expect(own.privateClues.map(c => c.role)).toEqual(['accountant', 'analyst']);
    expect(own.myVote?.choice).toBe('B');
    expect(own.team?.myVote?.choice).toBe('B');
    expect(own.currentReveal).toBeNull();
    for (const actor of [HOST, PROJECTOR, player('b0')]) {
      const view = getSnapshot(room, actor, NOW + 200);
      expect(view.myVote).toBeNull();
      expect(view.teams.every(t => t.results.length === 0)).toBe(true);
      const json = JSON.stringify(view);
      for (const secret of ['"draws"', '"votes":', 'licence_cleared', 'promotional feature']) expect(json).not.toContain(secret);
      if (actor.kind !== 'player') expect(view.privateClues).toEqual([]);
    }
    const other = getSnapshot(room, player('a1'), NOW + 200);
    expect(other.myVote?.choice).toBe('A');
    expect(other.privateClues.map(c => c.role)).toEqual(['developer']);
    expect(own.teams[0]).not.toHaveProperty('myVote');
  });
  it('reveals shared events, full clues, counterfactuals and anonymous counts after settlement', () => {
    let room = voteTeam(start(3, true, [90, 0, 0, 0, 0]), 'a', 'A');
    room = voteTeam(room, 'b', 'B');
    const view = getSnapshot(room, PROJECTOR, NOW + 60000);
    expect(view.currentReveal).toMatchObject({ eventId: 'licence_failed', counterfactuals: { A: -2000, B: 1000, pass: 0 } });
    expect(view.currentReveal?.allClues).toHaveLength(5);
    expect(view.teams.map(t => t.balance)).toEqual([8000, 11000]);
    expect(view.teams[0].results[0].voteCounts).toEqual({ A: 3, B: 0, pass: 0 });
    expect(view.privateClues).toEqual([]);
    expect(JSON.stringify(view)).not.toContain('"submittedAt"');
    expect(room.teams[0].results).toEqual([]);
  });
  it('gives identical choices identical outcomes and shared ranks', () => {
    const room = voteTeam(voteTeam(start(3, true), 'a', 'A'), 'b', 'A');
    const view = getSnapshot(room, HOST, NOW + 60000);
    expect(view.teams.map(t => t.balance)).toEqual([13000, 13000]);
    expect(view.leaderboard.map(t => t.rank)).toEqual([1, 1]);
  });
  it('provides safe player board shells in lobby, ended and expired states', () => {
    for (const room of [lobby(), host(start(), 'end', NOW + 100), advanceTo(start(), NOW + 86_400_000)]) {
      const view = getSnapshot(room, player(), room.updatedAt);
      expect(view.team?.id).toBe('a');
      expect(view.privateClues).toEqual([]);
      expect(view.myVote).toBeNull();
      expect(view.roundInfo).toBeNull();
    }
  });
  it('does not mutate inputs or update timestamps on ordinary reads', () => {
    const room = start(); const before = JSON.stringify(room);
    getSnapshot(room, player(), NOW + 1000);
    expect(advanceTo(room, NOW + 1000).updatedAt).toBe(room.updatedAt);
    expect(JSON.stringify(room)).toBe(before);
  });
  it('derives balances from the ledger even if the cached balance is corrupt', () => {
    let room = voteTeam(start(), 'a', 'B');
    room.teams[0].balance = 999999;
    expect(getSnapshot(room, HOST, NOW + 1000).teams[0].balance).toBe(10000);
    room = advanceTo(room, NOW + 75000);
    expect(room.teams[0].results[0]).toMatchObject({ balanceBefore: 10000, balanceAfter: 11000 });
    room = voteTeam(room, 'a', 'A');
    room.teams[0].balance = -999999;
    expect(getSnapshot(room, HOST, NOW + 76000).teams[0].balance).toBe(11000);
    room = advanceTo(room, NOW + 135000);
    expect(room.teams[0].results[1]).toMatchObject({ balanceBefore: 11000, balanceAfter: 12800 });
    expect(room.teams[0].balance).toBe(12800);
  });
});

describe('automatic boundaries, pauses, ending and expiry', () => {
  const boundaries: [number, string, number, number][] = [
    [0, 'decision', 1, 0], [59999, 'decision', 1, 0], [60000, 'reveal', 1, 1],
    [74999, 'reveal', 1, 1], [75000, 'decision', 2, 1], [135000, 'reveal', 2, 2],
    [150000, 'decision', 3, 2], [210000, 'reveal', 3, 3], [225000, 'decision', 4, 3],
    [300000, 'decision', 5, 4], [360000, 'reveal', 5, 5], [375000, 'finished', 5, 5],
  ];
  it.each(boundaries)('at +%ims derives %s for deal %i with %i ledger entries', (elapsed, phase, round, entries) => {
    const view = getSnapshot(start(), HOST, NOW + elapsed);
    expect(view.phase).toBe(phase); expect(view.round).toBe(round);
    expect(view.teams[0].results).toHaveLength(entries);
    expect(view.completed).toBe(entries === 5);
  });
  it('catches up missed boundaries once and preserves settled results and timestamps', () => {
    const first = advanceTo(voteTeam(start(), 'a', 'A'), NOW + 60000);
    const room = advanceTo(first, NOW + 1_000_000);
    expect(room.status).toBe('finished');
    expect(room.teams[0].results).toHaveLength(5);
    expect(room.teams[0].results[0]).toEqual(first.teams[0].results[0]);
    expect(room.teams[0].results.map(r => r.settledAt)).toEqual([60000, 135000, 210000, 285000, 360000].map(t => NOW + t));
    expect(room.teams[0].results.slice(1).every(r => r.selectionReason === 'no_quorum')).toBe(true);
    expect(room.teams[0].balance).toBe(13000);
    expect(advanceTo(room, NOW + 2_000_000)).toEqual(room);
  });
  it('pauses the decision clock, blocks votes and shifts the schedule on resume', () => {
    const paused = host(start(), 'pause', NOW + 10000);
    expect(getPhase(paused, NOW + 200000)).toEqual({ phase: 'decision', phaseEndsAt: null, remainingMs: 50000 });
    errorCode(() => vote(paused, 'a0', 'A', NOW + 200000), 'paused');
    const resumed = host(paused, 'resume', NOW + 200000);
    expect(resumed.roundStartedAt).toBe(NOW + 190000);
    expect(getPhase(resumed, NOW + 249999).phase).toBe('decision');
    expect(getPhase(resumed, NOW + 250000).phase).toBe('reveal');
    expect(resumed.draws).toEqual(paused.draws);
  });
  it('pauses reveal without changing the ledger or random draws', () => {
    let room = host(voteTeam(start(), 'a', 'A'), 'pause', NOW + 65000);
    const ledger = structuredClone(room.teams[0].results);
    expect(getPhase(room, NOW + 200000)).toEqual({ phase: 'reveal', phaseEndsAt: null, remainingMs: 10000 });
    room = host(room, 'resume', NOW + 200000);
    expect(getPhase(room, NOW + 209999).phase).toBe('reveal');
    const next = advanceTo(room, NOW + 210000);
    expect(next.round).toBe(2); expect(next.teams[0].results).toEqual(ledger);
  });
  it('settles before pausing exactly at the decision deadline', () => {
    const paused = host(voteTeam(start(), 'a', 'B'), 'pause', NOW + 60000);
    expect(paused.teams[0].results).toHaveLength(1);
    expect(getPhase(paused, NOW + 100000).phase).toBe('reveal');
  });
  it('ends incomplete games without settling active votes and marks a settled fifth deal complete', () => {
    const early = host(voteTeam(start(), 'a', 'A'), 'end', NOW + 1000);
    expect(early.status).toBe('ended'); expect(early.teams[0].balance).toBe(10000);
    expect(getSnapshot(early, HOST, NOW + 1000).completed).toBe(false);
    const finalReveal = host(start(), 'end', NOW + 360000);
    expect(finalReveal.status).toBe('finished');
    expect(getSnapshot(finalReveal, HOST, NOW + 360000).completed).toBe(true);
    errorCode(() => vote(early, 'a0', 'A', NOW + 2000), 'room_closed');
  });
  it('settles only boundaries before expiry, including when paused', () => {
    const expired = advanceTo({ ...start(), expiresAt: NOW + 70000 }, NOW + 200000);
    expect(expired.status).toBe('expired'); expect(expired.teams[0].results).toHaveLength(1);
    expect(expired.round).toBe(1);
    const paused = host({ ...start(), expiresAt: NOW + 70000 }, 'pause', NOW + 10000);
    const pausedExpired = advanceTo(paused, NOW + 200000);
    expect(pausedExpired.status).toBe('expired'); expect(pausedExpired.teams[0].results).toHaveLength(0);
    errorCode(() => host(pausedExpired, 'resume', NOW + 200001), 'room_expired');
  });
  it.each([2, 3, 4, 5] as const)('completes five cooperative deals with %i players', size => {
    const room = play(['B', 'A', 'pass', 'B', 'A'], [99, 99, 99, 99, 99], size);
    const view = getSnapshot(room, player(), room.updatedAt);
    expect(view.phase).toBe('finished'); expect(view.completed).toBe(true);
    expect(view.team?.balance).toBe(15500); expect(view.team?.results).toHaveLength(5);
    expect(view.privateClues).toEqual([]);
  });
});

/** Pure authoritative v2 engine. Keep this and scenario.ts out of client module graphs. */
import { getClues, getDeal, getScenario, isScenarioVersion, revealFor } from './scenario';
import { COOP_TARGET, getRolePackets, PHASE_DURATIONS, quorumFor, SCENARIO_VERSION, STARTING_CASH, TOTAL_ROUNDS } from './public';
import { DomainError } from './types';
import type { Actor, Choice, Command, CreateRoomInput, JoinRoomInput, PhaseInfo, PlayerState, RoomState, RoundNumber, RoundResult, SelectionReason, Snapshot, TeamRoster, TeamSize, TeamState } from './types';
export { DomainError } from './types';

function requireThat(condition: unknown, status: number, code: string, message: string): asserts condition {
  if (!condition) throw new DomainError(status, code, message);
}
function copy<T>(value: T): T { return structuredClone(value); }
function validateVersion(room: RoomState) {
  requireThat(room.version === 2 && isScenarioVersion(room.scenarioVersion), 409, 'game_updated', 'The game has been updated. Create a new Team Capital room.');
}
function validateTime(now: number) {
  requireThat(Number.isFinite(now), 400, 'invalid_time', 'A valid server time is required.');
}
function playerFor(room: RoomState, actor: Actor): PlayerState {
  requireThat(actor.kind === 'player', 403, 'player_required', 'This action requires a player session.');
  const player = room.players.find(p => p.id === actor.playerId);
  requireThat(player, 403, 'player_not_found', 'This player does not belong to the room.');
  return player;
}
function teamFor(room: RoomState, player: PlayerState): TeamState {
  const team = room.teams.find(t => t.id === player.teamId);
  requireThat(team, 403, 'team_not_found', 'This player does not belong to a team in this room.');
  return team;
}
function validateDraws(draws: readonly number[] | undefined): asserts draws is readonly number[] {
  requireThat(Array.isArray(draws) && draws.length === TOTAL_ROUNDS && draws.every(n => Number.isInteger(n) && n >= 0 && n <= 99),
    400, 'invalid_draws', 'Starting a room requires five trusted server-generated draws from 0 to 99.');
}
function allSettled(room: RoomState): boolean { return room.teams.every(team => team.results.length === TOTAL_ROUNDS); }
function ledgerBalance(team: TeamState): number {
  return STARTING_CASH + team.results.reduce((balance, result) => balance + result.netChange, 0);
}
function rolesUnassigned(room: RoomState): boolean { return room.rosterMode === 'flexible' && room.round === 0; }
export function getRoster(room: RoomState): TeamRoster[] {
  const unassigned = rolesUnassigned(room);
  return room.teams.map(team => {
    const members = room.players.filter(member => member.teamId === team.id);
    const minPlayers = room.rosterMode === 'flexible' ? 2 : team.size;
    const maxPlayers = room.rosterMode === 'flexible' ? 5 : team.size;
    const memberView = (member: PlayerState) => ({ id: member.id, nickname: member.nickname });
    const seats = unassigned
      ? members.map(member => ({ seatIndex: member.seatIndex, roles: [], player: memberView(member) }))
      : getRolePackets(team.size).map((roles, seatIndex) => {
        const member = members.find(player => player.seatIndex === seatIndex);
        return { seatIndex, roles, player: member ? memberView(member) : null };
      });
    return { id: team.id, name: team.name, size: team.size, seats, joinedCount: members.length,
      minPlayers, maxPlayers, ready: members.length >= minPlayers && members.length <= maxPlayers };
  });
}
export function canStartRoom(room: RoomState): boolean {
  return room.status === 'lobby' && room.teams.length > 0 && getRoster(room).every(team => team.ready);
}
function assertActive(room: RoomState, now: number) {
  validateVersion(room); validateTime(now);
  requireThat(now < room.expiresAt && room.status !== 'expired', 410, 'room_expired', 'This classroom room has expired.');
  requireThat(room.status !== 'finished' && room.status !== 'ended', 409, 'room_closed', 'This room is no longer active.');
}

export function createRoom(input: CreateRoomInput, now: number): RoomState {
  validateTime(now);
  requireThat(/^[A-Z0-9]{4,12}$/.test(input.code), 400, 'invalid_code', 'Room codes must contain 4–12 uppercase letters or numbers.');
  requireThat(input.mode === 'coop' || input.mode === 'competition', 400, 'invalid_mode', 'Choose co-op or team competition.');
  requireThat(input.rosterMode === undefined || input.rosterMode === 'flexible', 400, 'invalid_roster_mode', 'Choose a supported team roster mode.');
  requireThat(Array.isArray(input.teams) && input.teams.length >= 1 && input.teams.length <= 10, 400, 'invalid_teams', 'Create between 1 and 10 teams.');
  requireThat(input.mode !== 'coop' || input.teams.length === 1, 400, 'invalid_teams', 'Co-op mode uses one shared team.');
  requireThat(input.mode !== 'competition' || input.teams.length >= 2, 400, 'invalid_teams', 'Team competition needs at least two teams.');
  requireThat(new Set(input.teams.map(team => team.id)).size === input.teams.length, 400, 'duplicate_team', 'Team identifiers must be unique.');
  const teams: TeamState[] = input.teams.map(team => {
    requireThat(typeof team.id === 'string' && team.id.length > 0 && team.id.length <= 80, 400, 'invalid_team', 'A valid team identifier is required.');
    requireThat(typeof team.name === 'string' && team.name.trim().length > 0 && team.name.trim().length <= 40, 400, 'invalid_team', 'Team names must contain 1–40 characters.');
    const size = input.rosterMode === 'flexible' ? 5 : team.size;
    requireThat(size !== undefined && [2, 3, 4, 5].includes(size), 400, 'invalid_size', 'Each team must have 2, 3, 4 or 5 seats.');
    return { id: team.id, name: team.name.trim(), size, balance: STARTING_CASH, votes: {}, results: [] };
  });
  const expiresAt = input.expiresAt ?? now + 24 * 60 * 60 * 1000;
  requireThat(Number.isFinite(expiresAt) && expiresAt > now, 400, 'invalid_expiry', 'The expiry must be in the future.');
  return { version: 2, scenarioVersion: SCENARIO_VERSION, code: input.code, mode: input.mode, status: 'lobby', round: 0,
    ...(input.rosterMode === 'flexible' ? { rosterMode: 'flexible' as const } : {}),
    createdAt: now, updatedAt: now, expiresAt, roundStartedAt: null, pausedAt: null, draws: [], teams, players: [] };
}

export function joinRoom(room: RoomState, input: JoinRoomInput, now: number): RoomState {
  assertActive(room, now);
  requireThat(room.status === 'lobby', 409, 'game_started', 'Seats can only be claimed before the game starts.');
  const team = room.teams.find(t => t.id === input.teamId);
  requireThat(team, 404, 'team_not_found', 'The selected team does not exist.');
  requireThat(typeof input.nickname === 'string' && input.nickname.trim().length > 0 && input.nickname.trim().length <= 24, 400, 'invalid_nickname', 'Nicknames must contain 1–24 characters.');
  requireThat(typeof input.playerId === 'string' && input.playerId.length > 0 && input.playerId.length <= 100, 400, 'invalid_player', 'A valid player identifier is required.');
  const existing = room.players.find(p => p.id === input.playerId);
  if (existing) {
    requireThat(existing.teamId === input.teamId && (room.rosterMode === 'flexible' || input.seatIndex === undefined || existing.seatIndex === input.seatIndex), 409, 'player_exists', 'This player already occupies a different seat.');
    return copy(room);
  }
  const automatic = room.rosterMode === 'flexible' || input.seatIndex === undefined;
  const seatIndex = automatic ? Array.from({ length: team.size }, (_, index) => index).find(index => !room.players.some(p => p.teamId === team.id && p.seatIndex === index)) : input.seatIndex;
  requireThat(!automatic || seatIndex !== undefined, 409, 'team_full', 'This team is full. Choose another team.');
  requireThat(seatIndex !== undefined && Number.isInteger(seatIndex) && seatIndex >= 0 && seatIndex < team.size, 400, 'invalid_seat', 'Select an available seat.');
  requireThat(!room.players.some(p => p.teamId === input.teamId && p.seatIndex === seatIndex), 409, 'seat_taken', 'Someone has already claimed that seat.');
  const next = copy(room);
  next.players.push({ id: input.playerId, teamId: input.teamId, seatIndex, nickname: input.nickname.trim(), joinedAt: now });
  next.updatedAt = now;
  return next;
}

function settleRound(room: RoomState, round: RoundNumber, settledAt: number) {
  validateDraws(room.draws);
  const reveal = revealFor(round, room.draws[round - 1], room.scenarioVersion);
  for (const team of room.teams) {
    if (team.results.some(result => result.round === round)) continue;
    const members = new Set(room.players.filter(p => p.teamId === team.id).map(p => p.id));
    const votes = Object.entries(team.votes[round] ?? {}).filter(([id]) => members.has(id)).map(([, vote]) => vote);
    const voteCounts: Record<Choice, number> = { A: 0, B: 0, pass: 0 };
    votes.forEach(vote => { voteCounts[vote.choice]++; });
    const quorum = quorumFor(team.size);
    let choice: Choice = 'pass';
    let selectionReason: SelectionReason = 'no_quorum';
    if (votes.length >= quorum) {
      const top = Math.max(voteCounts.A, voteCounts.B, voteCounts.pass);
      const leaders = (['A', 'B', 'pass'] as Choice[]).filter(option => voteCounts[option] === top);
      selectionReason = leaders.length === 1 ? 'plurality' : 'tie';
      if (leaders.length === 1) choice = leaders[0];
    }
    const netChange = reveal.counterfactuals[choice];
    const balanceBefore = ledgerBalance(team);
    const result: RoundResult = { ...copy(reveal), choice, selectionReason, voteCounts,
      submittedVotes: votes.length, quorum, netChange, balanceBefore,
      balanceAfter: balanceBefore + netChange, settledAt };
    team.results.push(result);
    team.balance = result.balanceAfter;
  }
}

/**
 * Reconcile every due boundary, in order, on a cloned state.
 * Services persist this result under their room transaction before applying commands.
 * There are no timers, random draws or external writes here.
 */
export function advanceTo(room: RoomState, now: number): RoomState {
  validateVersion(room); validateTime(now);
  const next = copy(room);
  next.teams.forEach(team => { team.balance = ledgerBalance(team); });
  const cutoff = Math.min(now, room.expiresAt);
  const effectiveNow = room.pausedAt === null ? cutoff : Math.min(room.pausedAt, cutoff);
  if (next.status === 'running') {
    requireThat(next.round > 0 && next.roundStartedAt !== null, 500, 'invalid_room_state', 'The running room has no active deal.');
    validateDraws(next.draws);
    while (next.status === 'running') {
      const round = next.round as RoundNumber;
      const decisionEnd: number = next.roundStartedAt! + PHASE_DURATIONS.decision;
      const revealEnd: number = decisionEnd + PHASE_DURATIONS.reveal;
      if (effectiveNow < decisionEnd) break;
      if (next.teams.some(team => !team.results.some(result => result.round === round))) {
        settleRound(next, round, decisionEnd);
        next.updatedAt = decisionEnd;
      }
      if (effectiveNow < revealEnd) break;
      if (round === TOTAL_ROUNDS) {
        next.status = 'finished'; next.pausedAt = null; next.updatedAt = revealEnd;
      } else {
        next.round = (round + 1) as RoundNumber; next.roundStartedAt = revealEnd; next.updatedAt = revealEnd;
      }
    }
  }
  if (now >= room.expiresAt && next.status !== 'expired') {
    next.status = 'expired'; next.pausedAt = null; next.updatedAt = room.expiresAt;
  }
  return next;
}

function phaseOfReconciled(room: RoomState, now: number): PhaseInfo {
  if (room.status !== 'running') return { phase: room.status, phaseEndsAt: null, remainingMs: 0 };
  const effectiveNow = room.pausedAt ?? now;
  const decisionEnd = room.roundStartedAt! + PHASE_DURATIONS.decision;
  const phase = effectiveNow < decisionEnd ? 'decision' : 'reveal';
  const end = phase === 'decision' ? decisionEnd : decisionEnd + PHASE_DURATIONS.reveal;
  return { phase, phaseEndsAt: room.pausedAt === null ? end : null, remainingMs: Math.max(0, end - effectiveNow) };
}
export function getPhase(room: RoomState, now: number): PhaseInfo { return phaseOfReconciled(advanceTo(room, now), now); }

export function applyCommand(room: RoomState, actor: Actor, command: Command, now: number, draws?: readonly number[]): RoomState {
  const next = advanceTo(room, now);
  assertActive(next, now);
  requireThat(typeof command.actionId === 'string' && command.actionId.length > 0 && command.actionId.length <= 128, 400, 'invalid_action', 'A unique action identifier is required.');
  requireThat(actor.kind !== 'projector', 403, 'read_only', 'The projector view is read-only.');
  const phase = phaseOfReconciled(next, now).phase;
  if (command.round !== undefined) requireThat(command.round === next.round, 409, 'stale_round', 'The deal has changed. Refresh before trying again.');
  if (command.phase !== undefined) requireThat(command.phase === phase, 409, 'stale_phase', 'The voting window has changed. Refresh before trying again.');
  if (command.type === 'change_team' || command.type === 'leave') {
    const member = playerFor(next, actor);
    requireThat(command.expectedPlayerId === member.id, 409, 'membership_changed', 'Your player seat has changed. Refresh before trying again.');
    requireThat(next.status === 'lobby', 409, 'roster_frozen', 'You can change teams or leave only before the game starts.');
    requireThat(command.round === 0 && command.phase === 'lobby', 400, 'missing_version', 'Membership changes must include the current lobby phase.');
    if (command.type === 'leave') next.players = next.players.filter(player => player.id !== member.id);
    else {
      const target = next.teams.find(team => team.id === command.teamId);
      requireThat(target, 404, 'team_not_found', 'The selected team no longer exists.');
      if (target.id === member.teamId) return next;
      const seatIndex = Array.from({ length: target.size }, (_, index) => index).find(index => !next.players.some(player => player.teamId === target.id && player.seatIndex === index));
      requireThat(seatIndex !== undefined, 409, 'team_full', 'This team is full. Choose another team.');
      next.players = next.players.filter(player => player.id !== member.id);
      next.players.push({ ...member, teamId: target.id, seatIndex, joinedAt: now });
    }
    next.updatedAt = now;
    return next;
  }
  if (command.type !== 'vote') {
    requireThat(actor.kind === 'host', 403, 'host_required', 'Only the host can control the room.');
    if (command.type === 'start') {
      requireThat(next.status === 'lobby', 409, 'already_started', 'The game has already started.');
      requireThat(canStartRoom(next), 409, 'empty_seats', next.rosterMode === 'flexible' ? 'Every team needs 2 to 5 joined players before starting.' : 'Fill every selected seat before starting.');
      validateDraws(draws);
      if (next.rosterMode === 'flexible') for (const team of next.teams) {
        const members = next.players.filter(member => member.teamId === team.id);
        team.size = members.length as TeamSize;
        members.forEach((member, index) => { member.seatIndex = index; });
      }
      next.draws = [...draws]; next.round = 1; next.roundStartedAt = now; next.pausedAt = null; next.status = 'running';
    } else if (command.type === 'remove_player') {
      requireThat(next.status === 'lobby', 409, 'roster_frozen', 'Players can only be removed before the game starts.');
      requireThat(next.players.some(member => member.id === command.playerId), 404, 'player_not_found', 'This player is no longer in the room.');
      next.players = next.players.filter(member => member.id !== command.playerId);
    } else if (command.type === 'remove_team') {
      requireThat(next.status === 'lobby', 409, 'roster_frozen', 'Teams can only be removed before the game starts.');
      requireThat(next.teams.some(team => team.id === command.teamId), 404, 'team_not_found', 'This team is no longer in the room.');
      requireThat(!next.players.some(member => member.teamId === command.teamId), 409, 'team_not_empty', 'Remove the players before removing this team.');
      requireThat(next.teams.length > (next.mode === 'competition' ? 2 : 1), 409, 'minimum_teams', next.mode === 'competition' ? 'Competition needs at least two teams.' : 'Cooperative mode needs one team.');
      next.teams = next.teams.filter(team => team.id !== command.teamId);
    } else if (command.type === 'pause') {
      requireThat(next.status === 'running', 409, 'cannot_pause', 'Only a running game can be paused.');
      if (next.pausedAt === null) next.pausedAt = now;
    } else if (command.type === 'resume') {
      requireThat(next.status === 'running' && next.pausedAt !== null, 409, 'not_paused', 'The game is not paused.');
      next.roundStartedAt = next.roundStartedAt! + (now - next.pausedAt);
      next.pausedAt = null;
    } else if (command.type === 'end') {
      next.status = allSettled(next) ? 'finished' : 'ended'; next.pausedAt = null;
    } else throw new DomainError(400, 'invalid_command', 'Unknown host action.');
    next.updatedAt = now;
    return next;
  }
  const player = playerFor(next, actor);
  const team = teamFor(next, player);
  requireThat(next.status === 'running' && phase === 'decision', 409, 'voting_closed', 'Voting is available only during the current decision window.');
  requireThat(next.pausedAt === null, 423, 'paused', 'The host has paused the game.');
  requireThat(command.round !== undefined && command.phase !== undefined, 400, 'missing_version', 'Votes must include the current deal and phase.');
  requireThat(command.choice === 'A' || command.choice === 'B' || command.choice === 'pass', 400, 'invalid_choice', 'Choose A, B or Pass.');
  const round = next.round as RoundNumber;
  const current = team.votes[round]?.[player.id];
  const expectedRevision = (current?.revision ?? 0) + 1;
  requireThat(Number.isSafeInteger(command.revision) && command.revision === expectedRevision, 409, 'vote_revision',
    'Your vote has changed or arrived out of order. Refresh and try again with the next revision.');
  team.votes[round] ??= {};
  team.votes[round]![player.id] = { choice: command.choice, revision: command.revision, submittedAt: now };
  next.updatedAt = now;
  return next;
}

export function getSnapshot(room: RoomState, actor: Actor, now: number): Snapshot {
  const state = advanceTo(room, now);
  const phaseInfo = phaseOfReconciled(state, now);
  const player = actor.kind === 'player' ? playerFor(state, actor) : null;
  const ownTeam = player ? teamFor(state, player) : null;
  const roles = player && ownTeam && !rolesUnassigned(state) ? getRolePackets(ownTeam.size)[player.seatIndex] : [];
  const currentRound = state.round as RoundNumber;
  const showDeal = state.round > 0 && (state.status === 'running' || state.status === 'finished');
  const showPrivate = phaseInfo.phase === 'decision' && !!player;
  const myVote = player && ownTeam && showDeal ? copy(ownTeam.votes[currentRound]?.[player.id] ?? null) : null;
  const roster = getRoster(state);
  const teams = state.teams.map((team, index) => ({
    ...roster[index],
    balance: team.balance, netProfit: team.balance - STARTING_CASH,
    votesSubmitted: state.round > 0 ? Object.keys(team.votes[currentRound] ?? {}).length : 0,
    quorum: quorumFor(rolesUnassigned(state) ? Math.max(2, Math.min(5, roster[index].joinedCount)) as TeamSize : team.size), results: copy(team.results),
  }));
  const ranked = [...teams].sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
  let rank = 1;
  const leaderboard = ranked.map((team, i) => {
    if (i > 0 && team.balance !== ranked[i - 1].balance) rank = i + 1;
    return { teamId: team.id, name: team.name, balance: team.balance, rank };
  });
  const revealed = state.round > 0 && state.teams.every(team => team.results.some(result => result.round === state.round));
  const ownSummary = ownTeam ? teams.find(team => team.id === ownTeam.id)! : null;
  return {
    code: state.code, mode: state.mode, status: state.status, round: state.round, phase: phaseInfo.phase,
    rosterMode: state.rosterMode ?? 'fixed', canStart: canStartRoom(state), currency: getScenario(state.scenarioVersion).currency,
    paused: state.status === 'running' && state.pausedAt !== null, serverNow: now,
    phaseEndsAt: phaseInfo.phaseEndsAt, remainingMs: phaseInfo.remainingMs,
    startingCash: STARTING_CASH, target: COOP_TARGET, completed: allSettled(state),
    roundInfo: showDeal ? copy(getDeal(currentRound, state.scenarioVersion).info) : null,
    currentReveal: revealed && state.status !== 'expired' ? revealFor(currentRound, state.draws[currentRound - 1], state.scenarioVersion) : null,
    teams, leaderboard, player: player ? { ...copy(player), roles } : null,
    privateClues: showPrivate ? getClues(currentRound, state.scenarioVersion).filter(clue => roles.includes(clue.role)) : [],
    myVote, team: ownSummary ? { ...copy(ownSummary), myVote } : null,
  };
}

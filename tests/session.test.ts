import { describe, expect, it } from 'vitest';
import { isAccessDenial, RequestError, SessionResponseGuard, type SessionSnapshot } from '../src/components/session';

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    code: 'ABCDEF', mode: 'coop', status: 'running', round: 1, phase: 'decision',
    rosterMode: 'flexible', canStart: false, currency: 'EUR',
    paused: false, serverNow: 1000, phaseEndsAt: 61_000, remainingMs: 60_000,
    startingCash: 10_000, target: 15_000, completed: false, roundInfo: null,
    currentReveal: null, teams: [], leaderboard: [], player: null,
    privateClues: [], myVote: null, team: null, ...overrides,
  };
}

describe('session response ordering', () => {
  it('does not let a delayed command restore the decision screen after a newer reveal poll', () => {
    const guard = new SessionResponseGuard();
    const command = guard.begin();
    const poll = guard.begin();
    expect(guard.accept(poll, snapshot({ serverNow: 61_000, phase: 'reveal' }))).toBe(true);
    expect(guard.accept(command, snapshot({ serverNow: 60_999 }))).toBe(false);
  });

  it('orders by server time even when requests are processed in a different order from their start', () => {
    const guard = new SessionResponseGuard();
    const command = guard.begin();
    const poll = guard.begin();
    expect(guard.accept(poll, snapshot({ serverNow: 1001 }))).toBe(true);
    expect(guard.accept(command, snapshot({ serverNow: 1002, myVote: { choice: 'B', revision: 1, submittedAt: 1002 } }))).toBe(true);
    expect(guard.accept(poll, snapshot({ serverNow: 1001 }))).toBe(false);
  });

  it('does not regress a round or phase when snapshots have the same millisecond timestamp', () => {
    const guard = new SessionResponseGuard();
    expect(guard.accept(guard.begin(), snapshot({ phase: 'reveal' }))).toBe(true);
    expect(guard.accept(guard.begin(), snapshot())).toBe(false);
    expect(guard.accept(guard.begin(), snapshot({ round: 2 }))).toBe(true);
    expect(guard.accept(guard.begin(), snapshot({ round: 1, phase: 'reveal' }))).toBe(false);
    expect(guard.accept(guard.begin(), snapshot({ round: 5, phase: 'finished', status: 'finished' }))).toBe(true);
    expect(guard.accept(guard.begin(), snapshot({ round: 5, phase: 'reveal' }))).toBe(false);
  });

  it('keeps the newest saved vote revision when equal-time responses arrive out of order', () => {
    const guard = new SessionResponseGuard();
    const command = guard.begin();
    const poll = guard.begin();
    expect(guard.accept(poll, snapshot({ myVote: { choice: 'A', revision: 1, submittedAt: 1000 } }))).toBe(true);
    expect(guard.accept(command, snapshot({ myVote: { choice: 'B', revision: 2, submittedAt: 1000 } }))).toBe(true);
    expect(guard.accept(guard.begin(), snapshot({ myVote: { choice: 'A', revision: 1, submittedAt: 1000 } }))).toBe(false);
  });

  it('uses request order only when all authoritative ordering fields are equal', () => {
    const guard = new SessionResponseGuard();
    const earlier = guard.begin();
    const later = guard.begin();
    expect(guard.accept(later, snapshot({ paused: true }))).toBe(true);
    expect(guard.accept(earlier, snapshot({ paused: false }))).toBe(false);
  });

  it('blocks all already-in-flight responses after an authentication denial', () => {
    const guard = new SessionResponseGuard();
    const command = guard.begin();
    const earlierPoll = guard.begin();
    const deniedPoll = guard.begin();
    expect(guard.deny(deniedPoll)).toBe(true);
    expect(guard.accept(command, snapshot({ serverNow: 2000 }))).toBe(false);
    expect(guard.accept(earlierPoll, snapshot({ serverNow: 3000 }))).toBe(false);
    expect(guard.isCurrent(command)).toBe(false);
    const afterRecovery = guard.begin();
    expect(guard.accept(afterRecovery, snapshot({ serverNow: 4000 }))).toBe(true);
    expect(guard.deny(earlierPoll)).toBe(false);
    expect(guard.isCurrent(afterRecovery)).toBe(true);
  });

  it('does not let a stale network failure overwrite a successful newer response', () => {
    const guard = new SessionResponseGuard();
    const oldPoll = guard.begin();
    const recentPoll = guard.begin();
    expect(guard.accept(recentPoll, snapshot())).toBe(true);
    expect(guard.isRelevantFailure(oldPoll)).toBe(false);
    expect(guard.isRelevantFailure(guard.begin())).toBe(true);
  });

  it('invalidates pending requests when the session is unmounted or changed', () => {
    const guard = new SessionResponseGuard();
    const previous = guard.begin();
    guard.invalidate();
    expect(guard.accept(previous, snapshot())).toBe(false);
    expect(guard.accept(guard.begin(), snapshot({ code: 'UVWXYZ', phase: 'lobby', round: 0, status: 'lobby' }))).toBe(true);
  });
  it('invalidates every old poll and command after a successful leave acknowledgement', () => {
    const guard = new SessionResponseGuard();
    const leave = guard.begin();
    const poll = guard.begin();
    expect(guard.accept(poll, snapshot({
      player: { id: 'old-player', nickname: 'Alex', teamId: 'a', seatIndex: 0, joinedAt: 0, roles: [] },
    }))).toBe(true);
    expect(guard.depart(leave, 'old-player')).toBe(true);
    expect(guard.accept(poll, snapshot({ serverNow: 2000 }))).toBe(false);
    expect(guard.deny(poll)).toBe(false);
    expect(guard.depart(leave, 'old-player')).toBe(false);
  });

  it('does not let a delayed leave acknowledgement remove a newly joined identity', () => {
    const guard = new SessionResponseGuard();
    const leave = guard.begin();
    const rejoined = guard.begin();
    expect(guard.accept(rejoined, snapshot({
      player: { id: 'new-player', nickname: 'Alex', teamId: 'b', seatIndex: 0, joinedAt: 10, roles: [] },
    }))).toBe(true);
    expect(guard.depart(leave, 'old-player')).toBe(false);
    expect(guard.isCurrent(rejoined)).toBe(true);
  });

  it('ignores pre-departure authentication failures after a leave starts', () => {
    const guard = new SessionResponseGuard();
    const oldPoll = guard.begin();
    guard.invalidate();
    const leave = guard.begin();
    expect(guard.deny(oldPoll)).toBe(false);
    expect(guard.depart(leave, 'old-player')).toBe(true);
    const newSession = guard.begin();
    expect(guard.accept(newSession, snapshot({ serverNow: 2000 }))).toBe(true);
    expect(guard.accept(oldPoll, snapshot({ serverNow: 3000 }))).toBe(false);
  });

  it('keeps missing-team errors recoverable without treating them as lost room access', () => {
    expect(isAccessDenial(new RequestError('Team removed', 404, 'team_not_found'))).toBe(false);
    expect(isAccessDenial(new RequestError('Room missing', 404, 'room_not_found'))).toBe(true);
    expect(isAccessDenial(new RequestError('Sign in again', 401, 'authentication_required'))).toBe(true);
    expect(isAccessDenial(new RequestError('Membership changed', 409, 'membership_changed'))).toBe(false);
  });

  it('cannot restore the previous team from an in-flight poll after switching at the same timestamp', () => {
    const guard = new SessionResponseGuard();
    const oldPoll = guard.begin();
    guard.invalidate();
    const switchRequest = guard.begin();
    const member = { id: 'player', nickname: 'Alex', seatIndex: 0, joinedAt: 0, roles: [] };
    expect(guard.accept(switchRequest, snapshot({ player: { ...member, teamId: 'new-team' } }))).toBe(true);
    expect(guard.accept(oldPoll, snapshot({ player: { ...member, teamId: 'old-team' } }))).toBe(false);
  });

});

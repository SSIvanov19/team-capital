/** Safe v2 client/server contracts. No authored clues, future outcomes or RNG belong here. */
export type RoleId = 'accountant' | 'analyst' | 'developer' | 'operations' | 'coordinator';
export type TeamSize = 2 | 3 | 4 | 5;
export type RosterMode = 'fixed' | 'flexible';
export type RoomMode = 'coop' | 'competition';
export type ScenarioVersion = 'team-capital-1' | 'team-capital-2';
export type Currency = 'GBP' | 'EUR';
export type RoundNumber = 1 | 2 | 3 | 4 | 5;
export type RoomStatus = 'lobby' | 'running' | 'finished' | 'ended' | 'expired';
export type Phase = 'lobby' | 'decision' | 'reveal' | 'finished' | 'ended' | 'expired';
export type Choice = 'A' | 'B' | 'pass';
export type Actor = { kind: 'host' } | { kind: 'projector' } | { kind: 'player'; playerId: string };
export interface PlayerState { id: string; teamId: string; seatIndex: number; nickname: string; joinedAt: number }
export interface VoteRecord { choice: Choice; revision: number; submittedAt: number }
export interface ClueDTO { role: RoleId; text: string }
export interface DealOptionDTO { value: Choice; label: string; advertisedPayment: number | null; description: string }
export interface DealDTO { number: RoundNumber; title: string; description: string; options: DealOptionDTO[]; notice: string }
export interface Counterfactuals { A: number; B: number; pass: 0 }
export interface RevealDTO {
  round: RoundNumber; title: string; eventId: string; eventLabel: string;
  counterfactuals: Counterfactuals; explanation: string; allClues: ClueDTO[];
  options: DealOptionDTO[];
}
export type SelectionReason = 'plurality' | 'tie' | 'no_quorum';
export interface RoundResult extends RevealDTO {
  choice: Choice; selectionReason: SelectionReason; voteCounts: Record<Choice, number>;
  submittedVotes: number; quorum: number; netChange: number; balanceBefore: number; balanceAfter: number;
  settledAt: number;
}
export interface TeamState {
  id: string; name: string; size: TeamSize; balance: number;
  votes: Partial<Record<RoundNumber, Record<string, VoteRecord>>>;
  results: RoundResult[];
}
export interface RoomState {
  version: 2; scenarioVersion: ScenarioVersion; code: string; mode: RoomMode; status: RoomStatus; round: 0 | RoundNumber;
  /** Absent on existing rooms, which retain their configured fixed roster. */
  rosterMode?: 'flexible';
  createdAt: number; updatedAt: number; expiresAt: number;
  roundStartedAt: number | null; pausedAt: number | null;
  /** Five server-generated integers 0–99. Never project or send this field to clients. */
  draws: number[];
  teams: TeamState[]; players: PlayerState[];
}
export interface CreateRoomInput {
  code: string; mode: RoomMode; teams: { id: string; name: string; size?: TeamSize }[]; expiresAt?: number; rosterMode?: 'flexible';
}
export interface JoinRoomInput { teamId: string; seatIndex?: number; nickname: string; playerId: string }
export interface CommandBase { actionId: string; round?: number; phase?: Phase }
export type Command = CommandBase & (
  | { type: 'start' | 'pause' | 'resume' | 'end' }
  | { type: 'remove_player'; playerId: string }
  | { type: 'remove_team'; teamId: string }
  | { type: 'change_team'; teamId: string; expectedPlayerId: string }
  | { type: 'leave'; expectedPlayerId: string }
  | { type: 'vote'; choice: Choice; revision: number }
);
export interface SeatDTO {
  seatIndex: number; roles: RoleId[];
  player: { id: string; nickname: string; connected?: boolean; lastSeenAt?: number | null } | null;
}
export interface TeamRoster {
  id: string; name: string; size: TeamSize; seats: SeatDTO[];
  joinedCount: number; minPlayers: number; maxPlayers: number; ready: boolean;
}
export interface LobbySnapshot {
  code: string; mode: RoomMode; status: RoomStatus; rosterMode: RosterMode; canStart: boolean; currency: Currency; teams: TeamRoster[];
}
export interface TeamSummary extends TeamRoster {
  balance: number; netProfit: number; votesSubmitted: number; quorum: number; results: RoundResult[];
}
export interface PlayerTeamDTO extends TeamSummary { myVote: VoteRecord | null }
export interface LeaderboardEntry { teamId: string; name: string; balance: number; rank: number }
export interface Snapshot {
  code: string; mode: RoomMode; status: RoomStatus; round: 0 | RoundNumber; phase: Phase;
  rosterMode: RosterMode; canStart: boolean; currency: Currency;
  paused: boolean; serverNow: number; phaseEndsAt: number | null; remainingMs: number;
  startingCash: number; target: number; completed: boolean;
  roundInfo: DealDTO | null; currentReveal: RevealDTO | null;
  teams: TeamSummary[]; leaderboard: LeaderboardEntry[];
  player: (PlayerState & { roles: RoleId[] }) | null;
  privateClues: ClueDTO[]; myVote: VoteRecord | null; team: PlayerTeamDTO | null;
}
export interface LeaveResult { left: true }
export type CommandResult = Snapshot | LeaveResult;
export interface PhaseInfo { phase: Phase; phaseEndsAt: number | null; remainingMs: number }
export class DomainError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.name = 'DomainError'; this.status = status; this.code = code;
  }
}

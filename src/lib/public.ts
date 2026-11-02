import type { RoleId, TeamSize } from './types';
export const ROLE_LABELS: Record<RoleId, string> = {
  accountant: 'Accountant', analyst: 'Analyst', developer: 'Developer', operations: 'Operations', coordinator: 'Coordinator',
};
export function getRolePackets(size: TeamSize): RoleId[][] {
  if (size === 2) return [['accountant', 'analyst'], ['developer', 'operations', 'coordinator']];
  if (size === 3) return [['accountant', 'analyst'], ['developer'], ['operations', 'coordinator']];
  if (size === 4) return [['accountant'], ['analyst'], ['developer'], ['operations', 'coordinator']];
  return [['accountant'], ['analyst'], ['developer'], ['operations'], ['coordinator']];
}
export const PHASE_DURATIONS = { decision: 60_000, reveal: 15_000 } as const;
export const STARTING_CASH = 10_000;
export const COOP_TARGET = 15_000;
export const TOTAL_ROUNDS = 5;
export const SCENARIO_VERSION = 'team-capital-2' as const;
export function quorumFor(size: TeamSize): number { return Math.max(2, Math.ceil(size / 2)); }

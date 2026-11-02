/** SERVER ONLY: all private clues and authored outcome tables live here. */
import type { ClueDTO, Counterfactuals, DealDTO, RevealDTO, RoleId, RoundNumber, ScenarioVersion } from './types';
import { DomainError } from './types';

export interface ScenarioEvent {
  id: string; label: string; weight: number; counterfactuals: Counterfactuals; explanation: string;
}
export interface DealDefinition { info: DealDTO; clues: Record<RoleId, string>; events: ScenarioEvent[] }
import { SCENARIO_VERSION } from './public';
import { LEGACY_DEALS } from './scenario-legacy';
import { EURO_DEALS } from './scenario-euro';
export { EURO_DEALS as DEALS } from './scenario-euro';
const scenarios = {
  'team-capital-1': { currency: 'GBP', deals: LEGACY_DEALS },
  'team-capital-2': { currency: 'EUR', deals: EURO_DEALS },
} as const;
export function isScenarioVersion(value: unknown): value is ScenarioVersion {
  return value === 'team-capital-1' || value === 'team-capital-2';
}
export function getScenario(version: ScenarioVersion) {
  if (!isScenarioVersion(version)) throw new DomainError(409, 'game_updated', 'This scenario version is not supported. Create a new room to play.');
  return scenarios[version];
}

export function getDeal(round: RoundNumber, version: ScenarioVersion = SCENARIO_VERSION): DealDefinition {
  const deal = getScenario(version).deals[round - 1];
  if (!deal) throw new DomainError(400, 'invalid_round', 'That deal does not exist.');
  return deal;
}
export function getClues(round: RoundNumber, version: ScenarioVersion = SCENARIO_VERSION): ClueDTO[] {
  return Object.entries(getDeal(round, version).clues).map(([role, text]) => ({ role: role as RoleId, text }));
}
export function eventFor(round: RoundNumber, draw: number, version: ScenarioVersion = SCENARIO_VERSION): ScenarioEvent {
  if (!Number.isInteger(draw) || draw < 0 || draw > 99) throw new DomainError(400, 'invalid_draw', 'A server draw must be an integer from 0 to 99.');
  let threshold = 0;
  for (const event of getDeal(round, version).events) { threshold += event.weight; if (draw < threshold) return event; }
  throw new DomainError(500, 'invalid_scenario', 'The authored outcome probabilities do not total 100.');
}
export function revealFor(round: RoundNumber, draw: number, version: ScenarioVersion = SCENARIO_VERSION): RevealDTO {
  const deal = getDeal(round, version); const event = eventFor(round, draw, version);
  return structuredClone({ round, title: deal.info.title, eventId: event.id, eventLabel: event.label,
    counterfactuals: event.counterfactuals, explanation: event.explanation, allClues: getClues(round, version), options: deal.info.options });
}

import { describe, expect, it } from 'vitest';
import { eventFor, getClues, getDeal, getScenario, revealFor } from '../src/lib/scenario';
import type { Choice, RoundNumber } from '../src/lib/types';

const rounds = [1, 2, 3, 4, 5] as const;
const version = 'team-capital-2' as const;

describe('approved euro scenario contracts', () => {
  it.each([
    [1, 0, 1000, 2600], [1, 99, 1000, 2600],
    [2, 0, 1500, 3000], [2, 59, 1500, 3000], [2, 60, 1500, -1000], [2, 99, 1500, -1000],
    [3, 0, 3500, 2000], [3, 69, 3500, 2000], [3, 70, -1500, 2000], [3, 99, -1500, 2000],
    [4, 0, -1500, -800], [4, 99, -1500, -800],
    [5, 0, 4000, 2000], [5, 69, 4000, 2000], [5, 70, -2000, 0], [5, 99, -2000, 0],
  ])('round %i draw %i matches the agreed contract', (round, draw, A, B) => {
    expect(eventFor(round as RoundNumber, draw, version).counterfactuals).toEqual({ A, B, pass: 0 });
  });

  it('has exactly five complete perspectives and the approved probability distribution', () => {
    const distributions = [[100], [60, 40], [70, 30], [100], [70, 30]];
    for (const round of rounds) {
      const clues = getClues(round, version);
      expect(clues.map(clue => clue.role).sort()).toEqual(['accountant', 'analyst', 'coordinator', 'developer', 'operations']);
      const frequencies = new Map<string, number>();
      for (let draw = 0; draw < 100; draw++) {
        const event = eventFor(round, draw, version);
        frequencies.set(event.id, (frequencies.get(event.id) || 0) + 1);
        expect(event.counterfactuals.pass).toBe(0);
      }
      expect([...frequencies.values()]).toEqual(distributions[round - 1]);
      expect(JSON.stringify(getDeal(round, version))).not.toContain('£');
      expect(getDeal(round, version).info.options.map(option => option.value)).toEqual(['A', 'B', 'pass']);
    }
  });

  it('keeps the minimum order, fixed deadline and cancellation refund explicit', () => {
    expect(getDeal(1, version).clues.coordinator).toContain('1,000 licences');
    expect(getDeal(1, version).clues.analyst).toContain('200 new licences');
    expect(getDeal(4, version).clues.operations).toContain('the following Monday');
    expect(getDeal(4, version).clues.developer).toContain('before work can begin');
    expect(getDeal(5, version).clues.operations).toContain('refunds all €1,500');
    expect(getDeal(5, version).clues.coordinator).toContain('equipment damage only');
    expect(getDeal(5, version).clues.coordinator).toContain('neither option receives its client fee');
  });

  it('keeps the cautious route above target in every shared-event combination', () => {
    const choices: Choice[] = ['B', 'A', 'B', 'pass', 'B'];
    const balances = new Set<number>();
    for (const event2 of [0, 99]) for (const event3 of [0, 99]) for (const event5 of [0, 99]) {
      const draws = [0, event2, event3, 0, event5];
      balances.add(10_000 + rounds.reduce((sum, round) => sum + eventFor(round, draws[round - 1], version).counterfactuals[choices[round - 1]], 0));
    }
    expect([...balances].sort((a, b) => a - b)).toEqual([16_100, 18_100]);
  });

  it('bounds every possible ending balance between €4,000 and €23,100', () => {
    let minimum = 10_000, maximum = 10_000;
    for (const round of rounds) {
      const changes = Array.from({ length: 100 }, (_, draw) => Object.values(eventFor(round, draw, version).counterfactuals)).flat();
      minimum += Math.min(...changes); maximum += Math.max(...changes);
    }
    expect(minimum).toBe(4_000); expect(maximum).toBe(23_100);
  });

  it('preserves the old currency and distinct scenario fixtures', () => {
    expect(getScenario('team-capital-1').currency).toBe('GBP');
    expect(getScenario(version).currency).toBe('EUR');
    expect(getDeal(1, 'team-capital-1').info.title).toBe('Choose a supplier');
    expect(eventFor(1, 70, 'team-capital-1').counterfactuals).toEqual({ A: -2000, B: 1000, pass: 0 });
    expect(getClues(1, 'team-capital-1')[0].text).toContain('£');
    expect(getDeal(1, version).info.title).toBe('The midnight discount');
  });

  it('does not allow a response mutation to alter later settlements', () => {
    const reveal = revealFor(1, 0, version);
    reveal.counterfactuals.B = 999_999;
    reveal.allClues[0].text = 'changed';
    expect(revealFor(1, 0, version).counterfactuals.B).toBe(2600);
    expect(getClues(1, version)[0].text).not.toBe('changed');
  });
});

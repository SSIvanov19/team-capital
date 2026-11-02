import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Choice, Phase, Snapshot, TeamSize, RoleId, RoomState } from '../../src/lib/types';
import { getRolePackets } from '../../src/lib/public';

export interface TestPlayer { context: BrowserContext; page: Page; id: string; teamId: string; roles: RoleId[] }
export interface TestSession {
  code: string; recoveryCode: string; projectorToken: string;
  host: BrowserContext; hostPage: Page; players: TestPlayer[];
}
export const SAFE_ROUTE: Choice[] = ['B', 'A', 'B', 'pass', 'B'];
export const RISK_ROUTE: Choice[] = ['A', 'B', 'A', 'A', 'A'];

export async function state(context: BrowserContext, code: string, view = 'player'): Promise<Snapshot> {
  const response = await context.request.get(`/api/rooms/${code}/state?view=${view}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

export async function command(context: BrowserContext, code: string, data: Record<string, unknown>, view = 'player'): Promise<Snapshot> {
  const snapshot = await state(context, code, view);
  const response = await context.request.post(`/api/rooms/${code}/commands?view=${view}`, {
    data: { actionId: randomUUID(), round: snapshot.round, phase: snapshot.phase, ...data },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

export async function session(browser: Browser, baseURL: string, size: TeamSize | TeamSize[], count = 1): Promise<TestSession> {
  const sizes = Array.isArray(size) ? size : Array.from({ length: count }, () => size);
  const host = await browser.newContext({ baseURL });
  const response = await host.request.post('/api/rooms', { data: { rosterMode: 'flexible', mode: sizes.length === 1 ? 'coop' : 'competition', teams: sizes.map((_, i) => ({ name: `QA Team ${i + 1}` })) } });
  expect(response.status(), await response.text()).toBe(201);
  const created = await response.json();
  const hostPage = await host.newPage();
  await hostPage.goto(`/host/${created.code}`);
  const players: TestPlayer[] = [];
  for (let team = 0; team < sizes.length; team++) {
    for (let seat = 0; seat < sizes[team]; seat++) {
      const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
      const teamId = `team-${team + 1}`;
      const joined = await context.request.post(`/api/rooms/${created.code}/join`, { data: { teamId, nickname: `Player ${team + 1}-${seat + 1}` } });
      expect(joined.status(), await joined.text()).toBe(201);
      const { playerId } = await joined.json();
      const page = await context.newPage();
      await page.goto(`/play/${created.code}`);
      players.push({ context, page, id: playerId, teamId, roles: getRolePackets(sizes[team])[seat] });
    }
  }
  return { ...created, host, hostPage, players };
}

export async function closeSession(game: TestSession): Promise<void> {
  await Promise.all([game.host.close(), ...game.players.map(player => player.context.close())]);
}

/** Changes only the isolated Playwright database; there is no HTTP test override. */
function stageRoom(code: string, change: (room: RoomState) => void): void {
  const filename = path.resolve(process.env.E2E_DATABASE_PATH || 'output/e2e/game.sqlite');
  const db = new Database(filename);
  db.pragma('busy_timeout = 5000');
  try {
    db.transaction(() => {
      const row = db.prepare('SELECT state_json FROM rooms WHERE code = ?').get(code) as { state_json: string } | undefined;
      if (!row) throw new Error('Test room does not exist in the isolated test database.');
      const room = JSON.parse(row.state_json) as RoomState;
      if (room.version !== 2) throw new Error('Expected an isolated v2 test room.');
      change(room);
      db.prepare('UPDATE rooms SET state_json = ? WHERE code = ?').run(JSON.stringify(room), code);
    }).immediate();
  } finally { db.close(); }
}

/** Emulates an existing persisted sterling room, only in the isolated test database. */
export function setLegacyScenario(code: string): void {
  stageRoom(code, room => {
    if (room.status !== 'lobby' || room.teams.some(team => team.results.length)) throw new Error('Legacy fixture requires an unstarted test room.');
    room.scenarioVersion = 'team-capital-1';
  });
}

export function setElapsed(code: string, elapsedMs: number): void {
  stageRoom(code, room => { room.roundStartedAt = Date.now() - elapsedMs; room.pausedAt = null; });
}

/** Fixes random events before any settlement, solely for repeatable test outcomes. */
export function setDraws(code: string, draws: number[]): void {
  stageRoom(code, room => {
    if (room.status !== 'running' || room.teams.some(team => team.results.length)) throw new Error('Only seed an unsettled test game.');
    if (draws.length !== 5 || draws.some(draw => !Number.isInteger(draw) || draw < 0 || draw > 99)) throw new Error('Invalid test draws.');
    room.draws = draws;
  });
}

export async function waitForPhase(page: Page, round: number, phase: Phase): Promise<void> {
  const gameState = page.getByTestId('game-state');
  await expect(gameState).toHaveAttribute('data-round', String(round));
  await expect(gameState).toHaveAttribute('data-phase', phase);
}

export async function voteInUI(player: TestPlayer, code: string, round: number, choice: Choice): Promise<void> {
  // Each browser polls independently: never click a vote before its round render.
  await waitForPhase(player.page, round, 'decision');
  await player.page.getByTestId(`vote-${choice}`).click();
  await expect(player.page.getByRole('status')).toContainText(`Saved: ${choice === 'pass' ? 'Pass' : choice}`);
  await expect.poll(async () => (await state(player.context, code)).myVote?.choice).toBe(choice);
}

export function assertPrivateProjection(view: Snapshot, player?: TestPlayer): void {
  expect(view).not.toHaveProperty('draws');
  expect(view).not.toHaveProperty('votes');
  for (const team of view.teams) {
    expect(team).not.toHaveProperty('votes');
    expect(team).not.toHaveProperty('myVote');
  }
  if (player) {
    expect(view.player?.id).toBe(player.id);
    expect(view.team?.id).toBe(player.teamId);
    expect(view.privateClues.map(clue => clue.role).sort()).toEqual([...player.roles].sort());
    expect(view.team).not.toHaveProperty('votes');
  } else {
    expect(view.privateClues).toEqual([]);
    expect(view.myVote).toBeNull();
    expect(view.team).toBeNull();
  }
}

import { request, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Choice, Snapshot, RoomState, RoleId, Phase } from '../src/lib/types';

const baseURL = process.env.CAPACITY_URL || 'http://127.0.0.1:3000';
const contexts: APIRequestContext[] = [];
const latencies: number[] = [];
const propagation: number[] = [];
const failures: string[] = [];
const safeRoute: Choice[] = ['B', 'A', 'B', 'pass', 'pass'];
const roles: RoleId[] = ['accountant', 'analyst', 'developer', 'operations', 'coordinator'];
let requestCount = 0;
let code = '';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function fail(message: string) { if (!failures.includes(message)) failures.push(message); }

async function client() {
  const context = await request.newContext({ baseURL });
  contexts.push(context);
  return context;
}

async function call(context: APIRequestContext, url: string, body?: Record<string, unknown>) {
  const began = performance.now();
  const response = body ? await context.post(url, { data: body }) : await context.get(url);
  latencies.push(performance.now() - began);
  requestCount++;
  if (!response.ok()) throw new Error(`${response.status()} ${url.split('?')[0]}: ${await response.text()}`);
  return response.json();
}

async function snapshot(context: APIRequestContext, view = 'player'): Promise<Snapshot> {
  return call(context, `/api/rooms/${code}/state?view=${view}`);
}

async function action(context: APIRequestContext, body: Record<string, unknown>, view = 'player') {
  const current = await snapshot(context, view);
  return call(context, `/api/rooms/${code}/commands?view=${view}`, { actionId: randomUUID(), round: current.round, phase: current.phase, ...body });
}

/** Optional acceleration changes only this newly created room on a dedicated test DB. */
function stage(elapsed: number) {
  const filename = process.env.CAPACITY_DATABASE_PATH;
  if (!filename) return;
  const db = new Database(filename);
  db.pragma('busy_timeout = 5000');
  try {
    db.transaction(() => {
      const stored = db.prepare('SELECT state_json FROM rooms WHERE code = ?').get(code) as { state_json: string } | undefined;
      if (!stored) throw new Error('CAPACITY_DATABASE_PATH does not contain the new capacity test room.');
      const room = JSON.parse(stored.state_json) as RoomState;
      if (room.version !== 2) throw new Error('Expected a v2 capacity room.');
      room.roundStartedAt = Date.now() - elapsed;
      room.pausedAt = null;
      db.prepare('UPDATE rooms SET state_json = ? WHERE code = ?').run(JSON.stringify(room), code);
    }).immediate();
  } finally { db.close(); }
}

async function run(): Promise<void> {
  const began = performance.now();
  try {
    const host = await client();
    const created = await call(host, '/api/rooms', { rosterMode: 'flexible', mode: 'competition', teams: Array.from({ length: 10 }, (_, i) => ({ name: `Capacity ${i + 1}` })) });
    code = created.code;
    const teams: APIRequestContext[][] = [];
    for (let teamIndex = 0; teamIndex < 10; teamIndex++) {
      const players: APIRequestContext[] = [];
      for (let seatIndex = 0; seatIndex < 5; seatIndex++) {
        const player = await client();
        await call(player, `/api/rooms/${code}/join`, { teamId: `team-${teamIndex + 1}`, nickname: `T${teamIndex + 1} P${seatIndex + 1}` });
        players.push(player);
      }
      teams.push(players);
    }
    const projector = await client();
    const pollEveryone = async () => {
      const views: Snapshot[] = await Promise.all([
        ...teams.flat().map(player => snapshot(player)), snapshot(host, 'host'),
        call(projector, `/api/rooms/${code}/state?view=projector&token=${created.projectorToken}`),
      ]);
      for (let i = 0; i < 50; i++) {
        const view = views[i];
        if (view.team?.id !== `team-${Math.floor(i / 5) + 1}`) fail('Cross-team state projection');
        if (view.phase === 'decision' && (view.privateClues.length !== 1 || view.privateClues[0].role !== roles[i % 5])) fail('Private role projection');
      }
      for (const view of views) {
        if (view.currency !== 'EUR') fail('New room did not retain euro currency');
        if ('draws' in view || 'votes' in view || view.teams.some(team => 'votes' in team || 'myVote' in team)) fail('Raw draws or individual ballot leak');
        if (view.phase === 'decision' && view.currentReveal !== null) fail('Current result exposed before deadline');
      }
      if (views[50].privateClues.length || views[51].privateClues.length || views[50].team || views[51].team || views[50].myVote || views[51].myVote) fail('Host/projector private data');
      return views;
    };
    const lobby = await snapshot(host, 'host');
    if (lobby.rosterMode !== 'flexible' || !lobby.canStart || lobby.teams.some(team => team.joinedCount !== 5 || !team.ready)) fail('Flexible classroom readiness mismatch');
    const started = await action(host, { type: 'start' }, 'host');
    if (started.teams.some((team: Snapshot['teams'][number]) => team.size !== 5 || team.quorum !== 3)) fail('Classroom roster was not frozen at five players');
    const waitPhase = async (phase: Phase, round: number, stagedElapsed: number) => {
      stage(stagedElapsed);
      const deadline = Date.now() + 80_000;
      let views: Snapshot[];
      do {
        await sleep(1000);
        views = await pollEveryone();
        if (Date.now() > deadline) throw new Error(`Timed out waiting for round ${round} ${phase}; current is ${views[50].round} ${views[50].phase}.`);
      } while (views.some(view => view.phase !== phase || view.round !== round));
      return views;
    };
    for (let round = 1; round <= 5; round++) {
      console.log(`Round ${round}: 50 players save, retry and revise private votes.`);
      await Promise.all(teams.flat().map(async player => {
        const initial = { type: 'vote', actionId: randomUUID(), round, phase: 'decision', choice: 'A', revision: 1 };
        // Same command arrives twice at once; there must still be one ballot.
        await Promise.all([
          call(player, `/api/rooms/${code}/commands?view=player`, initial),
          call(player, `/api/rooms/${code}/commands?view=player`, initial),
        ]);
        await call(player, `/api/rooms/${code}/commands?view=player`, { type: 'vote', actionId: randomUUID(), round, phase: 'decision', choice: safeRoute[round - 1], revision: 2 });
      }));
      const committed = performance.now();
      await sleep(1000);
      const synced = await pollEveryone();
      propagation.push(performance.now() - committed);
      if (synced.slice(0, 50).some(view => view.myVote?.choice !== safeRoute[round - 1] || view.myVote?.revision !== 2 || view.team?.votesSubmitted !== 5)) fail(`Round ${round}: lost revision, duplicate ballot or stale state`);
      if (synced.some(view => view.phase !== 'decision' || view.teams.some(team => team.results.length !== round - 1))) fail(`Round ${round}: early settlement before the full deadline`);
      for (let sample = 0; sample < 4; sample++) {
        await sleep(1000);
        await pollEveryone();
      }
      const reveals = await waitPhase('reveal', round, 60_050);
      const results = reveals[50].teams.map(team => team.results[round - 1]);
      if (results.some(result => !result || result.choice !== safeRoute[round - 1] || result.submittedVotes !== 5 || result.selectionReason !== 'plurality')) fail(`Round ${round}: vote settlement mismatch`);
      if (new Set(results.map(result => result.eventId)).size !== 1) fail(`Round ${round}: teams did not share one event`);
      // Several reads settle at most once; each result has one balance movement.
      const readAgain = await pollEveryone();
      if (readAgain.some(view => view.teams.some(team => team.results.length !== round))) fail(`Round ${round}: duplicate or missing settlement`);
      await waitPhase(round === 5 ? 'finished' : 'decision', round === 5 ? 5 : round + 1, 75_050);
    }
    const result = await snapshot(host, 'host');
    if (result.status !== 'finished' || result.leaderboard.length !== 10 || result.leaderboard.some(team => team.balance !== 16_100 || team.rank !== 1)) fail('Final result differs from ten tied €16,100 teams');
    const sorted = [...latencies].sort((a, b) => a - b);
    const report = {
      game: 'Team Capital', version: 2, rosterMode: 'flexible', currency: result.currency, timestamp: new Date().toISOString(), baseURL, clientNode: process.version,
      serverNode: process.env.CAPACITY_SERVER_NODE || 'not reported',
      participants: 50, teams: 10, observerClients: 2, roundsCompleted: 5,
      simulatedPhaseTime: Boolean(process.env.CAPACITY_DATABASE_PATH), forcedDraws: false,
      durationSeconds: Number(((performance.now() - began) / 1000).toFixed(2)), requests: requestCount,
      requestLatencyMs: { p50: Math.round(sorted[Math.floor(sorted.length * .5)]), p95: Math.round(sorted[Math.floor(sorted.length * .95)]), max: Math.round(sorted.at(-1)!) },
      oneSecondPollPropagationMs: propagation.map(Math.round),
      withinTwoSecondPropagationTarget: propagation.every(ms => ms <= 2000),
      finalBalances: result.leaderboard.map(team => team.balance), failures,
    };
    mkdirSync('output', { recursive: true });
    writeFileSync('output/capacity-euro-report.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (failures.length || !report.withinTwoSecondPropagationTarget) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await Promise.all(contexts.map(context => context.dispose()));
  }
}

void run();

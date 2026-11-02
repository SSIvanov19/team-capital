/** Real-time public multiplayer smoke: no clock, random-draw or database overrides. */
import { request } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
const baseURL = process.env.SMOKE_URL || 'https://team-capital.dressr.fashion';
const route = ['B', 'A', 'B', 'pass', 'B'];
const clients = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition, message) => { if (!condition) throw new Error(message); };
async function client() { const c = await request.newContext({ baseURL, timeout: 10000 }); clients.push(c); return c; }
async function api(c, path, body) {
  const r = body ? await c.post(path, { data: body }) : await c.get(path);
  check(r.ok(), `${r.status()} ${path.split('?')[0]}: ${await r.text()}`);
  return r.json();
}
let code;
async function state(c, view = 'player') {
  let error;
  for (let attempt = 0; attempt < 15; attempt++) {
    try { return await api(c, `/api/rooms/${code}/state?view=${view}`); }
    catch (e) { error = e; await sleep(1000); }
  }
  throw error;
}
async function command(c, view, data) {
  const s = await state(c, view);
  return api(c, `/api/rooms/${code}/commands?view=${view}`, { actionId: randomUUID(), round: s.round, phase: s.phase, ...data });
}
async function run() {
  const began = Date.now();
  const host = await client();
  const created = await api(host, '/api/rooms', { rosterMode: 'flexible', mode: 'competition', teams: [{ name: 'Release check 2' }, { name: 'Release check 3' }] });
  code = created.code;
  const players = [];
  for (const [team, size] of [[1, 2], [2, 3]]) for (let i = 0; i < size; i++) {
    const c = await client();
    await api(c, `/api/rooms/${code}/join`, { teamId: 'team-' + team, nickname: `Release check ${team}-${i + 1}` });
    players.push(c);
  }
  await command(host, 'host', { type: 'start' });
  console.log('Production smoke started:', code, '2 vs 3; actual 60/15-second timing');
  const completed = new Set();
  let submitted = 0;
  while (Date.now() - began < 9 * 60_000) {
    const s = await state(players[0]);
    check(s.currency === 'EUR', 'Currency mismatch');
    check(!('draws' in s), 'Private event draws leaked');
    check(s.teams.every(t => !('votes' in t) && !('myVote' in t)), 'Individual ballots leaked');
    if (s.phase === 'decision' && s.round !== submitted) {
      for (const c of players) {
        const p = await state(c);
        check(p.round === s.round && p.currentReveal === null, 'Invalid private phase projection');
        check(p.privateClues.length === p.player.roles.length, 'Role clues missing');
        await command(c, 'player', { type: 'vote', choice: route[s.round - 1], revision: 1 });
      }
      submitted = s.round;
      console.log('Round', submitted, 'all five private votes saved');
    }
    for (const result of s.team.results) if (!completed.has(result.round)) {
      const teams = s.teams.map(t => t.results.find(r => r.round === result.round));
      check(teams.every(r => r && r.eventId === result.eventId && r.netChange === result.netChange), 'Shared-event or payout mismatch');
      check(result.choice === route[result.round - 1], 'Saved votes were lost or changed');
      completed.add(result.round);
      console.log('Round', result.round, 'settled; balance', result.balanceAfter);
    }
    if (s.phase === 'finished') {
      check(s.completed && completed.size === 5, 'Game incomplete');
      check(s.teams.every(t => [16100, 18100].includes(t.balance)), 'Unexpected cautious-route balance');
      check(s.leaderboard.every(t => t.rank === 1), 'Equal teams did not share rank');
      const report = { baseURL, roomCode: code, completedAt: new Date().toISOString(), durationSeconds: (Date.now() - began) / 1000, sizes: s.teams.map(t => t.size), balances: s.teams.map(t => t.balance), rounds: completed.size, passed: true };
      await mkdir('output', { recursive: true });
      await writeFile('output/production-smoke.json', JSON.stringify(report, null, 2));
      console.log('PASS', JSON.stringify(report));
      return;
    }
    await sleep(1000);
  }
  throw new Error('Production game exceeded nine minutes');
}
try { await run(); } catch (e) { console.error(e.message); process.exitCode = 1; }
finally { await Promise.all(clients.map(c => c.dispose())); }

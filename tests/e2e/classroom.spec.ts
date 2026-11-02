import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { assertPrivateProjection, closeSession, command, RISK_ROUTE, SAFE_ROUTE, session, setDraws, setElapsed, setLegacyScenario, state, voteInUI, waitForPhase, type TestSession } from './helpers';
import type { Choice, Currency, Snapshot, TeamSize } from '../../src/lib/types';

async function startFlexible(game: TestSession, sizes: TeamSize[], currency: Currency = 'EUR') {
  const lobby = await state(game.host, game.code, 'host');
  expect(lobby.rosterMode).toBe('flexible');
  expect(lobby.currency).toBe(currency);
  expect(lobby.canStart).toBeTruthy();
  expect(lobby.teams.map(team => team.joinedCount)).toEqual(sizes);
  expect(lobby.teams.every(team => team.ready && team.seats.every(seat => seat.roles.length === 0))).toBeTruthy();
  await game.hostPage.getByRole('button', { name: 'Start game', exact: true }).click();
  await waitForPhase(game.players[0].page, 1, 'decision');
  const running = await state(game.host, game.code, 'host');
  expect(running.teams.map(team => team.size)).toEqual(sizes);
  expect(running.teams.map(team => team.quorum)).toEqual(sizes.map(size => size === 5 ? 3 : 2));
  for (const team of running.teams) {
    expect(team.seats.flatMap(seat => seat.roles).sort()).toEqual(['accountant', 'analyst', 'coordinator', 'developer', 'operations']);
  }
}

test('a host creates flexible teams and a phone guest joins without selecting a size or role', async ({ page, browser, baseURL }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Create', exact: true }).click();
  await page.getByLabel('Mode', { exact: true }).selectOption('competition');
  await page.getByLabel('Number of teams', { exact: true }).selectOption('2');
  await page.getByLabel('Team 1 name', { exact: true }).fill('Ledger');
  await page.getByLabel('Team 2 name', { exact: true }).fill('Launch');
  await expect(page.locator('#team-size')).toHaveCount(0);
  await page.getByRole('button', { name: 'Create game', exact: true }).click();
  await expect(page).toHaveURL(/\/host\/[A-Z2-9]{6}$/);
  const code = page.url().split('/').at(-1)!;
  await expect(page.getByRole('button', { name: 'Start game', exact: true })).toBeDisabled();
  const phone = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const guest = await phone.newPage();
    await guest.goto('/');
    await guest.getByLabel('Room code', { exact: true }).fill(code);
    await guest.getByRole('button', { name: 'Join', exact: true }).click();
    await guest.getByLabel('Nickname', { exact: true }).fill('Sam');
    await guest.getByLabel('Team', { exact: true }).selectOption('team-1');
    await expect(guest.getByRole('button', { name: /Accountant \+ Analyst/ })).toHaveCount(0);
    await guest.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(guest).toHaveURL(`/play/${code}`);
    const view = await state(phone, code);
    expect(view.player?.nickname).toBe('Sam');
    expect(view.currency).toBe('EUR');
    expect(view.player?.roles).toEqual([]);
    expect(view.team?.joinedCount).toBe(1);
    await expect(page.getByTestId(`remove-player-${view.player!.id}`)).toBeVisible();
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  } finally { await phone.close(); }
});

for (const size of [2, 3, 4, 5] as TeamSize[]) {
  const draw = size % 2 === 0 ? 0 : 99;
  const expectedBalance = draw === 0 ? 18_100 : 16_100;
  test(`${size} independent players complete the euro scenario with draw ${draw} through the five-round UI`, async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const game = await session(browser, baseURL!, size);
    try {
      if (size === 2) {
        mkdirSync('output/playwright', { recursive: true });
        await Promise.all(game.players.map(async player => {
          await player.page.setViewportSize({ width: 375, height: 812 });
          await player.page.emulateMedia({ reducedMotion: 'reduce' });
        }));
        await waitForPhase(game.players[1].page, 0, 'lobby');
        await game.players[1].page.screenshot({ path: 'output/playwright/euro-lobby-phone.png', fullPage: true });
      }
      await startFlexible(game, [size]);
      setDraws(game.code, Array(5).fill(draw));
      for (let round = 1; round <= 5; round++) {
        await waitForPhase(game.players[0].page, round, 'decision');
        const hostView = await state(game.host, game.code, 'host');
        assertPrivateProjection(hostView);
        expect(hostView.currentReveal).toBeNull();
        for (const player of game.players) assertPrivateProjection(await state(player.context, game.code), player);
        if (size === 2) {
          await waitForPhase(game.players[1].page, round, 'decision');
          await game.players[1].page.evaluate(() => window.scrollTo(0, 0));
          await game.players[1].page.screenshot({ path: `output/playwright/euro-round-${round}-phone-intro.png` });
        }
        if (round === 1) {
          await voteInUI(game.players[0], game.code, round, 'A');
          await voteInUI(game.players[0], game.code, round, 'B');
          const changed = await state(game.players[0].context, game.code);
          expect(changed.myVote).toMatchObject({ choice: 'B', revision: 2 });
          expect(changed.team?.votesSubmitted).toBe(1);
          expect((await state(game.players[1].context, game.code)).myVote).toBeNull();
          await expect(game.players[0].page.getByTestId('team-balance')).toContainText('€10,000');
        }
        await Promise.all(game.players.map(player => voteInUI(player, game.code, round, SAFE_ROUTE[round - 1])));
        const voted = await state(game.host, game.code, 'host');
        expect(voted.phase).toBe('decision');
        expect(voted.teams[0].votesSubmitted).toBe(size);
        expect(voted.teams[0].results).toHaveLength(round - 1);
        if (size === 2) {
          const phone = game.players[1].page;
          await expect(phone.locator('.private-clues .clue-card')).toHaveCount(3);
          await phone.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
          await expect.poll(async () => phone.evaluate(() => {
            const lastClue = document.querySelector('.private-clues .clue-card:last-child')!.getBoundingClientRect();
            const votePanel = document.querySelector('.vote-panel')!.getBoundingClientRect();
            const feedback = document.querySelector('.vote-feedback')!.getBoundingClientRect();
            return lastClue.bottom <= votePanel.top && feedback.bottom <= innerHeight;
          })).toBeTruthy();
          expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
          await phone.screenshot({ path: `output/playwright/euro-round-${round}-phone-clues.png` });
        }
        setElapsed(game.code, 60_050);
        await waitForPhase(game.players[0].page, round, 'reveal');
        await expect(game.players[0].page.getByTestId('round-result')).toBeVisible();
        const revealed = await state(game.host, game.code, 'host');
        expect(revealed.teams[0].results[round - 1]).toMatchObject({ choice: SAFE_ROUTE[round - 1], selectionReason: 'plurality', submittedVotes: size });
        expect(revealed.currentReveal?.allClues).toHaveLength(5);
        if (size === 2) {
          await waitForPhase(game.players[1].page, round, 'reveal');
          await game.players[1].page.screenshot({ path: `output/playwright/euro-round-${round}-phone-result.png`, fullPage: true });
        }
        setElapsed(game.code, 75_050);
        if (round < 5) await waitForPhase(game.players[0].page, round + 1, 'decision');
      }
      await expect(game.players[0].page.getByTestId('final-results')).toBeVisible();
      const result = await state(game.host, game.code, 'host');
      expect(result.status).toBe('finished');
      expect(result.completed).toBeTruthy();
      expect(result.currency).toBe('EUR');
      expect(result.leaderboard[0]).toMatchObject({ balance: expectedBalance, rank: 1 });
      expect(result.teams[0].results).toHaveLength(5);
      await expect(game.players[0].page.getByTestId('final-balance')).toContainText(`€${expectedBalance.toLocaleString('en-GB')}`);
      if (size === 2) await game.players[0].page.screenshot({ path: 'output/playwright/euro-final-phone.png', fullPage: true });
      await game.players[0].page.reload();
      expect((await state(game.players[0].context, game.code)).player?.id).toBe(game.players[0].id);
    } finally { await closeSession(game); }
  });
}

for (const opponentSize of [3, 4, 5] as TeamSize[]) {
  test(`a two-player team competes with ${opponentSize} players using the same events and private votes`, async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const game = await session(browser, baseURL!, [2, opponentSize]);
    const projector = await browser.newContext({ baseURL, viewport: { width: 1920, height: 1080 } });
    try {
      const projectorPage = await projector.newPage();
      await projectorPage.goto(`/projector/${game.code}?token=${game.projectorToken}`);
      await startFlexible(game, [2, opponentSize]);
      setDraws(game.code, [99, 99, 99, 99, 99]);
      for (let round = 1; round <= 5; round++) {
        await Promise.all(game.players.map(player => voteInUI(player, game.code, round, (player.teamId === 'team-1' ? SAFE_ROUTE : RISK_ROUTE)[round - 1])));
        for (const player of game.players) {
          const view = await state(player.context, game.code);
          assertPrivateProjection(view, player);
          expect(view.myVote?.choice).toBe((player.teamId === 'team-1' ? SAFE_ROUTE : RISK_ROUTE)[round - 1]);
          expect(view.currentReveal).toBeNull();
        }
        const display = await projector.request.get(`/api/rooms/${game.code}/state?view=projector&token=${game.projectorToken}`);
        expect(display.ok()).toBeTruthy();
        const displayState: Snapshot = await display.json();
        assertPrivateProjection(displayState);
        expect(displayState).not.toHaveProperty('host');
        expect(displayState.teams.every(team => team.results.length === round - 1)).toBeTruthy();
        setElapsed(game.code, 60_050);
        await waitForPhase(projectorPage, round, 'reveal');
        const revealed = await state(game.host, game.code, 'host');
        const [safe, risky] = revealed.teams.map(team => team.results[round - 1]);
        expect(safe.eventId).toBe(risky.eventId);
        expect(safe.counterfactuals).toEqual(risky.counterfactuals);
        expect(safe.allClues).toEqual(risky.allClues);
        setElapsed(game.code, 75_050);
        if (round < 5) await waitForPhase(projectorPage, round + 1, 'decision');
      }
      await expect(projectorPage.getByTestId('final-results')).toBeVisible();
      const result = await state(game.host, game.code, 'host');
      expect(result.status).toBe('finished');
      expect(result.leaderboard).toMatchObject([
        { teamId: 'team-1', balance: 16_100, rank: 1 },
        { teamId: 'team-2', balance: 5_000, rank: 2 },
      ]);
    } finally { await projector.close(); await closeSession(game); }
  });
}

test('two-, three-, four- and five-player teams share one complete classroom game', async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  const sizes: TeamSize[] = [2, 3, 4, 5];
  const game = await session(browser, baseURL!, sizes);
  try {
    await startFlexible(game, sizes);
    setDraws(game.code, [0, 0, 0, 0, 0]);
    for (let round = 1; round <= 5; round++) {
      await Promise.all(game.players.map(player => voteInUI(player, game.code, round, SAFE_ROUTE[round - 1])));
      for (const player of game.players) assertPrivateProjection(await state(player.context, game.code), player);
      setElapsed(game.code, 60_050);
      await waitForPhase(game.players[0].page, round, 'reveal');
      const view = await state(game.host, game.code, 'host');
      expect(new Set(view.teams.map(team => team.results[round - 1].eventId)).size).toBe(1);
      expect(view.teams.map(team => team.results[round - 1].submittedVotes)).toEqual(sizes);
      setElapsed(game.code, 75_050);
      if (round < 5) await waitForPhase(game.players[0].page, round + 1, 'decision');
    }
    await Promise.all(game.players.map(player => expect(player.page.getByTestId('final-balance')).toContainText('€18,100')));
    const final = await state(game.host, game.code, 'host');
    expect(final.leaderboard.map(team => team.rank)).toEqual([1, 1, 1, 1]);
    expect(final.teams.map(team => team.size)).toEqual(sizes);
  } finally { await closeSession(game); }
});

test('host lobby removal revokes identities, permits refilling and removes an empty team', async ({ browser, baseURL }) => {
  const game = await session(browser, baseURL!, [3, 2, 2]);
  const late = await browser.newContext({ baseURL });
  const refill = await browser.newContext({ baseURL });
  try {
    const removed = [game.players[0], ...game.players.filter(player => player.teamId === 'team-2')];
    await game.hostPage.getByTestId(`remove-player-${removed[0].id}`).click();
    const confirm = game.hostPage.getByRole('dialog', { name: 'Confirm removal', exact: true });
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await state(game.host, game.code, 'host')).teams[0].joinedCount).toBe(3);
    for (const player of removed) {
      await game.hostPage.getByTestId(`remove-player-${player.id}`).click();
      await confirm.getByRole('button', { name: 'Remove player', exact: true }).click();
      await expect.poll(async () => (await player.context.request.get(`/api/rooms/${game.code}/state?view=player`)).status()).toBe(401);
    }
    const newPlayerPage = await refill.newPage();
    await newPlayerPage.goto(`/join/${game.code}`);
    await newPlayerPage.getByLabel('Nickname', { exact: true }).fill('Replacement');
    await newPlayerPage.getByLabel('Team', { exact: true }).selectOption('team-1');
    await newPlayerPage.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(newPlayerPage).toHaveURL(`/play/${game.code}`);
    const newPlayerId = (await state(refill, game.code)).player!.id;
    expect((await state(game.host, game.code, 'host')).canStart).toBeFalsy();
    await game.hostPage.getByTestId('remove-team-team-2').click();
    await confirm.getByRole('button', { name: 'Remove team', exact: true }).click();
    await expect.poll(async () => (await state(game.host, game.code, 'host')).teams.length).toBe(2);
    await expect(game.hostPage.getByRole('button', { name: 'Start game', exact: true })).toBeEnabled();
    await game.hostPage.getByRole('button', { name: 'Start game', exact: true }).click();
    const survivor = game.players[1];
    await waitForPhase(survivor.page, 1, 'decision');
    const started = await state(game.host, game.code, 'host');
    expect(started.teams.map(team => team.id)).toEqual(['team-1', 'team-3']);
    expect(started.teams.map(team => team.size)).toEqual([3, 2]);
    expect(started.teams[0].seats.map(seat => seat.player?.id)).toEqual([...game.players.filter(player => player.teamId === 'team-1' && player.id !== removed[0].id).map(player => player.id), newPlayerId]);
    expect((await state(survivor.context, game.code)).privateClues.map(clue => clue.role)).toEqual(['accountant', 'analyst']);
    await expect(game.hostPage.getByTestId(`remove-player-${survivor.id}`)).toHaveCount(0);
    expect((await late.request.post(`/api/rooms/${game.code}/join`, { data: { teamId: 'team-1', nickname: 'Late' } })).status()).toBe(409);
  } finally { await late.close(); await refill.close(); await closeSession(game); }
});

test('pause, reconnect and credential replacement preserve a two-person team and its votes', async ({ browser, baseURL }) => {
  const game = await session(browser, baseURL!, 2);
  const replacement = await browser.newContext({ baseURL });
  const recoveredHost = await browser.newContext({ baseURL });
  try {
    await startFlexible(game, [2]);
    const player = game.players[1];
    await voteInUI(player, game.code, 1, 'B');
    await game.hostPage.getByRole('button', { name: 'Pause game', exact: true }).click();
    const before = await state(player.context, game.code);
    await player.page.reload();
    const after = await state(player.context, game.code);
    expect(after.paused).toBeTruthy();
    expect(after.remainingMs).toBe(before.remainingMs);
    expect(after.myVote).toMatchObject({ choice: 'B', revision: 1 });
    await expect(player.page.getByTestId('vote-A')).toBeDisabled();
    await game.hostPage.getByRole('button', { name: 'Resume game', exact: true }).click();
    await player.context.setOffline(true);
    await player.context.setOffline(false);
    await player.page.reload();
    expect((await state(player.context, game.code)).player?.id).toBe(player.id);
    const reissue = await game.host.request.post(`/api/rooms/${game.code}/reissue`, { data: { playerId: player.id } });
    expect(reissue.status()).toBe(200);
    const { recoveryCode } = await reissue.json();
    expect((await player.context.request.get(`/api/rooms/${game.code}/state?view=player`)).status()).toBe(401);
    expect((await replacement.request.post(`/api/rooms/${game.code}/recover`, { data: { kind: 'player', recoveryCode } })).status()).toBe(200);
    const restored = await state(replacement, game.code);
    expect(restored.player?.id).toBe(player.id);
    expect(restored.team?.size).toBe(2);
    expect(restored.privateClues.map(clue => clue.role)).toEqual(['developer', 'operations', 'coordinator']);
    expect(restored.myVote).toMatchObject({ choice: 'B', revision: 1 });
    expect((await replacement.request.post(`/api/rooms/${game.code}/recover`, { data: { kind: 'player', recoveryCode } })).status()).toBe(401);
    await command(replacement, game.code, { type: 'vote', choice: 'pass', revision: 2 });
    expect((await state(replacement, game.code)).myVote).toMatchObject({ choice: 'pass', revision: 2 });
    expect((await recoveredHost.request.post(`/api/rooms/${game.code}/recover`, { data: { kind: 'host', recoveryCode: game.recoveryCode } })).status()).toBe(200);
    expect((await game.host.request.get(`/api/rooms/${game.code}/state?view=host`)).status()).toBe(401);
    setElapsed(game.code, 60_050);
    const result = await state(recoveredHost, game.code, 'host');
    expect(result.teams[0].results[0]).toMatchObject({ choice: 'pass', selectionReason: 'no_quorum', submittedVotes: 1, quorum: 2, voteCounts: { A: 0, B: 0, pass: 1 }, balanceAfter: 10_000 });
  } finally { await replacement.close(); await recoveredHost.close(); await closeSession(game); }
});

test('players can change teams in the lobby while preserving identity and updating readiness', async ({ browser, baseURL }) => {
  const game = await session(browser, baseURL!, [2, 2]);
  try {
    const player = game.players[0];
    const cookieBefore = (await player.context.cookies()).find(cookie => cookie.name === `deadline_player_${game.code}`)!;
    await player.page.getByLabel('Change team', { exact: true }).selectOption('team-2');
    await player.page.getByTestId('change-team').click();
    await expect.poll(async () => (await state(player.context, game.code)).team?.id).toBe('team-2');
    const moved = await state(player.context, game.code);
    expect(moved.player?.id).toBe(player.id);
    expect(moved.player?.roles).toEqual([]);
    expect(moved.teams.map(team => team.joinedCount)).toEqual([1, 3]);
    expect(moved.canStart).toBeFalsy();
    expect(moved.team?.seats.at(-1)?.player?.id).toBe(player.id);
    const cookieAfter = (await player.context.cookies()).find(cookie => cookie.name === `deadline_player_${game.code}`)!;
    expect(cookieAfter.value === cookieBefore.value).toBeTruthy();
    await expect(game.hostPage.getByRole('button', { name: 'Start game', exact: true })).toBeDisabled();
    await player.page.getByLabel('Change team', { exact: true }).selectOption('team-1');
    await player.page.getByTestId('change-team').click();
    await expect.poll(async () => (await state(player.context, game.code)).team?.id).toBe('team-1');
    const returned = await state(player.context, game.code);
    expect(returned.canStart).toBeTruthy();
    expect(returned.team?.seats.map(seat => seat.player?.id)).toEqual([game.players[1].id, player.id]);
    await game.hostPage.getByRole('button', { name: 'Start game', exact: true }).click();
    await waitForPhase(player.page, 1, 'decision');
    expect((await state(player.context, game.code)).privateClues.map(clue => clue.role)).toEqual(['developer', 'operations', 'coordinator']);
    await expect(player.page.getByTestId('change-team')).toHaveCount(0);
    await expect(player.page.getByTestId('leave-room')).toHaveCount(0);
  } finally { await closeSession(game); }
});

test('leaving preserves host and other-room cookies; stale identity commands cannot remove a rejoined player', async ({ browser, baseURL }) => {
  const game = await session(browser, baseURL!, [2, 2]);
  try {
    const joined = await game.host.request.post(`/api/rooms/${game.code}/join`, { data: { teamId: 'team-1', nickname: 'Host player' } });
    expect(joined.status()).toBe(201);
    const oldPlayerId = (await joined.json()).playerId as string;
    const otherRoomResponse = await game.host.request.post('/api/rooms', { data: { mode: 'coop', rosterMode: 'flexible', teams: [{ name: 'Other room' }] } });
    expect(otherRoomResponse.status()).toBe(201);
    const otherCode = (await otherRoomResponse.json()).code as string;
    expect((await game.host.request.post(`/api/rooms/${otherCode}/join`, { data: { teamId: 'team-1', nickname: 'Other seat' } })).status()).toBe(201);
    const otherPlayerId = (await state(game.host, otherCode)).player!.id;
    const beforeCookies = await game.host.cookies();
    const ownCookie = beforeCookies.find(cookie => cookie.name === `deadline_player_${game.code}`)!;
    expect({ path: ownCookie.path, httpOnly: ownCookie.httpOnly, sameSite: ownCookie.sameSite }).toEqual({ path: `/api/rooms/${game.code}`, httpOnly: true, sameSite: 'Lax' });
    const playerPage = await game.host.newPage();
    await playerPage.goto(`/play/${game.code}`);
    await playerPage.getByTestId('leave-room').click();
    const leaveDialog = playerPage.getByRole('dialog', { name: 'Leave this room?', exact: true });
    await leaveDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await state(game.host, game.code)).player?.id).toBe(oldPlayerId);
    await playerPage.getByTestId('leave-room').click();
    await leaveDialog.getByRole('button', { name: 'Leave room', exact: true }).click();
    await expect(playerPage).toHaveURL(`/join/${game.code}`);
    expect((await game.host.request.get(`/api/rooms/${game.code}/state?view=player`)).status()).toBe(401);
    expect((await state(game.host, game.code, 'host')).status).toBe('lobby');
    expect((await state(game.host, otherCode)).player?.id).toBe(otherPlayerId);
    expect((await state(game.host, otherCode, 'host')).status).toBe('lobby');
    const cookieNames = (await game.host.cookies()).map(cookie => cookie.name);
    expect(cookieNames).not.toContain(`deadline_player_${game.code}`);
    expect(cookieNames).toEqual(expect.arrayContaining([`deadline_host_${game.code}`, `deadline_host_${otherCode}`, `deadline_player_${otherCode}`]));
    await playerPage.getByLabel('Nickname', { exact: true }).fill('Host rejoined');
    await playerPage.getByLabel('Team', { exact: true }).selectOption('team-2');
    await playerPage.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(playerPage).toHaveURL(`/play/${game.code}`);
    const rejoined = await state(game.host, game.code);
    expect(rejoined.player?.id).not.toBe(oldPlayerId);
    expect(rejoined.team?.id).toBe('team-2');
    for (const staleCommand of [{ type: 'leave' }, { type: 'change_team', teamId: 'team-1' }]) {
      const rejected = await game.host.request.post(`/api/rooms/${game.code}/commands?view=player`, { data: { actionId: randomUUID(), round: 0, phase: 'lobby', expectedPlayerId: oldPlayerId, ...staleCommand } });
      expect(rejected.status()).toBe(409);
      expect((await rejected.json()).error).toBe('membership_changed');
      expect('set-cookie' in rejected.headers()).toBeFalsy();
      const preserved = await state(game.host, game.code);
      expect(preserved.player?.id).toBe(rejoined.player?.id);
      expect(preserved.team?.id).toBe('team-2');
    }
  } finally { await closeSession(game); }
});

test('a full destination cannot receive a player and membership locks when the game starts', async ({ browser, baseURL }) => {
  const game = await session(browser, baseURL!, [2, 5]);
  try {
    const player = game.players[0];
    await expect(player.page.getByLabel('Change team', { exact: true }).locator('option[value="team-2"]')).toBeDisabled();
    const response = await player.context.request.post(`/api/rooms/${game.code}/commands?view=player`, { data: { actionId: randomUUID(), round: 0, phase: 'lobby', type: 'change_team', teamId: 'team-2', expectedPlayerId: player.id } });
    expect(response.status()).toBe(409);
    expect((await response.json()).error).toBe('team_full');
    expect((await state(player.context, game.code)).team?.id).toBe('team-1');
    await startFlexible(game, [2, 5]);
    await expect(player.page.getByTestId('change-team')).toHaveCount(0);
    await expect(player.page.getByTestId('leave-room')).toHaveCount(0);
    for (const action of [{ type: 'leave' }, { type: 'change_team', teamId: 'team-2' }]) {
      const blocked = await player.context.request.post(`/api/rooms/${game.code}/commands?view=player`, { data: { actionId: randomUUID(), round: 1, phase: 'decision', expectedPlayerId: player.id, ...action } });
      expect(blocked.status()).toBe(409);
    }
    expect((await state(player.context, game.code)).player?.id).toBe(player.id);
  } finally { await closeSession(game); }
});

test('a committed leave whose response is lost still returns the player to joining', async ({ browser, baseURL }) => {
  const game = await session(browser, baseURL!, 2);
  try {
    const player = game.players[0];
    let committed = false;
    await player.page.route(`**/api/rooms/${game.code}/commands?view=player`, async route => {
      const payload = route.request().postDataJSON();
      if (payload?.type === 'leave' && !committed) {
        const response = await route.fetch();
        expect(response.ok()).toBeTruthy();
        expect((await response.json()).left).toBeTruthy();
        committed = true;
        await route.abort('failed');
      } else await route.continue();
    });
    await player.page.getByTestId('leave-room').click();
    await player.page.getByRole('dialog', { name: 'Leave this room?', exact: true }).getByRole('button', { name: 'Leave room', exact: true }).click();
    await expect(player.page).toHaveURL(`/join/${game.code}`);
    expect(committed).toBeTruthy();
    expect((await state(game.host, game.code, 'host')).teams[0].joinedCount).toBe(1);
    await player.page.getByLabel('Nickname', { exact: true }).fill('Reconnected after leave');
    await player.page.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(player.page).toHaveURL(`/play/${game.code}`);
    const fresh = await state(player.context, game.code);
    expect(fresh.player?.id).not.toBe(player.id);
    expect(fresh.team?.joinedCount).toBe(2);
  } finally { await closeSession(game); }
});

test('an existing sterling scenario retains its original five-round money and display', async ({ browser, baseURL }) => {
  const game = await session(browser, baseURL!, 2);
  const legacyRoute: Choice[] = ['B', 'A', 'pass', 'B', 'A'];
  try {
    setLegacyScenario(game.code);
    await game.hostPage.reload();
    await startFlexible(game, [2], 'GBP');
    for (let round = 1; round <= 5; round++) {
      await Promise.all(game.players.map(player => voteInUI(player, game.code, round, legacyRoute[round - 1])));
      expect((await state(game.players[0].context, game.code)).currency).toBe('GBP');
      await expect(game.players[0].page.getByTestId('team-balance')).toContainText('£');
      await expect(game.players[0].page.locator('body')).not.toContainText('€');
      setElapsed(game.code, 60_050);
      await waitForPhase(game.players[0].page, round, 'reveal');
      setElapsed(game.code, 75_050);
      if (round < 5) await waitForPhase(game.players[0].page, round + 1, 'decision');
    }
    await expect(game.players[0].page.getByTestId('final-balance')).toContainText('£15,500');
    const result = await state(game.host, game.code, 'host');
    expect(result.currency).toBe('GBP');
    expect(result.leaderboard[0].balance).toBe(15_500);
  } finally { await closeSession(game); }
});

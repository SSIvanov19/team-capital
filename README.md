# Team Capital

A classroom multiplayer game for **Organisational Behaviour — third-year Accounting, Finance and Digital Applications**. Teams start with **€10,000** and make five business decisions. Each specialist holds a different clue. Players discuss the opportunity, save a private vote, and see how their decision changes the team’s balance.

Play cooperatively to finish with at least **€15,000**, or compete on final money. Each team can have **two to five players**, and competing teams may have different sizes. The five rounds take **6 minutes 15 seconds**, plus joining, briefing and debriefing. The fictional money, contracts, probabilities and outcomes are teaching material, not financial advice or a psychological assessment.

The application is self-contained: Next.js, Node 24 and a persistent local SQLite database. No accounts, paid services, AI API or external realtime provider are required.

## Run locally

Use Node 24 and npm. The repository includes `.nvmrc` for version managers.

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Open <http://localhost:3000>. To run the production build:

```sh
npm run build
npm start
```

Both servers bind to all network interfaces. Stop the other server before reusing its port. `npm run build` prepares the standalone server, including public files and static chunks. `npm start` launches that server directly. For a different production port, use `npm start -- --port 3001` and set `APP_URL` to match.

The launcher loads production environment files from the game directory while preserving variables already supplied by the calling environment. Relative database paths are resolved against the game directory. Rebuilding `.next` therefore does not remove the default database in `game/data/`.

### Let classroom phones join

1. Connect the hosting computer and phones to a network that permits devices to reach each other.
2. Find the computer’s LAN address, for example `192.168.1.20`.
3. Set `APP_URL=http://192.168.1.20:3000` in `.env.local` and restart the server.
4. Open that address on the host computer and one phone before the class. Create a room and scan its QR code.

`localhost` refers to each player’s own device. An invitation containing it will not connect classroom phones to the host. University guest Wi-Fi may isolate devices; use an approved network that allows the connection. Browser write requests must use the origin configured in `APP_URL`.

For an HTTPS tunnel or reverse proxy, set `APP_URL` to the exact public HTTPS origin and restart the app before creating rooms. Use that public origin in every browser so secure cookies and request-origin checks agree. Keep the app and tunnel running for the session. A read-only projector link does not grant host control, but the host recovery code does: do not project or share that code.

## Run with Docker

```sh
cp .env.example .env
# Edit APP_URL to the address participants will use.
docker compose up --build -d
docker compose ps
```

Compose exposes port 3000, runs the app as a non-root user, checks `/api/health`, and stores SQLite in the `game-data` named volume. `docker compose down` preserves that volume; `docker compose down --volumes` removes game data.

For server hosting, put the container behind an HTTPS reverse proxy and set `APP_URL` to the public origin. Run **one application replica**. SQLite WAL must use local persistent storage, not a shared network filesystem. The repository supplies deployment configuration; running it does not create a public deployment automatically.

| Variable | Purpose | Default |
|---|---|---|
| `APP_URL` | Browser origin for invitations, secure cookies and origin checks | Request origin outside Compose; `http://localhost:3000` in Compose |
| `DATABASE_PATH` | SQLite file | `./data/game.sqlite`; `/data/game.sqlite` in Docker |
| `PORT` | Server port; Compose maps this host port to container port 3000 | `3000` |

Pause before a planned restart to freeze the countdown. Otherwise wall-clock time continues while the app is unavailable, and the next authenticated request catches up all due rounds. To back up game data, stop the container and copy the complete data volume, including any WAL files; do not copy only the main database while it is being written.

## Facilitate a session

1. **Create a game.** Choose one cooperative team or competition with two to ten teams, then name the teams. There is no team-size setting; each team accepts up to five players.
2. **Keep the host recovery code privately.** It restores host access if browser cookies are lost. A room code permits joining; it does not grant host authority.
3. **Open the projector link.** Show the invitation and QR code. Students use their own phone or laptop, enter a nickname and choose a team. Roles are allocated automatically when play starts.
4. **Brief the class.** Read the short script below. Encourage face-to-face discussion and sharing each specialist’s clue.
5. **Start when every team has two to five players.** Teams need not be the same size. The host can occupy a player seat as well. Starting freezes team sizes and assigns the five specialist information packets in join order. Roles then remain fixed throughout the game.
6. **Let the rounds run.** Decision and result phases advance automatically. Pause/resume affects every team together. End session stops the game early and records its partial outcome.
7. **Debrief the decisions.** Use the history, revealed facts and alternative outcomes to discuss the quality of the process separately from luck.

Suggested briefing: “Your team has €10,000. Each round offers A, B or Pass. Read your private clue, share it aloud, and discuss the full cost and risk. You have sixty seconds. Each person saves a private vote and can change it until the deadline. Your latest saved choice counts. After the reveal, the next deal opens automatically. In co-op, aim for €15,000. In competition, the highest final balance wins.”

For three presenters:

| Presenter | Responsibility | Suggested time |
|---|---|---|
| Presenter 1 | Create the room, help players join and explain the voting rules | 1–2 minutes, ideally join before the talk |
| Presenter 2 | Introduce the first opportunity; observe information sharing while the five rounds run | 6 minutes 15 seconds of timed play |
| Presenter 3 | Lead the final discussion using the round history | 2–3 minutes |

Allow roughly ten minutes once devices are connected. Within the original 18-minute presentation, use the game in place of the case activity and shorten the surrounding explanation.

### Manage the lobby

Before starting, a player in a competition room can select another team and choose **Change team**. Full teams cannot receive a player. The move keeps the same browser identity and places the player at the end of the destination team’s join order. Readiness updates for both teams.

Players can choose **Leave**, confirm, and return to the join screen. Leaving removes that player’s membership and revokes its credential; joining again creates a new membership. Only that room’s player cookie is cleared. Host access and memberships in other rooms are preserved, including when the host is also playing. Change-team and Leave controls disappear after starting.

The host can remove an accidental or duplicate player before starting. A confirmation is required; removal revokes that player’s browser credential and any unused recovery code. Another player may then join the team. Players who remain keep their join order, and roles are assigned from that order when the game starts.

An empty team can be removed while retaining at least two teams in competition or one in co-op. Non-empty teams cannot be removed. Readiness is recalculated after each change: an empty or one-person team blocks starting. The game never silently drops an incomplete team. Once started, team membership and specialist allocations are frozen; use credential replacement to restore an existing player.

### Reconnection and recovery

Refreshing or returning in the same browser preserves the seat through an HttpOnly cookie. A temporary disconnect does not release the seat. New seats are locked once play starts.

If a player loses their browser identity, the host issues a single-use replacement recovery code for that seat. The old credential is revoked and saved votes remain. Host recovery uses the code shown on creation and replaces the previous host credential. Rooms expire after 24 hours.

Existing Team Capital rooms retain the scenario and currency with which they were created. The previous sterling scenario continues to display pounds and calculate its original outcomes; newly created rooms use the euro scenario below. Historical amounts are not converted.

Rooms created by the earlier **Deadline: Launch Together** version are not converted into Team Capital games. Opening one shows “This game has been updated. Create a new room to play.” The stored legacy room is left unchanged. Presentations and historical release evidence remain separate from this game.

## Game rules

Each of the five rounds has **60 seconds to decide**, followed by **15 seconds of results**. Every team sees the same opportunity and faces the same random event. The server waits for the full deadline, even if everyone has already voted.

- Choose **A**, **B** or **Pass**. A saved vote is private and may be changed until the deadline. Only its latest accepted revision counts.
- A team needs a quorum of submitted votes: **two** for a two-, three- or four-person team, **three** for a five-person team. Both players must vote in a two-person team.
- Once quorum is reached, the option with the uniquely highest count wins. This is a plurality, not a requirement for an absolute majority.
- A tied highest count selects **Pass**. No quorum also selects Pass.
- Missing votes are **abstentions**, not votes for Pass. They remain visible only as a submitted-vote count.
- Pass changes the balance by €0. There is no speed bonus or individual score.
- Results reveal the event, all five specialist facts, the team’s aggregate vote counts and the net outcomes that A, B and Pass would have produced. Individual ballots are never published.
- Co-op succeeds at a final balance of **€15,000 or more**. Competition ranks teams by final balance; equal balances share a rank.

For example, in a five-person team, A=2 and B=1 with two abstentions meets quorum and selects A. In a three-person team, A=1 and B=1 with one abstention meets quorum but ties, so the team passes.

Every team has all five information packets, distributed by team size:

| Team size | Role allocation |
|---|---|
| 2 | Accountant + Analyst; Developer + Operations + Coordination |
| 3 | Accountant + Analyst; Developer; Operations + Coordination |
| 4 | Accountant; Analyst; Developer; Operations + Coordination |
| 5 | Accountant; Analyst; Developer; Operations; Coordination |

The role cards are specialist responsibilities, not personality types. Combined roles receive all of their assigned clues, so every team has the same five facts regardless of its size. Before settlement, the host and projector see public deals, balances and participation counts, but no private clues, individual votes or future events.

### Facilitator answer guide — contains spoilers

The amounts below are **net changes** after the fictional deal’s costs. Advertised payment alone is not profit. Each round uses one stored integer from 0 to 99, generated on the server when the game starts. All teams use that same round’s event, and reconnecting never rerolls it.

| Round | A net result | B net result | Pass |
|---|---|---|---|
| 1 — The midnight discount | +€1,000 | +€2,600 | €0 |
| 2 — The event goes viral | +€1,500 | Normal turnout (60%): +€3,000; viral turnout (40%): −€1,000 | €0 |
| 3 — The payroll deadline | Normal power (70%): +€3,500; power cut (30%): −€1,500 | +€2,000 | €0 |
| 4 — €6,000 before breakfast | −€1,500 | −€800 | €0 |
| 5 — The ‘fully insured’ celebrity shoot | Proceeds (70%): +€4,000; cancelled (30%): −€2,000 | Proceeds: +€2,000; cancelled: €0 | €0 |

The route **B → A → B → Pass → B** finishes at **€16,100 or €18,100**, depending on whether the final shoot is cancelled or proceeds. Choosing Pass in the last round instead produces **€16,100** for every event sequence. These are useful discussion examples rather than a claim that all risk-taking is wrong. Compare minimum orders, capacity limits, shared power dependencies, missing prerequisites and cancellation exclusions. A high balance alone does not demonstrate a better team process.

### Discussion prompts

- Which specialist’s information changed your view of a deal?
- Did you distinguish the advertised payment from the net result?
- Did everyone contribute before a confident speaker set the direction?
- Was someone able to disagree or revise a vote after new evidence appeared?
- When did uncertainty make Pass reasonable, and when did you accept risk deliberately?
- Would you judge the same decision differently if the random event had gone the other way?
- How would you apply these habits to an audit, financial forecast or digital implementation?

Connect observed examples to roles, norms, status, information sharing, independent judgement and shared accountability. Belbin contributions are behaviours people can combine, such as evaluating evidence, coordinating discussion or checking details. The game does not score Belbin questionnaires. A bad financial outcome alone is not evidence of groupthink or social loafing.

## Architecture and verification

New browser-created rooms use flexible rosters. The API also accepts the earlier fixed-roster creation shape for existing integrations, and existing fixed-roster rooms retain their original membership rules. This compatibility does not convert old Deadline rooms into Team Capital rooms.

The room’s pinned scenario registry determines its currency, authored facts and outcomes. Changing the default for new games never rewrites existing rooms. The server owns clocks, random events, permissions, voting and balances. Authenticated snapshots poll once per second. Both snapshots and commands reconcile elapsed phases in a SQLite transaction, so no background scheduler is required. Commands include a round, phase, unique action identifier and vote revision. Duplicate retries do not add ballots; older revisions cannot overwrite newer ones. Host and projector projections omit private clues and ballots. Authored future facts and random draws remain outside the browser bundle and responses.

```sh
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Playwright starts a separate production server on port 3110 using `output/e2e/game.sqlite`. Set `E2E_PORT` or `E2E_DATABASE_PATH` to override those defaults. `E2E_BROWSER_CHANNEL=chrome npm run test:e2e` uses installed Google Chrome if the bundled Chromium is unavailable.

The sixteen browser cases cover two-to-five-player co-op and mixed competitions, euro formatting, private clues, mobile voting, lobby removal/refilling, team changes, leaving/rejoining, host/player cookie coexistence, scoped cookie deletion, stale membership requests, lost leave responses, recovery and the legacy sterling scenario. Helpers move only the isolated test database’s timestamps to phase boundaries. Euro games use stored draws of 0 or 99 before any result, giving repeatable event sequences; a separate unstarted test-room fixture pins the legacy scenario. No production timing, scenario or randomness override is exposed over HTTP.

### Classroom capacity test

Run against a dedicated test server, not a classroom or public session:

```sh
CAPACITY_URL=http://127.0.0.1:3111 npm run test:capacity
```

The runner creates ten teams of five, uses B → A → B → Pass → Pass to reach €16,100 independently of random events, and exercises concurrent votes, duplicate requests, revisions, repeated one-second polling and all five automatic settlements. It writes `output/capacity-euro-report.json`, recording client/server versions, latency, propagation and failures. By default it waits through the real countdowns. For a dedicated test database, `CAPACITY_DATABASE_PATH` can stage phase boundaries; the report records that choice. Never set this to a classroom or production database. `CAPACITY_SERVER_NODE` records a separately verified server runtime when it differs from the test client.

Read `output/QA-euro.md` for checks actually executed on the euro/lobby release and current environment limits. `output/QA-flexible.md`, `output/QA-v2.md`, `output/QA.md` and the earlier capacity reports preserve historical evidence. Local performance results do not guarantee the same latency on every classroom network.

## Teaching references

- Robbins, S. P. and Judge, T. A. (2013). *Organizational Behavior*, 15th ed. Pearson/Prentice Hall. Chapters 9–10, pp. 271–301 and 307–329. Roles, norms and status: pp. 277–287; process losses and cohesion: pp. 287–289; group decisions: pp. 290–296; team effectiveness: pp. 312–322.
- Colquitt, J. A., LePine, J. A. and Wesson, M. J. (2015). *Organizational Behavior: Improving Performance and Commitment in the Workplace*, 4th ed. McGraw-Hill Education. Chapters 11–12, pp. 352–378 and 390–417. Coordination and loafing: pp. 392–393; communication and teamwork: pp. 399–407.
- *Group behaviour and Work Teams.pdf*. Supplied course lecture, 30 PDF pages; publication date not stated.
- *belbins-questionnaire.pdf*. Supplied historical eight-role self-perception inventory. Used as background; no questionnaire scoring is implemented.
- [Belbin Team Roles](https://www.belbin.com/about/belbin-team-roles): the current nine behavioural contributions, including Specialist.

The scenario and mechanics are original fictional applications of these ideas. The original presentation and three-presenter script remain in the parent project’s `output` directory.

## Hosted deployment

The production game is https://team-capital.dressr.fashion. See [deployment instructions](docs/deployment.md) for the GitHub Actions, GHCR and Argo CD release flow.

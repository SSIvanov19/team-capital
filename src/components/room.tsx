'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Monitor, Pause, Play, WifiOff } from 'lucide-react';
import { Brand, CopyButton, ErrorNotice, Loading, RoleIcon } from './ui';
import { request, useSession, type CommandInput, type SessionSnapshot } from './session';
import { ROLE_LABELS } from '@/lib/public';
import type { Choice, ClueDTO, DealDTO, RevealDTO, RoundResult, Snapshot, TeamSummary } from '@/lib/types';

type Execute = (command: CommandInput) => Promise<boolean>;
const CurrencyContext = createContext<Snapshot['currency']>('EUR');
function useMoney() {
  const currency = useContext(CurrencyContext);
  const money = (value: number) => new Intl.NumberFormat('en-GB', {
    style: 'currency', currency, maximumFractionDigits: 0,
  }).format(value);
  const change = (value: number) => (value > 0 ? '+' : value < 0 ? '−' : '') + money(Math.abs(value));
  return { money, change };
}
const tone = (value: number) => value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral-money';
const choiceName = (choice: Choice) => choice === 'pass' ? 'Pass' : choice;

function RoomHeader({ s, view, offline }: { s: Snapshot; view: string; offline: boolean }) {
  return <header className="game-header">
    <Brand/>
    <div className="room-ident"><span>Room <strong>{s.code}</strong></span><span>{view === 'player' ? s.team?.name : view === 'host' ? 'Host' : 'Projector'}</span></div>
    {offline && <span className="connection-state" role="status"><WifiOff size={15}/>Reconnecting</span>}
  </header>;
}

function ConnectionGate({ error, code, host = false }: { error: string | null; code: string; host?: boolean }) {
  return <><header className="site-header"><Brand/></header><main className="recover-wrap">
    {error ? <div className="panel"><ErrorNotice message={error}/><div className="button-row">
      <Link className="button button-primary" href="/">Create or join a game</Link>
      <Link className="button button-secondary" href={`/recover?room=${code}`}>Recover session</Link>
      {!host && <Link className="button button-ghost" href={`/join/${code}`}>Join this room</Link>}
    </div></div> : <Loading/>}
  </main></>;
}

function Clock({ s }: { s: Snapshot }) {
  const seconds = Math.max(0, Math.ceil(s.remainingMs / 1000));
  return <div className={`game-clock ${seconds <= 10 && s.phase === 'decision' ? 'urgent' : ''}`} aria-label={s.paused ? 'Game paused' : `${seconds} seconds remaining`}>
    <strong>{s.paused ? 'Paused' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}</strong>
    <span>{s.paused ? 'By the host' : s.phase === 'reveal' ? s.round === 5 ? 'Final results in' : 'Next round in' : 'Time to choose'}</span>
  </div>;
}

function BalanceStrip({ s, team }: { s: Snapshot; team: TeamSummary }) {
  const { money } = useMoney();
  const rank = s.leaderboard.find(entry => entry.teamId === team.id)?.rank;
  return <div className="balance-strip">
    <div><span>Balance</span><strong className="balance-main money" data-testid="team-balance">{money(team.balance)}</strong><small>{s.mode === 'coop' ? `Target ${money(s.target)}` : `Rank ${rank} of ${s.teams.length}`}</small></div>
    <div className="round-clock"><span>Round {s.round}/5</span><Clock s={s}/></div>
  </div>;
}

function PauseNotice({ s, offline }: { s: Snapshot; offline: boolean }) {
  return <>{offline && <div className="warning-notice" role="status">Connection lost. Your saved vote is safe; reconnect to change it.</div>}
    {s.paused && <div className="pause-notice" role="status"><Pause size={16}/>The host paused the game.</div>}</>;
}

function rosterStatus(team: TeamSummary) {
  const count = team.joinedCount;
  return `${count} ${count === 1 ? 'player' : 'players'} · ${team.ready ? 'Ready' : `Needs ${Math.max(0, team.minPlayers - count)} more`}`;
}

function Roster({ s, teams, busy, onRemove }: {
  s: Snapshot; teams: TeamSummary[]; busy?: boolean;
  onRemove?: (target: { kind: 'player' | 'team'; id: string; name: string }) => void;
}) {
  return <section className="roster-section" aria-label="Players"><h2>Players</h2><div className="roster-grid">
    {teams.map(team => <article className="team-roster" key={team.id}>
      <div className="roster-heading"><div><h3>{team.name}</h3><p className={team.ready ? 'ready-text' : ''}>{rosterStatus(team)}</p></div>
        {onRemove && team.joinedCount === 0 && s.teams.length > (s.mode === 'competition' ? 2 : 1) && <button
          className="button button-ghost button-small" data-testid={`remove-team-${team.id}`} aria-label={`Remove team ${team.name}`}
          disabled={busy} onClick={() => onRemove({ kind: 'team', id: team.id, name: team.name })}>Remove team</button>}
      </div>
      <ul className="roster-list">
        {team.seats.filter(seat => seat.player).map(seat => <li key={seat.player!.id}>
          <div><strong>{seat.player!.nickname}</strong>{seat.roles.length > 0 && <span>{seat.roles.map(role => ROLE_LABELS[role]).join(' + ')}</span>}</div>
          <div className="roster-actions"><span className={seat.player!.connected === false ? 'offline-text' : 'presence-text'}>{seat.player!.connected === false ? 'Offline' : 'Joined'}</span>
            {onRemove && <button className="button button-ghost button-small" data-testid={`remove-player-${seat.player!.id}`} aria-label={`Remove ${seat.player!.nickname}`}
              disabled={busy} onClick={() => onRemove({ kind: 'player', id: seat.player!.id, name: seat.player!.nickname })}>Remove</button>}
          </div>
        </li>)}
      </ul>
      {team.joinedCount === 0 && <p className="empty-roster">No players yet</p>}
    </article>)}
  </div></section>;
}

function StartingGoal({ s }: { s: Snapshot }) {
  const { money } = useMoney();
  return <p>Start {money(s.startingCash)} · {s.mode === 'coop' ? 'Target ' + money(s.target) : 'Highest balance wins'}</p>;
}

function LobbyRules({ s }: { s: Snapshot }) {
  const { money } = useMoney();
  return <details className="help-details">
    <summary>How to play</summary>
    <p>{s.mode === 'coop' ? 'Reach ' + money(s.target) + ' from a ' + money(s.startingCash) + ' start.' : 'Start with ' + money(s.startingCash) + '. The highest final balance wins; equal balances share the rank.'}</p>
    <ol><li>Read your private clues and share them with your team.</li><li>Choose A, B or Pass. Votes are private and can change during the 60-second round.</li><li>See the result for 15 seconds. The next round starts automatically.</li></ol>
    <p>Five rounds. The option with the most votes wins; a tie means Pass. Teams of 2–4 need two votes; teams of 5 need three. Missing votes are abstentions.</p>
    <p>All teams face the same event. Quoted payments are before costs. Pass changes your balance by {money(0)}.</p>
  </details>;
}

function ShareRoom({ s, projector = false }: { s: SessionSnapshot; projector?: boolean }) {
  const url = s.host?.joinUrl || `${typeof window !== 'undefined' ? window.location.origin : ''}/join/${s.code}`;
  return <section className="share-panel" aria-label="Join this room">
    <QRCodeSVG value={url} size={projector ? 156 : 112} level="M" title="Scan to join Team Capital"/>
    <div><span>Room code</span><strong className="share-code">{s.code}</strong><div className="button-row"><CopyButton text={url}/>
      {!projector && <Link className="button button-secondary button-small" href={`/join/${s.code}`}>Join as a player</Link>}
    </div></div>
  </section>;
}

function HostRecovery({ code }: { code: string }) {
  const [value, setValue] = useState('');
  return <details className="help-details" onToggle={event => {
    if (event.currentTarget.open) setValue(sessionStorage.getItem(`deadline-recovery-${code}`) || '');
  }}><summary>Host recovery code</summary><p>Save this privately to restore host access.</p>
    {value ? <div className="recovery-value"><code>{value}</code><CopyButton text={value} label="Copy code"/></div> : <p>Use the code saved when you created the room.</p>}
  </details>;
}

function Standings({ s, ownId }: { s: Snapshot; ownId?: string }) {
  const { money, change } = useMoney();
  return <section className="standings-section"><h2>{s.mode === 'competition' ? 'Standings' : 'Team balance'}</h2>
    <div className="table-scroll"><table className="standings-table"><thead><tr>{s.mode === 'competition' && <th scope="col">Rank</th>}<th scope="col">Team</th><th scope="col" className="number-cell">Balance</th><th scope="col" className="number-cell">{s.phase === 'reveal' ? 'Return' : 'Change'}</th>{s.phase === 'reveal' && <th scope="col">Choice</th>}{s.phase === 'decision' && <th scope="col" className="number-cell">Voted</th>}</tr></thead>
      <tbody>{s.leaderboard.map(entry => {
        const team = s.teams.find(item => item.id === entry.teamId)!;
        const result = team.results.find(item => item.round === s.round);
        const delta = s.phase === 'reveal' && result ? result.netChange : team.netProfit;
        return <tr key={team.id} className={team.id === ownId ? 'own-team' : ''}>
          {s.mode === 'competition' && <td>{entry.rank}</td>}<th scope="row">{team.name}</th><td className="number-cell money">{money(team.balance)}</td><td className={`number-cell money ${tone(delta)}`}>{change(delta)}</td>{s.phase === 'reveal' && <td>{result ? choiceName(result.choice) : '—'}</td>}
          {s.phase === 'decision' && <td className="number-cell">{team.votesSubmitted}/{team.size}</td>}
        </tr>;
      })}</tbody>
    </table></div>
  </section>;
}

function Opportunity({ deal }: { deal: DealDTO }) {
  const { money } = useMoney();
  return <section className="opportunity">
    <h1>{deal.title}</h1><p className="deal-description">{deal.description}</p>
    <div className="deal-options">{deal.options.filter(option => option.value !== 'pass').map(option => <div className="deal-option" key={option.value}>
      <span className="option-letter">{option.value}</span><h2>{option.label}</h2><strong className="money">{money(option.advertisedPayment || 0)}</strong>
    </div>)}</div>
    <p className="quote-note">Quoted payments before costs; conditions apply. Combine your clues.</p>
  </section>;
}

function Clue({ clue }: { clue: ClueDTO }) {
  return <article className="clue-card"><h3><RoleIcon role={clue.role} size={16}/>{ROLE_LABELS[clue.role]}</h3><p>{clue.text}</p></article>;
}

function Decision({ s, busy, offline, command }: { s: Snapshot; busy: boolean; offline: boolean; command: Execute }) {
  const team = s.team!;
  return <div className="decision-layout">
    <Opportunity deal={s.roundInfo!}/>
    <section className="private-clues"><h2>Your clues <span>Private</span></h2>{s.privateClues.map(clue => <Clue key={clue.role} clue={clue}/>)}</section>
    <section className="vote-panel" aria-label="Your vote">
      <div className="vote-heading"><strong>Your vote</strong><span>{team.votesSubmitted}/{team.size} voted</span></div>
      <div className="vote-choices">{(['A', 'B', 'pass'] as const).map(choice => <button key={choice} data-testid={`vote-${choice}`} type="button"
        className="vote-button" aria-pressed={s.myVote?.choice === choice}
        disabled={busy || offline || s.paused || s.remainingMs <= 0}
        onClick={() => command({ type: 'vote', choice, revision: (s.myVote?.revision || 0) + 1 })}>
        {s.myVote?.choice === choice && <Check size={17}/>} {choiceName(choice)}
      </button>)}</div>
      <p className="vote-feedback" role="status">{busy ? 'Saving…' : s.myVote ? `Saved: ${choiceName(s.myVote.choice)} · Change before the timer ends` : 'Choose A, B or Pass'}</p>
      <p className="vote-rules">{team.quorum} votes needed · Ties mean Pass</p>
    </section>
  </div>;
}

function resultReason(result: RoundResult) {
  if (result.selectionReason === 'no_quorum') return `Pass: ${result.submittedVotes} of ${result.quorum} required votes received.`;
  if (result.selectionReason === 'tie') return 'Pass: the vote was tied.';
  return result.choice === 'pass' ? 'Your team voted to pass.' : `Your team chose ${result.choice}.`;
}

function Counterfactuals({ reveal, choice }: { reveal: RevealDTO; choice?: Choice }) {
  const { change } = useMoney();
  return <div className="counterfactuals"><h3>Outcome after costs</h3><table><thead><tr><th scope="col">Choice</th><th scope="col" className="number-cell">Return</th></tr></thead><tbody>
    {reveal.options.map(option => <tr key={option.value} className={option.value === choice ? 'chosen' : ''}>
      <th scope="row"><span>{option.value === 'pass' ? 'Pass' : `${option.value} · ${option.label}`}</span>{option.value === choice && <Check size={15} aria-label="Team choice"/>}</th>
      <td className={`number-cell money ${tone(reveal.counterfactuals[option.value])}`}>{change(reveal.counterfactuals[option.value])}</td>
    </tr>)}
  </tbody></table></div>;
}

function RevealedRound({ s, teamId }: { s: Snapshot; teamId?: string }) {
  const { money, change } = useMoney();
  const reveal = s.currentReveal;
  if (!reveal) return null;
  const team = s.teams.find(item => item.id === teamId);
  const result = team?.results.find(item => item.round === s.round);
  return <section className="round-result" data-testid="round-result">
    {result && <div className="result-payoff" key={`${reveal.round}-${result.choice}`}>
      <div><h1>Round {s.round} result</h1><p>{resultReason(result)}</p></div>
      <div><strong className={`big-change money ${tone(result.netChange)}`}>{change(result.netChange)}</strong><span>Balance {money(result.balanceAfter)}</span></div>
    </div>}
    <div className="result-body"><div className="event-explanation"><h2>{reveal.eventLabel}</h2><p>{reveal.explanation}</p></div>
      <Counterfactuals reveal={reveal} choice={result?.choice}/>
    </div>
    {result && <p className="result-votes">Votes: A {result.voteCounts.A} · B {result.voteCounts.B} · Pass {result.voteCounts.pass} · {team!.size - result.submittedVotes} abstained</p>}
    <details className="help-details reveal-facts"><summary>All five clues</summary><div className="revealed-clues">{reveal.allClues.map(clue => <Clue key={clue.role} clue={clue}/>)}</div></details>
  </section>;
}

function BalanceChart({ team }: { team: TeamSummary }) {
  const { money } = useMoney();
  const values = [10_000, ...team.results.map(result => result.balanceAfter)];
  const low = Math.min(0, ...values);
  const high = Math.max(16_000, ...values) + 1000;
  const points = values.map((value, i) => ({ x: 62 + i * 100, y: 160 - (value - low) / (high - low) * 130, value }));
  return <section className="chart-panel"><h2>Balance by round</h2>
    <svg viewBox="0 0 620 205" className="balance-chart" role="img" aria-label={`Balance history: ${values.map((value, i) => `${i === 0 ? 'Start' : `Round ${i}`}: ${money(value)}`).join(', ')}`}>
      <path d="M62 163H570" stroke="#dce4df"/>
      <polyline points={points.map(point => `${point.x},${point.y}`).join(' ')} fill="none" stroke="#087b68" strokeWidth="3" strokeLinejoin="round"/>
      {points.map((point, i) => <g key={i}><circle cx={point.x} cy={point.y} r="4" fill="#087b68"/>
        <text x={point.x} y={point.y - 13} textAnchor="middle">{money(point.value)}</text>
        <text x={point.x} y="189" textAnchor="middle">{i === 0 ? 'Start' : `R${i}`}</text>
      </g>)}
    </svg>
  </section>;
}

function Debrief() {
  return <details className="help-details debrief"><summary>Discuss the game</summary>
    <ol><li>Which information changed your decision?</li><li>Were everyone’s concerns heard?</li><li>Was the result informed judgement, luck, or both?</li></ol>
    <div className="learning-notes"><h3>Organisational Behaviour</h3>
      <p><strong>Roles and communication.</strong> Combining perspectives reveals the costs, conditions and risks.</p>
      <p><strong>Status and judgement.</strong> Consider whose information was heard. Each private vote carried equal weight.</p>
      <p><strong>Shared accountability.</strong> The team shares the outcome; discuss the reasoning as well as the money.</p>
      <p><strong>Belbin contributions.</strong> Analysing, coordinating, challenging and checking are behaviours people can combine, not fixed personality types. A loss alone does not prove groupthink or social loafing.</p>
      <p className="source-note">Sources: Robbins &amp; Judge, <em>Organizational Behavior</em>, 15th ed., chapters 9–10; Colquitt, LePine &amp; Wesson, <em>Organizational Behavior</em>, 4th ed., chapters 11–12; supplied course lecture; <a href="https://www.belbin.com/about/belbin-team-roles" target="_blank" rel="noreferrer">Belbin team roles</a>. All money and scenarios are fictional.</p>
    </div>
  </details>;
}

function FinalResults({ s, teamId }: { s: Snapshot; teamId?: string }) {
  const { money, change } = useMoney();
  const team = s.teams.find(item => item.id === teamId);
  const rank = s.leaderboard.find(item => item.teamId === teamId)?.rank;
  const title = !s.completed ? s.phase === 'expired' ? 'Room expired' : 'Session ended early'
    : !team ? 'Final results' : s.mode === 'coop' ? team.balance >= s.target ? 'Target reached' : 'Target not reached' : `Final rank: ${rank}`;
  return <section className="final-results" data-testid="final-results">
    <div className="final-summary"><h1>{title}</h1>
      {team && <><strong className="final-money money" data-testid="final-balance">{money(team.balance)}</strong><p><span className={tone(team.netProfit)}>{change(team.netProfit)}</span> from {money(s.startingCash)} · {team.results.length}/5 rounds</p></>}
      {!s.completed ? <p>Completed results are saved. No winner is declared.</p> : s.mode === 'coop' ? <p>Target {money(s.target)}</p> : <p>Equal balances share the same rank.</p>}
    </div>
    {(s.mode === 'competition' || !team) && <Standings s={s} ownId={teamId}/>}
    {team && <><BalanceChart team={team}/><section className="history-list"><h2>Round history</h2>{team.results.map(result => <details className="history-item" key={result.round}>
      <summary><span className="history-round">{result.round}</span><span>{result.title}<small>{choiceName(result.choice)} · {result.selectionReason === 'tie' ? 'Tied vote' : result.selectionReason === 'no_quorum' ? 'Not enough votes' : result.eventLabel}</small></span><strong className={`money ${tone(result.netChange)}`}>{change(result.netChange)}</strong></summary>
      <p>{result.explanation}</p><Counterfactuals reveal={result} choice={result.choice}/>
    </details>)}</section></>}
    {!team && s.teams.map(item => <details className="help-details" key={item.id}><summary>{item.name} · {money(item.balance)}</summary><BalanceChart team={item}/></details>)}
    <Debrief/><Link className="button button-primary" href="/">Play again</Link>
  </section>;
}

function ConfirmDialog({ title, children, action, busy, onCancel, onConfirm }: {
  title: string; children: ReactNode; action: string; busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="confirm-dialog" aria-label={title} onCancel={onCancel}>
    <h2>{title}</h2><p>{children}</p><div className="button-row">
      <button className="button button-secondary" autoFocus disabled={busy} onClick={onCancel}>Cancel</button>
      <button className="button button-danger" disabled={busy} onClick={onConfirm}>{action}</button>
    </div>
  </dialog>;
}

function PlayerLobbyControls({ s, busy, offline, command }: {
  s: Snapshot; busy: boolean; offline: boolean; command: Execute;
}) {
  const [selectedTeamId, setSelectedTeamId] = useState(s.team!.id);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [feedback, setFeedback] = useState('');
  const selected = s.teams.find(team => team.id === selectedTeamId) ?? s.team!;
  const cannotChange = selected.id === s.team!.id || selected.joinedCount >= selected.maxPlayers;

  async function changeTeam() {
    if (cannotChange || busy || offline) return;
    setFeedback('');
    if (await command({ type: 'change_team', teamId: selected.id, expectedPlayerId: s.player!.id })) {
      setFeedback('Team changed to ' + selected.name + '.');
    }
  }

  return (
    <section className="player-lobby-controls" aria-label="Your place in the room">
      {s.mode === 'competition' && (
        <div className="change-team-form">
          <div>
            <label htmlFor="change-team">Change team</label>
            <select
              id="change-team"
              value={selected.id}
              disabled={busy || offline}
              onChange={event => { setSelectedTeamId(event.target.value); setFeedback(''); }}
            >
              {s.teams.map(team => {
                const full = team.joinedCount >= team.maxPlayers;
                return (
                  <option key={team.id} value={team.id} disabled={team.id !== s.team!.id && full}>
                    {team.name + ' · ' + team.joinedCount + '/' + team.maxPlayers + (full ? ' · Full' : '')}
                  </option>
                );
              })}
            </select>
          </div>
          <button
            type="button"
            className="button button-secondary"
            data-testid="change-team"
            disabled={cannotChange || busy || offline}
            onClick={changeTeam}
          >
            Change team
          </button>
        </div>
      )}
      <button
        type="button"
        className="button button-ghost"
        data-testid="leave-room"
        disabled={busy || offline}
        onClick={() => setConfirmLeave(true)}
      >
        Leave
      </button>
      {feedback && <p className="membership-feedback" role="status">{feedback}</p>}
      {confirmLeave && (
        <ConfirmDialog
          title="Leave this room?"
          action="Leave room"
          busy={busy}
          onCancel={() => setConfirmLeave(false)}
          onConfirm={() => {
            setConfirmLeave(false);
            void command({ type: 'leave', expectedPlayerId: s.player!.id });
          }}
        >
          Your place will be freed. You can join again before the game starts.
        </ConfirmDialog>
      )}
    </section>
  );
}

export function PlayerRoom({ code }: { code: string }) {
  const router = useRouter();
  const { snapshot: s, error, offline, busy, left, command } = useSession(code, 'player');
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => { if (left) router.replace('/join/' + code); }, [left, router, code]);
  useEffect(() => { top.current?.scrollIntoView({ block: 'start', behavior: 'instant' }); }, [s?.round, s?.phase]);
  if (!s || !s.player || !s.team) return <ConnectionGate error={error} code={code}/>;
  return <CurrencyContext.Provider value={s.currency}><div className="game-page"><RoomHeader s={s} view="player" offline={offline}/>
    <main className={`game-wrap player-screen ${s.phase === 'decision' ? 'voting' : ''}`} data-testid="game-state" data-phase={s.phase} data-round={s.round}>
      <div ref={top}/><p className="player-identity">{s.player.nickname}</p><ErrorNotice message={error}/><PauseNotice s={s} offline={offline}/>
      {s.phase === 'lobby' ? <><div className="lobby-heading"><h1>Waiting to start</h1><StartingGoal s={s}/></div>
        <Roster s={s} teams={[s.team]}/><PlayerLobbyControls key={s.player.id} s={s} busy={busy} offline={offline} command={command}/><p className="waiting-line">Waiting for your host to start the game</p><LobbyRules s={s}/>
      </> : ['finished', 'ended', 'expired'].includes(s.phase) ? <FinalResults s={s} teamId={s.team.id}/> : <>
        <BalanceStrip s={s} team={s.team}/>{s.phase === 'decision' && s.roundInfo ? <Decision s={s} busy={busy} offline={offline} command={command}/> : <><RevealedRound s={s} teamId={s.team.id}/>{s.mode === 'competition' && <Standings s={s} ownId={s.team.id}/>}</>}
      </>}
    </main>
  </div></CurrencyContext.Provider>;
}

export function HostRoom({ code }: { code: string }) {
  const { snapshot: s, error, setError, offline, busy, command } = useSession(code, 'host');
  const [recovery, setRecovery] = useState<{ name: string; code: string } | null>(null);
  const [confirmation, setConfirmation] = useState<{ kind: 'end' | 'player' | 'team'; id?: string; name?: string } | null>(null);
  if (!s) return <ConnectionGate error={error} code={code} host/>;
  const active = s.status === 'running';
  async function confirm() {
    const input: CommandInput = confirmation?.kind === 'player' ? { type: 'remove_player', playerId: confirmation.id! }
      : confirmation?.kind === 'team' ? { type: 'remove_team', teamId: confirmation.id! } : { type: 'end' };
    if (await command(input)) setConfirmation(null);
  }
  return <CurrencyContext.Provider value={s.currency}><div className="game-page"><RoomHeader s={s} view="host" offline={offline}/>
    <main className="game-wrap host-screen" data-testid="game-state" data-phase={s.phase} data-round={s.round}>
      <div className="host-heading"><h1>{s.phase === 'lobby' ? 'Lobby' : active ? `Round ${s.round}/5` : 'Results'}</h1>
        {s.host && <Link target="_blank" href={s.host.projectorUrl} className="button button-secondary button-small"><Monitor size={16}/>Open projector</Link>}
      </div>
      <ErrorNotice message={error}/><PauseNotice s={s} offline={offline}/>
      <div className="host-controls"><div className="button-row">
        {s.phase === 'lobby' && <button className="button button-primary" disabled={!s.canStart || busy || offline} onClick={() => command({ type: 'start' })}><Play size={16}/>Start game</button>}
        {active && <button className="button button-secondary" disabled={busy || offline} onClick={() => command({ type: s.paused ? 'resume' : 'pause' })}>{s.paused ? <Play size={16}/> : <Pause size={16}/>} {s.paused ? 'Resume game' : 'Pause game'}</button>}
        {(active || s.phase === 'lobby') && <button className="button button-ghost" disabled={busy || offline} onClick={() => setConfirmation({ kind: 'end' })}>End session</button>}
      </div>{s.phase === 'lobby' ? <p>{s.canStart ? 'All teams are ready.' : s.rosterMode === 'flexible' ? 'Each team needs 2–5 players.' : 'Fill each team’s selected seats.'}</p> : active ? <Clock s={s}/> : <p>This session is closed.</p>}</div>
      {s.phase === 'lobby' ? <><ShareRoom s={s}/><Roster s={s} teams={s.teams} busy={busy || offline} onRemove={setConfirmation}/><LobbyRules s={s}/><HostRecovery code={code}/></>
        : active ? <div className="host-board"><Standings s={s}/>{s.phase === 'decision' && s.roundInfo ? <Opportunity deal={s.roundInfo}/> : <RevealedRound s={s}/>}</div>
        : <FinalResults s={s}/>}
      <details className="help-details seat-recovery"><summary>Help a player reconnect</summary><p>A replacement code signs their old device out and preserves their progress.</p>
        <div className="button-row">{s.teams.flatMap(team => team.seats.filter(seat => seat.player).map(seat => <button className="button button-secondary button-small" key={seat.player!.id} onClick={async () => {
          try { const result = await request<{ recoveryCode: string }>(`/api/rooms/${code}/reissue`, { playerId: seat.player!.id }); setRecovery({ name: seat.player!.nickname, code: result.recoveryCode }); }
          catch (e) { setError(e instanceof Error ? e.message : 'Could not issue a code.'); }
        }}>{seat.player!.nickname}</button>))}</div>
        {recovery && <div className="recovery-value"><p>For {recovery.name}: use <Link href={`/recover?room=${code}`}>Recover session</Link>.</p><code>{recovery.code}</code><CopyButton text={recovery.code} label="Copy recovery code"/></div>}
      </details>
      {confirmation && <ConfirmDialog title={confirmation.kind === 'end' ? 'End this session?' : 'Confirm removal'} busy={busy}
        action={confirmation.kind === 'end' ? 'End game for everyone' : confirmation.kind === 'player' ? 'Remove player' : 'Remove team'} onCancel={() => setConfirmation(null)} onConfirm={confirm}>
        {confirmation.kind === 'end' ? 'Completed results are kept. An unfinished game has no winner.' : confirmation.kind === 'player' ? `Remove ${confirmation.name}? They can join again before the game starts.` : `Remove the empty team ${confirmation.name}?`}
      </ConfirmDialog>}
    </main>
  </div></CurrencyContext.Provider>;
}

export function ProjectorRoom({ code, token }: { code: string; token?: string }) {
  const { snapshot: s, error, offline } = useSession(code, 'projector', token);
  if (!s) return <ConnectionGate error={error} code={code} host/>;
  return <CurrencyContext.Provider value={s.currency}><div className="game-page projector-page"><RoomHeader s={s} view="projector" offline={offline}/>
    <main className="game-wrap" data-testid="game-state" data-phase={s.phase} data-round={s.round}>
      <ErrorNotice message={error}/><PauseNotice s={s} offline={offline}/>
      {s.phase === 'lobby' ? <><div className="lobby-heading"><h1>Join the game</h1><StartingGoal s={s}/></div><ShareRoom s={s} projector/><Roster s={s} teams={s.teams}/></>
        : s.status === 'running' ? <><div className="projector-heading"><h1>Round {s.round}/5{s.phase === 'reveal' ? ' · Results' : ''}</h1><Clock s={s}/></div>
          <div className="projector-board">{s.phase === 'decision' && s.roundInfo ? <Opportunity deal={s.roundInfo}/> : <RevealedRound s={s}/>}<Standings s={s}/></div></>
          : <FinalResults s={s}/>}
    </main>
  </div></CurrencyContext.Provider>;
}

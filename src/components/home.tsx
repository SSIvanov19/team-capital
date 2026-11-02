'use client';

import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Brand, ErrorNotice } from './ui';
import type { RoomMode } from '@/lib/types';

type EntryPanel = 'join' | 'create';

export function Home() {
  const router = useRouter();
  const joinTab = useRef<HTMLButtonElement>(null);
  const createTab = useRef<HTMLButtonElement>(null);
  const [panel, setPanel] = useState<EntryPanel>('join');
  const [code, setCode] = useState('');
  const [mode, setMode] = useState<RoomMode>('coop');
  const [count, setCount] = useState(2);
  const [names, setNames] = useState<string[]>(
    Array.from({ length: 10 }, (_, index) => 'Team ' + (index + 1)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function selectPanel(next: EntryPanel) {
    setPanel(next);
    setError(null);
  }

  function handleTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'join'
      : event.key === 'End' ? 'create'
      : panel === 'join' ? 'create' : 'join';
    selectPanel(next);
    (next === 'join' ? joinTab : createTab).current?.focus();
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rosterMode: 'flexible',
          mode,
          teams: names.slice(0, mode === 'coop' ? 1 : count).map(name => ({ name })),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Could not create your game.');
      sessionStorage.setItem('deadline-recovery-' + data.code, data.recoveryCode);
      router.push('/host/' + data.code);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Connection failed. Try again.');
      setBusy(false);
    }
  }

  return (
    <div className="home-page">
      <header className="site-header">
        <Brand />
      </header>
      <main className="home-wrap">
        <div className="home-intro">
          <p>Grow €10,000 over five team decisions.</p>
          <p className="home-meta">2–5 players per team · 8–10 minutes</p>
        </div>

        <section className="entry-panel">
          <div className="entry-tabs" role="tablist" aria-label="Game entry">
            <button
              ref={joinTab}
              id="join-tab"
              type="button"
              role="tab"
              aria-selected={panel === 'join'}
              aria-controls="join-panel"
              tabIndex={panel === 'join' ? 0 : -1}
              className={panel === 'join' ? 'active' : ''}
              onClick={() => selectPanel('join')}
              onKeyDown={handleTabKey}
            >
              Join
            </button>
            <button
              ref={createTab}
              id="create-tab"
              type="button"
              role="tab"
              aria-selected={panel === 'create'}
              aria-controls="create-panel"
              tabIndex={panel === 'create' ? 0 : -1}
              className={panel === 'create' ? 'active' : ''}
              onClick={() => selectPanel('create')}
              onKeyDown={handleTabKey}
            >
              Create
            </button>
          </div>

          <div
            id={panel + '-panel'}
            role="tabpanel"
            aria-labelledby={panel + '-tab'}
          >
            <ErrorNotice message={error} />
            {panel === 'join' ? (
              <form
                className="entry-form"
                onSubmit={event => {
                  event.preventDefault();
                  router.push('/join/' + encodeURIComponent(code.trim().toUpperCase()));
                }}
              >
                <div>
                  <label htmlFor="room-code">Room code</label>
                  <input
                    id="room-code"
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    placeholder="ABC234"
                    value={code}
                    minLength={6}
                    maxLength={6}
                    required
                    onChange={event => setCode(event.target.value.replace(/[^a-z0-9]/gi, '').toUpperCase())}
                  />
                </div>
                <button className="button button-primary full" type="submit">Join</button>
              </form>
            ) : (
              <form className="entry-form" onSubmit={create}>
                <div>
                  <label htmlFor="mode">Mode</label>
                  <select id="mode" value={mode} onChange={event => setMode(event.target.value as RoomMode)}>
                    <option value="coop">One team</option>
                    <option value="competition">Team vs team</option>
                  </select>
                  <p className="form-note">
                    {mode === 'coop'
                      ? 'Finish with at least €15,000.'
                      : 'The team with the highest final balance wins.'}
                  </p>
                </div>
                {mode === 'competition' && (
                  <div>
                    <label htmlFor="team-count">Number of teams</label>
                    <select id="team-count" value={count} onChange={event => setCount(Number(event.target.value))}>
                      {Array.from({ length: 9 }, (_, index) => index + 2).map(number => (
                        <option key={number} value={number}>{number}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="team-name-fields">
                  {names.slice(0, mode === 'coop' ? 1 : count).map((name, index) => (
                    <div key={index}>
                      <label htmlFor={'team-name-' + index}>
                        {mode === 'coop' ? 'Team name' : 'Team ' + (index + 1) + ' name'}
                      </label>
                      <input
                        id={'team-name-' + index}
                        value={name}
                        maxLength={28}
                        required
                        onChange={event => setNames(current => current.map((old, i) => i === index ? event.target.value : old))}
                      />
                    </div>
                  ))}
                </div>
                <button className="button button-primary full" disabled={busy} type="submit">
                  {busy ? 'Creating…' : 'Create game'}
                </button>
              </form>
            )}
          </div>
        </section>

        <details className="help-details">
          <summary>How to play</summary>
          <ol>
            <li>Join a team of 2–5 players. Each team starts with €10,000.</li>
            <li>Read your private clues and share them with your teammates.</li>
            <li>You have 60 seconds to discuss each deal and vote A, B or Pass. You can change your vote until time runs out.</li>
            <li>The most popular option becomes your team’s choice. Ties mean Pass. At least 2 players must vote in a team of 2–4, or 3 in a team of 5; otherwise the team passes.</li>
            <li>See the cash outcome for 15 seconds, then the next deal starts automatically. All teams face the same random events.</li>
          </ol>
          <p>Payments are before costs and depend on the contract. Combine your clues to judge the risk. Pass changes your cash by €0.</p>
          <p>After five deals, one team aims for €15,000; in team competition, the highest balance wins and equal balances share the win.</p>
          <p>The host can pause the game. Money and business situations are fictional.</p>
        </details>
        <div className="home-links">
          <Link href="/recover">Recover a session</Link>
        </div>
      </main>
    </div>
  );
}

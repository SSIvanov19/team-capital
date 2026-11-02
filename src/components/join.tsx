'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Brand, ErrorNotice, Loading } from './ui';
import { request } from './session';
import type { LobbySnapshot, TeamRoster } from '@/lib/types';

function teamLabel(team: TeamRoster) {
  const status = team.joinedCount >= team.maxPlayers
    ? 'Full'
    : team.ready ? 'Ready' : 'Needs ' + (team.minPlayers - team.joinedCount) + ' more';
  return team.name + ' · ' + team.joinedCount + '/' + team.maxPlayers + ' · ' + status;
}

export function Join({ code }: { code: string }) {
  const router = useRouter();
  const [lobby, setLobby] = useState<LobbySnapshot | null>(null);
  const [teamId, setTeamId] = useState('');
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const data = await request<LobbySnapshot>('/api/rooms/' + encodeURIComponent(code) + '/lobby');
        if (!alive) return;
        setLobby(data);
        setLoadError(null);
        setTeamId(current => {
          if (current && data.teams.some(team => team.id === current)) return current;
          return data.teams.find(team => team.joinedCount < team.maxPlayers)?.id ?? '';
        });
      } catch (cause) {
        if (alive) setLoadError(cause instanceof Error ? cause.message : 'Could not find this room.');
      }
    }
    void load();
    const timer = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [code]);

  const team = lobby?.teams.find(candidate => candidate.id === teamId);
  const full = !!team && team.joinedCount >= team.maxPlayers;
  const allFull = !!lobby && lobby.teams.every(candidate => candidate.joinedCount >= candidate.maxPlayers);

  async function join(event: FormEvent) {
    event.preventDefault();
    if (!team || full) return;
    setBusy(true);
    setError(null);
    try {
      await request('/api/rooms/' + code + '/join', {
        teamId,
        nickname: nickname.trim(),
      });
      router.push('/play/' + code);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not join.');
      setBusy(false);
    }
  }

  return (
    <>
      <header className="site-header">
        <Brand />
        <Link className="back-link" href="/">Home</Link>
      </header>
      <main className="join-wrap">
        <h1>Join room {code}</h1>
        <ErrorNotice message={error || loadError} />
        {!lobby && !loadError && <Loading />}
        {lobby && lobby.status !== 'lobby' ? (
          <div className="panel">
            <h2>{lobby.status === 'running' ? 'This game has started.' : 'This game has ended.'}</h2>
            <p>Already joined? Return to your player screen or recover your session.</p>
            <div className="home-links">
              <Link href={'/play/' + code}>Return to game</Link>
              <Link href={'/recover?room=' + code}>Recover session</Link>
            </div>
          </div>
        ) : lobby && (
          <form className="entry-form panel" onSubmit={join}>
            <div>
              <label htmlFor="nickname">Nickname</label>
              <input
                id="nickname"
                value={nickname}
                onChange={event => setNickname(event.target.value)}
                required
                minLength={1}
                maxLength={24}
                autoComplete="nickname"
              />
            </div>
            <div>
              <label htmlFor="team">Team</label>
              <select
                id="team"
                value={teamId}
                required
                onChange={event => setTeamId(event.target.value)}
              >
                {!teamId && <option value="">{allFull ? 'All teams are full' : 'Select a team'}</option>}
                {lobby.teams.map(candidate => (
                  <option
                    value={candidate.id}
                    key={candidate.id}
                    disabled={candidate.joinedCount >= candidate.maxPlayers}
                  >
                    {teamLabel(candidate)}
                  </option>
                ))}
              </select>
            </div>
            {full && <p className="form-note">This team is full. Select another team.</p>}
            {allFull && <p className="form-note">All teams are full. Ask the host for a new room.</p>}
            <button
              type="submit"
              className="button button-primary full"
              disabled={busy || !team || full || !nickname.trim()}
            >
              {busy ? 'Joining…' : 'Join'}
            </button>
            <p className="form-note">
              Already joined? <Link href={'/play/' + code}>Return to game</Link>
            </p>
          </form>
        )}
      </main>
    </>
  );
}

export function Recover({ initialRoom = '' }: { initialRoom?: string }) {
  const router = useRouter();
  const [room, setRoom] = useState(initialRoom);
  const [kind, setKind] = useState<'player' | 'host'>('player');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function recover(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const roomCode = room.trim().toUpperCase();
    try {
      await request('/api/rooms/' + roomCode + '/recover', {
        kind,
        recoveryCode: code.trim(),
      });
      router.push('/' + (kind === 'host' ? 'host' : 'play') + '/' + roomCode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Recovery failed.');
      setBusy(false);
    }
  }

  return (
    <>
      <header className="site-header">
        <Brand />
        <Link href="/" className="back-link">Home</Link>
      </header>
      <main className="recover-wrap">
        <h1>Recover a session</h1>
        <p>Use your saved host recovery code or a replacement code from your host.</p>
        <ErrorNotice message={error} />
        <form className="entry-form panel" onSubmit={recover}>
          <div>
            <label htmlFor="recover-kind">Session type</label>
            <select id="recover-kind" value={kind} onChange={event => setKind(event.target.value as 'host' | 'player')}>
              <option value="player">Player</option>
              <option value="host">Host</option>
            </select>
          </div>
          <div>
            <label htmlFor="recover-room">Room code</label>
            <input
              id="recover-room"
              value={room}
              onChange={event => setRoom(event.target.value.replace(/[^a-z0-9]/gi, '').toUpperCase())}
              autoCapitalize="characters"
              spellCheck={false}
              required
              maxLength={8}
            />
          </div>
          <div>
            <label htmlFor="recover-code">Recovery code</label>
            <input
              id="recover-code"
              value={code}
              onChange={event => setCode(event.target.value)}
              required
              autoComplete="off"
            />
          </div>
          <button className="button button-primary full" disabled={busy} type="submit">
            {busy ? 'Recovering…' : 'Recover session'}
          </button>
        </form>
      </main>
    </>
  );
}

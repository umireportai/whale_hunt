import { useEffect, useMemo, useState } from 'react';
import type {
  HuntV2Command,
  HuntV2MatchView,
  HuntV2Move,
  HuntV2RoundResult,
  HuntV2Role,
  HuntV2ScanKind,
  HuntV2Transport,
  HuntV2Window,
  HuntV2Zone,
} from '../../shared/hunt-v2.js';
import { HUNT_V2_ZONES } from '../../shared/hunt-v2.js';
import {
  createHuntLobbyApiTransport,
  createHuntV2ApiTransport,
  HuntV2ApiError,
} from '../api/hunt-v2.js';
import type { HuntLobbyTransport, HuntLobbyView } from '../../shared/hunt-lobby.js';
import type { ProgressionView } from '../../shared/progression.js';
import { GameIcon, WhaleSilhouette, type GameIconName } from '../game-ui/primitives.js';
import { SignalHuntScreen } from './SignalHuntScreen.js';
import '../hunt.css';

export type HuntEntryRole = HuntV2Role;
export type HuntMode = 'duel' | 'real';
type OpponentMode = 'computer' | 'online';
export interface HuntRoundReconstruction {
  readonly roundIndex: number;
  readonly whaleAction: string;
}
export interface HuntReconstruction {
  readonly rounds: readonly HuntRoundReconstruction[];
  readonly decisiveExplanation: string;
}
export interface HuntScreenProps {
  readonly initialRole?: HuntEntryRole;
  readonly initialMatch?: HuntV2MatchView;
  readonly matchId?: string;
  readonly transport?: HuntV2Transport;
  readonly lobbyTransport?: HuntLobbyTransport;
  readonly sourceMode?: 'live' | 'historical' | 'unavailable' | 'training';
  readonly sourceReason?: string;
}

interface AccountView {
  readonly playerId: string;
  readonly displayName: string;
}

const ZONE_LABELS: Record<HuntV2Zone, string> = {
  A: 'North Current',
  B: 'Midnight Drift',
  C: 'Deep Break',
};
const ROLE_COPY = {
  whale: { title: 'Hide the move.', detail: 'Plant a footprint. Make the tracer fire wide.' },
  tracer: {
    title: 'Find the whale.',
    detail: 'Read the signal. Call the zone before it vanishes.',
  },
} as const;
const MOVE_COPY: Record<HuntV2Move, { title: string; detail: string; icon: GameIconName }> = {
  burst: { title: 'Burst', detail: 'One violent pulse, then silence.', icon: 'pulse' },
  drip: { title: 'Drip', detail: 'Small buys that build a trail.', icon: 'flow' },
  blend: { title: 'Blend', detail: 'Steady prints hiding in the noise.', icon: 'whale-footprint' },
  decoy: { title: 'Decoy', detail: 'Bait one zone. Strike from another.', icon: 'alert' },
  wait: { title: 'Late push', detail: 'Stay dark until the final ticks.', icon: 'chevron' },
};
const SCAN_COPY: Record<
  HuntV2ScanKind,
  {
    title: string;
    detail: string;
    icon: 'flow' | 'volume' | 'pulse' | 'whale-footprint' | 'search' | 'long';
  }
> = {
  flow: { title: 'Flow', detail: 'Where did capital lean?', icon: 'flow' },
  concentration: { title: 'Concentration', detail: 'Was one print too loud?', icon: 'volume' },
  rhythm: { title: 'Rhythm', detail: 'Did the trail repeat?', icon: 'pulse' },
  timing: { title: 'Timing', detail: 'Early push or late push?', icon: 'whale-footprint' },
  'cross-asset': { title: 'Cross-signal', detail: 'Does this zone lead?', icon: 'search' },
  'position-growth': { title: 'Position', detail: 'Is the footprint growing?', icon: 'long' },
};

function ModeLobby({
  sourceMode,
  sourceReason,
  onSelect,
}: {
  sourceMode: 'live' | 'historical' | 'unavailable' | 'training';
  sourceReason?: string;
  onSelect: (mode: HuntMode) => void;
}) {
  return (
    <section className="hunt-mode-lobby" aria-labelledby="hunt-mode-title">
      <div className="hunt-mode-lobby__glow" />
      <div className="hunt-mode-lobby__copy">
        <div className="hunt-lobby__eyebrow">
          <span className="sonar-dot" /> WHALE HUNT ·{' '}
          {sourceMode === 'live'
            ? 'NANSEN DATA READY'
            : sourceMode === 'historical'
              ? 'NANSEN HISTORICAL REPLAY'
              : sourceMode === 'unavailable'
                ? 'NANSEN SNAPSHOT REQUIRED'
                : 'DUEL FEED READY'}
        </div>
        <h1 id="hunt-mode-title">
          Read the current.
          <br />
          <em>Choose your hunt.</em>
        </h1>
        <p>
          Investigate a frozen real-data signal or race another hunter through a three-round duel.
        </p>
      </div>
      <div className="hunt-mode-lobby__cards">
        <button
          className="hunt-mode-card hunt-mode-card--real"
          type="button"
          onClick={() => onSelect('real')}
        >
          <span className="hunt-mode-card__icon">
            <WhaleSilhouette label="Real Whale Hunt" />
          </span>
          <span>
            <small>DEEP REPLAY · NANSEN EVIDENCE</small>
            <strong>Real Whale Hunt</strong>
            <p>
              Choose a historical or current snapshot, spend evidence scans, and reveal why the
              target was flagged.
            </p>
          </span>
          <GameIcon name="arrow" size={19} />
        </button>
        <button className="hunt-mode-card" type="button" onClick={() => onSelect('duel')}>
          <span className="hunt-mode-card__icon">
            <GameIcon name="search" size={23} />
          </span>
          <span>
            <small>2 PLAYERS · 3 ROUNDS</small>
            <strong>Duello</strong>
            <p>
              Keep the whale-versus-tracer format. Hide the move, read the footprint, and settle the
              score across three rounds.
            </p>
          </span>
          <GameIcon name="arrow" size={19} />
        </button>
      </div>
      <p className="hunt-mode-lobby__fineprint">
        <GameIcon name="lock" size={13} /> No wallet needed · Nansen signals are informational, not
        financial advice.
      </p>
      {sourceMode === 'unavailable' && sourceReason && (
        <p className="hunt-mode-lobby__status" role="status">
          {sourceReason}
        </p>
      )}
    </section>
  );
}

function commandMeta(match: HuntV2MatchView, label: string) {
  return {
    expectedStateVersion: match.stateVersion,
    idempotencyKey: `hunt-v2-${label}-${match.stateVersion}-${Date.now()}`,
  } as const;
}

function roleLabel(role: HuntV2Role): string {
  return role === 'whale' ? 'Whale' : 'Tracer';
}

function phaseLabel(phase: HuntV2MatchView['phase']): string {
  if (phase === 'round_intro') return 'Briefing';
  if (phase === 'whale_hide') return 'Hide phase';
  if (phase === 'tracer_hunt') return 'Hunt phase';
  if (phase === 'round_reveal') return 'Reveal';
  return 'Match over';
}

function phaseMessage(view: HuntV2MatchView): string {
  if (view.phase === 'round_intro') return 'The next current is loading.';
  if (view.phase === 'whale_hide')
    return view.role === 'whale'
      ? 'Choose your trap and launch the footprint.'
      : 'The whale is planting a false signal.';
  if (view.phase === 'tracer_hunt')
    return view.role === 'tracer'
      ? 'Scan the current. Lock your call.'
      : 'The tracer is closing in.';
  if (view.phase === 'round_reveal')
    return view.roundResult?.explanation ?? 'The signal has resolved.';
  return view.matchWinner
    ? `${roleLabel(view.matchWinner)} owns the current.`
    : 'The match is complete.';
}

function formatRemaining(view: HuntV2MatchView, now: number): string {
  if (!view.deadline) return '—';
  const serverOffset = Date.parse(view.serverNow) - Date.now();
  const remaining = Math.max(0, Date.parse(view.deadline.at) - (now + serverOffset));
  return `${Math.ceil(remaining / 1000)}s`;
}

function selectedAssetLabel(result: HuntV2RoundResult): string {
  if (!result.selectedAsset) return result.selectedZone ? `ZONE ${result.selectedZone}` : 'NO CALL';
  return `${result.selectedAsset.symbol} · ${result.selectedAsset.name} · ${result.selectedAsset.chain}`;
}

function formatUsd(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}m`;
  if (absolute >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
}

function formatPrice(value: number): string {
  if (value >= 1_000) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (value >= 1) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `$${value.toLocaleString(undefined, { maximumSignificantDigits: 4 })}`;
}

function linePoints(values: readonly number[], min: number, max: number): string {
  return values
    .map((value, index) => {
      const x = 8 + (index / Math.max(1, values.length - 1)) * 284;
      const y = 76 - ((value - min) / Math.max(0.01, max - min)) * 58;
      return `${x.toFixed(1)},${Math.max(8, Math.min(76, y)).toFixed(1)}`;
    })
    .join(' ');
}

function MarketChart({
  window,
  selected,
  revealed,
  large = false,
}: {
  window: HuntV2Window;
  selected: boolean;
  revealed: boolean;
  large?: boolean;
}) {
  const min = Math.min(...window.price) - 1;
  const max = Math.max(...window.price) + 1;
  const maxVolume = Math.max(...window.volume, 1);
  const last = window.price.at(-1) ?? 0;
  const first = window.price[0] ?? last;
  const delta = first ? (last / first - 1) * 100 : 0;
  return (
    <div
      className={`hunt-chart ${large ? 'hunt-chart--large' : ''}`}
      role="img"
      aria-label={`${ZONE_LABELS[window.zone]} price trace and volume bars`}
    >
      <svg viewBox="0 0 300 108" preserveAspectRatio="none" aria-hidden="true">
        {[22, 48, 74].map((y) => (
          <line key={y} className="hunt-chart__grid" x1="8" x2="292" y1={y} y2={y} />
        ))}
        {window.volume.map((value, index) => {
          const width = large ? 14 : 13;
          const x = 8 + (index / Math.max(1, window.volume.length - 1)) * 284 - width / 2;
          const height = (value / maxVolume) * 25;
          return (
            <rect
              key={index}
              className={`hunt-chart__volume ${window.pulseIndices.includes(index) ? 'is-pulse' : ''}`}
              x={x}
              y={98 - height}
              width={width}
              height={height}
              rx="2"
            />
          );
        })}
        <polyline
          className={`hunt-chart__line ${selected ? 'is-selected' : ''} ${revealed ? 'is-revealed' : ''}`}
          points={linePoints(window.price, min, max)}
        />
        {window.pulseIndices.map((index) => {
          const value = window.price[index];
          if (value === undefined) return null;
          const x = 8 + (index / Math.max(1, window.price.length - 1)) * 284;
          const y = 76 - ((value - min) / Math.max(0.01, max - min)) * 58;
          return (
            <circle
              key={index}
              className="hunt-chart__pulse"
              cx={x}
              cy={Math.max(8, Math.min(76, y))}
              r={large ? 3.4 : 3}
            />
          );
        })}
      </svg>
      <div className="hunt-chart__footer">
        <span>PRICE TRACE</span>
        <strong className={delta >= 0 ? 'is-positive' : 'is-negative'}>
          {delta >= 0 ? '+' : ''}
          {delta.toFixed(2)}%
        </strong>
        <span>VOLUME</span>
      </div>
    </div>
  );
}

function ScoreHeader({ view, now }: { view: HuntV2MatchView; now: number }) {
  const timer = formatRemaining(view, now);
  const urgent = timer !== '—' && Number.parseInt(timer, 10) <= 5;
  return (
    <header className="hunt-match-header">
      <div className="hunt-match-header__role hunt-match-header__role--whale">
        <span className="role-avatar role-avatar--whale">
          <WhaleSilhouette label="Whale" />
        </span>
        <span>
          <small>OPPONENT</small>
          <strong>WHALE</strong>
        </span>
        <b>{view.score.whale}</b>
      </div>
      <div className="hunt-match-header__center">
        <span className="hunt-kicker">
          ROUND {view.roundIndex} / {view.totalRounds}
        </span>
        <strong>{phaseLabel(view.phase)}</strong>
        <div className={`hunt-timer ${urgent ? 'is-urgent' : ''}`}>
          <span className="timer-pulse" />
          {timer}
        </div>
      </div>
      <div className="hunt-match-header__role hunt-match-header__role--tracer">
        <b>{view.score.tracer}</b>
        <span>
          <small>YOUR SEAT</small>
          <strong>TRACER</strong>
        </span>
        <span className="role-avatar role-avatar--tracer">
          <GameIcon name="search" size={20} />
        </span>
      </div>
    </header>
  );
}

function Lobby({
  role,
  onRole,
  busy,
  onStart,
  onJoin,
  account,
  progression,
  onRename,
  sourceMode,
  onBack,
}: {
  role: HuntV2Role;
  onRole: (role: HuntV2Role) => void;
  busy: boolean;
  onStart: (mode: OpponentMode) => void;
  onJoin: (matchId: string) => void;
  account: AccountView | null;
  progression: ProgressionView | null;
  onRename: (displayName: string) => Promise<void>;
  sourceMode: 'live' | 'historical' | 'unavailable' | 'training';
  onBack: () => void;
}) {
  const [joinMatchId, setJoinMatchId] = useState('');
  const [displayName, setDisplayName] = useState(account?.displayName ?? '');
  const [renaming, setRenaming] = useState(false);
  const [opponentMode, setOpponentMode] = useState<OpponentMode>('computer');
  useEffect(() => {
    if (account) setDisplayName(account.displayName);
  }, [account]);
  return (
    <section className="hunt-lobby" aria-labelledby="hunt-lobby-title">
      <div className="hunt-lobby__glow hunt-lobby__glow--one" />
      <div className="hunt-lobby__glow hunt-lobby__glow--two" />
      <div className="hunt-lobby__copy">
        <button className="signal-hunt-back" type="button" onClick={onBack}>
          ← Back to modes
        </button>
        <div className="hunt-lobby__eyebrow">
          <span className="sonar-dot" /> ONCHAIN DEDUCTION GAME ·{' '}
          {sourceMode === 'live'
            ? 'NANSEN LIVE CURRENT'
            : sourceMode === 'historical'
              ? 'NANSEN HISTORICAL REPLAY'
              : sourceMode === 'unavailable'
                ? 'NANSEN SNAPSHOT REQUIRED'
                : 'DUEL CURRENT'}
        </div>
        <h1 id="hunt-lobby-title">
          Find the whale.
          <br />
          <em>Catch the move.</em>
        </h1>
        <p className="hunt-lobby__lede">
          A three-round game of signal and misdirection. One player hides a move in the current; the
          other reads the footprint and fires the catch.
        </p>
        <div className="hunt-lobby__stats" aria-label="Match rules">
          <span>
            <strong>01</strong>
            <small>hidden move</small>
          </span>
          <span>
            <strong>03</strong>
            <small>market zones</small>
          </span>
          <span>
            <strong>03</strong>
            <small>rounds to win</small>
          </span>
        </div>
        {account && (
          <form
            className="hunt-profile-strip"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!displayName.trim() || displayName.trim() === account.displayName) return;
              setRenaming(true);
              await onRename(displayName.trim());
              setRenaming(false);
            }}
          >
            <span className="hunt-profile-strip__avatar">
              {account.displayName.slice(0, 1).toUpperCase()}
            </span>
            <span className="hunt-profile-strip__identity">
              <small>PLAYER HANDLE</small>
              <input
                aria-label="Player handle"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                maxLength={24}
                disabled={renaming}
              />
            </span>
            <span className="hunt-profile-strip__stats">
              <b>{progression?.huntHistory.length ?? 0}</b>
              <small>HUNTS</small>
              <b>{progression?.badges.length ?? 0}</b>
              <small>BADGES</small>
            </span>
            <button type="submit" disabled={renaming || displayName.trim() === account.displayName}>
              {renaming ? 'SAVING' : 'SAVE'}
            </button>
          </form>
        )}
        {progression && progression.badges.length > 0 && (
          <div className="hunt-badge-tray" aria-label="Earned Whale Hunt badges">
            {progression.badges.slice(-3).map((badge) => (
              <span key={badge.badgeId} title={badge.description}>
                <GameIcon name="check" size={11} /> {badge.title}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="hunt-lobby__radar" aria-hidden="true">
        <div className="radar-grid" />
        <div className="radar-ring radar-ring--outer" />
        <div className="radar-ring radar-ring--middle" />
        <div className="radar-ring radar-ring--inner" />
        <div className="radar-sweep" />
        <span className="radar-blip radar-blip--one" />
        <span className="radar-blip radar-blip--two" />
        <span className="radar-blip radar-blip--three" />
        <WhaleSilhouette label="Hidden whale" />
        <span className="radar-label radar-label--one">SIGNAL 07</span>
        <span className="radar-label radar-label--two">?</span>
      </div>
      <div className="hunt-lobby__deck">
        <div className="hunt-section-heading">
          <span className="hunt-kicker">CHOOSE YOUR LOADOUT</span>
          <span className="hunt-section-heading__line" />
        </div>
        <div className="role-picker" role="group" aria-label="Choose your role">
          {(['tracer', 'whale'] as const).map((candidate) => (
            <button
              key={candidate}
              className={`role-card ${role === candidate ? 'is-selected' : ''}`}
              type="button"
              aria-pressed={role === candidate}
              onClick={() => onRole(candidate)}
            >
              <span className={`role-card__icon role-card__icon--${candidate}`}>
                {candidate === 'tracer' ? (
                  <GameIcon name="search" size={22} />
                ) : (
                  <WhaleSilhouette label="Whale role" />
                )}
              </span>
              <span className="role-card__copy">
                <strong>{roleLabel(candidate)}</strong>
                <small>
                  {ROLE_COPY[candidate].title} {ROLE_COPY[candidate].detail}
                </small>
              </span>
              <span className="role-card__check">
                {role === candidate ? <GameIcon name="check" size={15} /> : 'SELECT'}
              </span>
            </button>
          ))}
        </div>
        <div className="opponent-picker" role="group" aria-label="Choose your opponent">
          <span className="hunt-kicker">CHOOSE YOUR OPPONENT</span>
          <div className="opponent-picker__options">
            <button
              className={`opponent-card ${opponentMode === 'computer' ? 'is-selected' : ''}`}
              type="button"
              aria-pressed={opponentMode === 'computer'}
              onClick={() => setOpponentMode('computer')}
              disabled={busy}
            >
              <GameIcon name="whale-footprint" size={19} />
              <span>
                <strong>Computer</strong>
                <small>Starts immediately</small>
              </span>
              {opponentMode === 'computer' && <GameIcon name="check" size={15} />}
            </button>
            <button
              className={`opponent-card ${opponentMode === 'online' ? 'is-selected' : ''}`}
              type="button"
              aria-pressed={opponentMode === 'online'}
              onClick={() => setOpponentMode('online')}
              disabled={busy}
            >
              <GameIcon name="user" size={19} />
              <span>
                <strong>Online</strong>
                <small>Computer takes over if nobody joins</small>
              </span>
              {opponentMode === 'online' && <GameIcon name="check" size={15} />}
            </button>
          </div>
        </div>
        <button
          className="hunt-cta hunt-cta--launch"
          type="button"
          disabled={busy}
          onClick={() => onStart(opponentMode)}
        >
          <span>
            {busy
              ? opponentMode === 'computer'
                ? 'Starting match…'
                : 'Finding an opponent…'
              : opponentMode === 'computer'
                ? 'Start against computer'
                : 'Find online opponent'}
          </span>
          <GameIcon name="arrow" size={19} />
        </button>
        <div className="lobby-join">
          <div>
            <span className="hunt-kicker">PRIVATE DUEL</span>
            <p>Have a match code? Drop into an open opponent seat.</p>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (joinMatchId.trim()) onJoin(joinMatchId.trim());
            }}
          >
            <label className="hunt-sr-only" htmlFor="hunt-match-id">
              Match ID
            </label>
            <input
              id="hunt-match-id"
              value={joinMatchId}
              onChange={(event) => setJoinMatchId(event.target.value)}
              placeholder="MATCH CODE"
              autoComplete="off"
              disabled={busy}
            />
            <button
              className="hunt-ghost-button"
              type="submit"
              disabled={busy || !joinMatchId.trim()}
            >
              Join
            </button>
          </form>
        </div>
        <p className="hunt-lobby__fineprint">
          <GameIcon name="lock" size={13} /> Server-authoritative · No wallet needed · Live signals
          are informational, not financial advice.
        </p>
      </div>
    </section>
  );
}

function LobbyWaiting({
  view,
  now,
  busy,
  onCancel,
}: {
  view: HuntLobbyView;
  now: number;
  busy: boolean;
  onCancel: () => void;
}) {
  const remaining = Math.max(0, Date.parse(view.deadlineAt) - now);
  const seconds = Math.ceil(remaining / 1000);
  const progress = Math.min(100, Math.max(0, ((60_000 - remaining) / 60_000) * 100));
  return (
    <section className="hunt-lobby hunt-lobby--waiting" aria-labelledby="hunt-lobby-waiting-title">
      <div className="hunt-lobby__glow hunt-lobby__glow--one" />
      <div className="hunt-lobby__glow hunt-lobby__glow--two" />
      <div className="lobby-waiting__copy">
        <span className="hunt-lobby__eyebrow">
          <span className="sonar-dot" /> MATCHMAKING LIVE · SEAT LOCKED
        </span>
        <h1 id="hunt-lobby-waiting-title">
          Hunting for a
          <br />
          <em>{roleLabel(view.waitingFor).toLowerCase()}.</em>
        </h1>
        <p className="hunt-lobby__lede">
          You are the <strong>{roleLabel(view.role)}</strong>. Another player can join at any
          moment; if the water stays empty, Whale Hunt will bring in a computer at zero.
        </p>
        <div
          className="lobby-waiting__meter"
          aria-label={`${seconds} seconds until computer opponent`}
        >
          <div className="lobby-waiting__meter-topline">
            <span>{seconds}s until computer takeover</span>
            <b>{roleLabel(view.role).toUpperCase()} SEAT</b>
          </div>
          <div className="lobby-waiting__track">
            <span style={{ width: `${progress}%` }} />
          </div>
        </div>
        <div className="lobby-waiting__signals">
          <span>
            <i className="is-active" /> You · {roleLabel(view.role)}
          </span>
          <span>
            <i /> Open · {roleLabel(view.waitingFor)}
          </span>
          <span>
            <i /> Computer ready
          </span>
        </div>
        <button
          className="hunt-ghost-button lobby-waiting__cancel"
          type="button"
          onClick={onCancel}
          disabled={busy}
        >
          {busy ? 'Leaving lobby…' : 'Cancel search'}
        </button>
      </div>
      <div className="lobby-waiting__radar" aria-hidden="true">
        <div className="radar-grid" />
        <div className="radar-ring radar-ring--outer" />
        <div className="radar-ring radar-ring--middle" />
        <div className="radar-ring radar-ring--inner" />
        <div className="radar-sweep" />
        <span className="radar-blip radar-blip--one" />
        <span className="radar-blip radar-blip--two" />
        <span className="radar-blip radar-blip--three" />
        <WhaleSilhouette label="Searching for opponent" />
        <span className="radar-label radar-label--one">
          {view.queuePosition === 1 ? 'OPEN WATER' : 'DUEL FOUND'}
        </span>
        <span className="radar-label radar-label--two">{seconds}</span>
      </div>
      <div className="lobby-waiting__footer">
        <span>
          <span className="sonar-dot" /> Lobby heartbeat · real players can join this seat
        </span>
        <span>60 SECOND WINDOW</span>
      </div>
    </section>
  );
}

function WindowCard({
  window,
  selected,
  onSelect,
  disabled,
  selectionLabel,
  revealed,
}: {
  window: HuntV2Window;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
  selectionLabel?: string;
  revealed?: boolean;
}) {
  const latest = window.price.at(-1) ?? 0;
  const first = window.price[0] ?? latest;
  const delta = first ? (latest / first - 1) * 100 : 0;
  const market = window.market;
  return (
    <button
      type="button"
      className={`hunt-zone-card ${selected ? 'is-selected' : ''} ${revealed ? 'is-revealed' : ''}`}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="hunt-zone-card__topline">
        <span className="zone-index">{window.zone}</span>
        <span>
          {market?.chain ?? 'CURRENT WINDOW'}{' '}
          <GameIcon name={selected ? 'check' : 'chevron'} size={14} />
        </span>
      </span>
      <span className="hunt-zone-card__identity">
        <strong>{market?.symbol ?? `SIGNAL ${window.zone}`}</strong>
        <small>{market?.name ?? ZONE_LABELS[window.zone]}</small>
      </span>
      {market?.whalePositionUsd ? (
        <span className="hunt-zone-card__stake">
          MODELED WHALE STAKE · {formatUsd(market.whalePositionUsd)}
        </span>
      ) : null}
      <MarketChart window={window} selected={selected} revealed={Boolean(revealed)} />
      <span className="hunt-zone-card__metrics">
        <span>
          <small>PRICE</small>
          <b>{formatPrice(latest)}</b>
        </span>
        <span>
          <small>MOVE</small>
          <b className={delta >= 0 ? 'is-positive' : 'is-negative'}>
            {delta >= 0 ? '+' : ''}
            {delta.toFixed(2)}%
          </b>
        </span>
        <span>
          <small>FLOW</small>
          <b>
            {market?.smartMoney.direction === 'accumulating'
              ? 'IN'
              : market?.smartMoney.direction === 'distributing'
                ? 'OUT'
                : 'MIXED'}
          </b>
        </span>
        <span>
          <small>WHALE PRESSURE</small>
          <b
            className={
              market?.whalePressure && market.whalePressure.netUsd >= 0
                ? 'is-positive'
                : 'is-negative'
            }
          >
            {market?.whalePressure
              ? `${market.whalePressure.netUsd >= 0 ? '+' : '−'}${formatUsd(Math.abs(market.whalePressure.netUsd))}`
              : '—'}
          </b>
        </span>
      </span>
      <span className="hunt-zone-card__footer">
        <span>{selected ? (selectionLabel ?? 'LOCKED ON') : 'Tap to inspect'}</span>
        <span className="zone-signal-dot" />
      </span>
    </button>
  );
}

function HuntBoard({
  view,
  selectedZone,
  onSelect,
  disabled,
  selectionLabel,
}: {
  view: HuntV2MatchView;
  selectedZone: HuntV2Zone | null;
  onSelect: (zone: HuntV2Zone) => void;
  disabled?: boolean;
  selectionLabel?: string;
}) {
  return (
    <section className="hunt-board" aria-label="Live market zones">
      <div className="hunt-board__heading">
        <div>
          <span className="hunt-kicker">THE CURRENT · LIVE BOARD · 30s READ</span>
          <h2>Where is the footprint?</h2>
        </div>
        <span className="hunt-board__source">
          <span className="sonar-dot" />
          {view.windows.some((window) => window.market?.sourceKind === 'nansen')
            ? 'NANSEN DATA'
            : 'HISTORICAL DATA'}
        </span>
      </div>
      <div className="hunt-board__windows">
        {view.windows.map((window) => (
          <WindowCard
            key={window.zone}
            window={window}
            selected={selectedZone === window.zone}
            onSelect={() => onSelect(window.zone)}
            disabled={disabled}
            selectionLabel={selectedZone === window.zone ? selectionLabel : undefined}
            revealed={view.phase === 'round_reveal' || view.phase === 'match_over'}
          />
        ))}
      </div>
      <div className="hunt-board__legend">
        <span>
          <i className="legend-line legend-line--price" /> price trace
        </span>
        <span>
          <i className="legend-bar" /> volume intensity
        </span>
        <span>
          <i className="legend-pulse" /> activity pulse
        </span>
      </div>
    </section>
  );
}

function WhaleControls({
  draftZone,
  draftMove,
  draftDecoy,
  busy,
  onZone,
  onMove,
  onDecoy,
  onHide,
}: {
  draftZone: HuntV2Zone;
  draftMove: HuntV2Move;
  draftDecoy: HuntV2Zone;
  busy: boolean;
  onZone: (zone: HuntV2Zone) => void;
  onMove: (move: HuntV2Move) => void;
  onDecoy: (zone: HuntV2Zone) => void;
  onHide: () => void;
}) {
  const effect =
    draftMove === 'decoy'
      ? `Bait ${ZONE_LABELS[draftDecoy]}. Real move lands in ${ZONE_LABELS[draftZone]}.`
      : `${MOVE_COPY[draftMove].title} in ${ZONE_LABELS[draftZone]}. ${MOVE_COPY[draftMove].detail}`;
  return (
    <section className="hunt-command-panel" aria-labelledby="whale-command-title">
      <div className="hunt-command-panel__heading">
        <div>
          <span className="hunt-kicker hunt-kicker--amber">PRIVATE LOADOUT</span>
          <h2 id="whale-command-title">Plant the trap.</h2>
        </div>
        <span className="private-pill">
          <GameIcon name="lock" size={13} /> HIDDEN
        </span>
      </div>
      <p className="hunt-command-panel__lede">
        Choose a zone and a move. The tracer only sees the footprint you leave behind.
      </p>
      <div className="command-step">
        <span className="step-number">01</span>
        <div>
          <span className="step-label">DROP THE SIGNAL</span>
          <div className="zone-choice">
            {HUNT_V2_ZONES.map((zone) => (
              <button
                key={zone}
                type="button"
                className={draftZone === zone ? 'is-selected' : ''}
                onClick={() => onZone(zone)}
                disabled={busy}
              >
                <b>{zone}</b>
                <small>{ZONE_LABELS[zone]}</small>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="command-step">
        <span className="step-number">02</span>
        <div>
          <span className="step-label">CHOOSE THE MOVE</span>
          <div className="move-choice">
            {(['burst', 'drip', 'blend', 'decoy', 'wait'] as const).map((move) => (
              <button
                key={move}
                type="button"
                className={draftMove === move ? 'is-selected' : ''}
                onClick={() => onMove(move)}
                disabled={busy}
              >
                <GameIcon name={MOVE_COPY[move].icon} size={17} />
                <span>
                  <b>{MOVE_COPY[move].title}</b>
                  <small>{MOVE_COPY[move].detail}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
      {draftMove === 'decoy' && (
        <div className="command-step">
          <span className="step-number">03</span>
          <div>
            <span className="step-label">PLACE THE BAIT</span>
            <div className="decoy-choice">
              {HUNT_V2_ZONES.filter((zone) => zone !== draftZone).map((zone) => (
                <button
                  key={zone}
                  type="button"
                  className={`hunt-footprint-preview--decoy ${draftDecoy === zone ? 'is-selected' : ''}`}
                  onClick={() => onDecoy(zone)}
                  disabled={busy}
                >
                  Pulse in {zone}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="command-preview" aria-live="polite">
        <span className="command-preview__icon">
          <WhaleSilhouette label="Your hidden plan" />
        </span>
        <span>
          <small>YOUR FOOTPRINT</small>
          <strong>{effect}</strong>
        </span>
      </div>
      <button className="hunt-cta hunt-cta--amber" type="button" onClick={onHide} disabled={busy}>
        {busy ? 'Launching…' : `Hide in ${draftZone}`}
        <GameIcon name="arrow" size={18} />
      </button>
    </section>
  );
}

function EvidenceStrip({ view }: { view: HuntV2MatchView }) {
  const latest = view.scans.at(-1);
  return (
    <div className="evidence-strip" aria-live="polite">
      <div className="evidence-strip__heading">
        <span className="hunt-kicker">INTEL LOG</span>
        <span>
          <b>{view.scansRemaining}</b> scans left
        </span>
      </div>
      {latest ? (
        <div className="evidence-result">
          <span className="evidence-result__tag">
            ZONE {latest.zone} · {latest.kind.toUpperCase()}
          </span>
          <strong>{latest.headline}</strong>
          <p>{latest.detail}</p>
          <div className="evidence-result__metrics">
            {latest.metrics.map((metric) => (
              <span key={metric.label}>
                <small>{metric.label}</small>
                <b>{metric.value}</b>
              </span>
            ))}
          </div>
        </div>
      ) : (
        <p className="evidence-empty">
          Buy a scan to expose a measured signal beneath the chart. Choose your evidence lane
          carefully.
        </p>
      )}
      {view.scans.length > 1 && (
        <div className="evidence-history">
          {view.scans.slice(0, -1).map((scan) => (
            <span key={`${scan.zone}-${scan.kind}`}>
              Z{scan.zone} · {scan.kind}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function TracerControls({
  view,
  targetZone,
  scanZone,
  busy,
  onScanZone,
  onScan,
  onCatch,
}: {
  view: HuntV2MatchView;
  targetZone: HuntV2Zone;
  scanZone: HuntV2Zone;
  busy: boolean;
  onScanZone: (zone: HuntV2Zone) => void;
  onScan: (scan: HuntV2ScanKind) => void;
  onCatch: () => void;
}) {
  return (
    <section
      className="hunt-command-panel hunt-command-panel--tracer"
      aria-labelledby="tracer-command-title"
    >
      <div className="hunt-command-panel__heading">
        <div>
          <span className="hunt-kicker">TRACER TOOLKIT</span>
          <h2 id="tracer-command-title">Read. Aim. Catch.</h2>
        </div>
        <span className="private-pill private-pill--cyan">
          <GameIcon name="search" size={13} /> PUBLIC SIGNAL
        </span>
      </div>
      <p className="hunt-command-panel__lede">
        Every scan costs a charge. Gather just enough proof, then lock one zone.
      </p>
      <EvidenceStrip view={view} />
      <div className="command-step">
        <span className="step-number">01</span>
        <div>
          <span className="step-label">SCAN THIS ZONE</span>
          <div className="zone-choice">
            {HUNT_V2_ZONES.map((zone) => (
              <button
                key={zone}
                type="button"
                className={scanZone === zone ? 'is-selected' : ''}
                onClick={() => onScanZone(zone)}
                disabled={busy}
              >
                <b>{zone}</b>
                <small>{ZONE_LABELS[zone]}</small>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="scan-choice">
        {(
          ['flow', 'concentration', 'rhythm', 'timing', 'cross-asset', 'position-growth'] as const
        ).map((scan) => (
          <button
            key={scan}
            type="button"
            onClick={() => onScan(scan)}
            disabled={busy || view.scansRemaining === 0}
          >
            <GameIcon name={SCAN_COPY[scan].icon} size={16} />
            <span>
              <b>{SCAN_COPY[scan].title}</b>
              <small>{SCAN_COPY[scan].detail}</small>
            </span>
          </button>
        ))}
      </div>
      <div className="catch-lock">
        <div>
          <span>LEAD SUSPECT</span>
          <strong>ZONE {targetZone}</strong>
        </div>
        <button className="hunt-cta" type="button" onClick={onCatch} disabled={busy}>
          {busy ? 'Locking…' : `Catch ${targetZone}`}
          <GameIcon name="arrow" size={18} />
        </button>
      </div>
    </section>
  );
}

function RoundReveal({
  view,
  busy,
  onBackToLobby,
}: {
  view: HuntV2MatchView;
  busy: boolean;
  onBackToLobby: () => void;
}) {
  const result = view.roundResult;
  if (!result) return null;
  const matchOver = view.phase === 'match_over';
  const decisiveScan = result.decisiveScan ?? 'flow';
  const busted = result.winner === 'tracer';
  return (
    <section
      className={`hunt-reveal-card ${result.winner === view.role ? 'is-your-win' : ''}`}
      aria-live="assertive"
    >
      <div className="hunt-reveal-card__heading">
        <div>
          <span className="hunt-kicker">ROUND {result.roundIndex} REPORT</span>
          <h2>{busted ? 'BUSTED' : 'GHOSTED'}</h2>
          <p>{busted ? 'The tracer found the footprint.' : 'The whale slipped the net.'}</p>
        </div>
        <strong>
          {result.winner === view.role ? '+1' : '0'} <small>POINT</small>
        </strong>
      </div>
      <div className="hunt-reveal-card__facts">
        <div>
          <small>WHALE HID IN</small>
          <b>ZONE {result.hiddenZone}</b>
        </div>
        <div>
          <small>TRACER CALL</small>
          <b>{selectedAssetLabel(result)}</b>
        </div>
        <div>
          <small>WHALE PLAY</small>
          <b>{result.whaleMove ? MOVE_COPY[result.whaleMove].title : '—'}</b>
        </div>
        <div>
          <small>DECISIVE CLUE</small>
          <b>{SCAN_COPY[decisiveScan].title}</b>
        </div>
      </div>
      <div className="hunt-reveal-card__explanation">
        <span className="hunt-kicker">WHY THIS ROUND RESOLVED</span>
        <p>{result.explanation}</p>
      </div>
      {matchOver ? (
        <div className="reveal-match-end">
          <span>
            {view.matchWinner === view.role
              ? 'Match won. You own the current.'
              : 'Match lost. The current moved first.'}
          </span>
          <button className="hunt-cta" type="button" onClick={onBackToLobby} disabled={busy}>
            Back to lobby
            <GameIcon name="arrow" size={18} />
          </button>
        </div>
      ) : (
        <span className="reveal-next">Next round is loading from the server…</span>
      )}
    </section>
  );
}

function MatchImpact({ view, onDismiss }: { view: HuntV2MatchView; onDismiss: () => void }) {
  const result = view.roundResult;
  if (!result) return null;
  const ghosted = result.winner === 'whale';
  return (
    <section
      className={`hunt-impact ${ghosted ? 'hunt-impact--escaped' : ''}`}
      aria-live="assertive"
      aria-label={ghosted ? 'Ghosted round result' : 'Busted round result'}
    >
      <div className="hunt-impact__noise" aria-hidden="true" />
      <div className="hunt-impact__rays" aria-hidden="true" />
      <span className="hunt-impact__eyebrow">ROUND {result.roundIndex} RESOLVED</span>
      <h2>{ghosted ? 'GHOSTED' : 'BUSTED'}</h2>
      <div className="hunt-impact__stamp">
        <span>{ghosted ? 'WHALE ESCAPED' : 'SIGNAL CAUGHT'}</span>
        <strong>{selectedAssetLabel(result)}</strong>
      </div>
      <p>{result.explanation}</p>
      <button type="button" onClick={onDismiss}>
        Read the round breakdown <GameIcon name="arrow" size={17} />
      </button>
    </section>
  );
}

function FinalReport({ view }: { view: HuntV2MatchView }) {
  if (view.phase !== 'match_over' || view.roundResults.length === 0) return null;
  return (
    <section className="hunt-final-report" aria-labelledby="hunt-final-report-title">
      <div className="hunt-final-report__heading">
        <div>
          <span className="hunt-kicker">THREE-ROUND RECONSTRUCTION</span>
          <h2 id="hunt-final-report-title">How the current moved.</h2>
        </div>
        <span className="hunt-final-report__score">
          {view.score.tracer} <small>TRACER</small> · {view.score.whale} <small>WHALE</small>
        </span>
      </div>
      <p className="hunt-final-report__lede">
        Every hiding play is now public. The timeline shows the real zone, the footprint style, and
        the clue that would have made the cleanest catch.
      </p>
      <div className="hunt-final-report__timeline">
        {view.roundResults.map((round) => (
          <article
            key={round.roundIndex}
            className={round.winner === view.role ? 'is-your-win' : ''}
          >
            <div className="hunt-final-report__round">
              <span>R{String(round.roundIndex).padStart(2, '0')}</span>
              <b>{round.winner === 'tracer' ? 'BUSTED' : 'GHOSTED'}</b>
            </div>
            <div className="hunt-final-report__route">
              <span>
                Hidden <strong>ZONE {round.hiddenZone}</strong>
              </span>
              <span>
                Move{' '}
                <strong>{round.whaleMove ? MOVE_COPY[round.whaleMove].title : 'Timeout'}</strong>
              </span>
              <span>
                Tracer call <strong>{selectedAssetLabel(round)}</strong>
              </span>
              <span>
                Clue <strong>{SCAN_COPY[round.decisiveScan ?? 'flow'].title}</strong>
              </span>
            </div>
            <p>{round.explanation}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function MatchCode({ matchId }: { matchId: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(matchId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* Clipboard permission is optional; the full code remains in the title. */
    }
  }
  return (
    <button className="match-code" type="button" onClick={() => void copy()} title={matchId}>
      <span>CODE {matchId.slice(0, 8).toUpperCase()}</span>
      <small>{copied ? 'COPIED' : 'COPY'}</small>
    </button>
  );
}

function MatchScreen({
  view,
  now,
  busy,
  error,
  onCommand,
  onBackToLobby,
}: {
  view: HuntV2MatchView;
  now: number;
  busy: boolean;
  error: string;
  onCommand: (command: Omit<HuntV2Command, 'expectedStateVersion' | 'idempotencyKey'>) => void;
  onBackToLobby: () => void;
}) {
  const [draftZone, setDraftZone] = useState<HuntV2Zone>(view.whaleSelection?.zone ?? 'B');
  const [draftMove, setDraftMove] = useState<HuntV2Move>(view.whaleSelection?.move ?? 'blend');
  const [draftDecoy, setDraftDecoy] = useState<HuntV2Zone>(view.whaleSelection?.decoyZone ?? 'A');
  const [targetZone, setTargetZone] = useState<HuntV2Zone>(view.selectedZone ?? 'B');
  const [scanZone, setScanZone] = useState<HuntV2Zone>('B');
  const [impactKey, setImpactKey] = useState<string | null>(null);
  useEffect(() => {
    if (view.whaleSelection) {
      setDraftZone(view.whaleSelection.zone);
      setDraftMove(view.whaleSelection.move);
      if (view.whaleSelection.decoyZone) setDraftDecoy(view.whaleSelection.decoyZone);
    }
    if (view.selectedZone) setTargetZone(view.selectedZone);
  }, [view.whaleSelection, view.selectedZone]);
  const resultKey = view.roundResult ? `${view.roundResult.roundIndex}:${view.stateVersion}` : null;
  useEffect(() => {
    if (!resultKey) return;
    setImpactKey(resultKey);
    const timer = window.setTimeout(() => setImpactKey(null), 3_600);
    return () => window.clearTimeout(timer);
  }, [resultKey]);
  const selectedZone =
    view.role === 'whale' && view.phase === 'whale_hide'
      ? draftZone
      : view.role === 'tracer' && view.phase === 'tracer_hunt'
        ? targetZone
        : (view.roundResult?.hiddenZone ?? null);
  return (
    <section className="hunt-match" aria-label="Whale Hunt match">
      <ScoreHeader view={view} now={now} />
      <div className="hunt-turn-banner">
        <span className={`turn-avatar turn-avatar--${view.role}`}>
          {view.role === 'whale' ? (
            <WhaleSilhouette label="Whale seat" />
          ) : (
            <GameIcon name="search" size={17} />
          )}
        </span>
        <div>
          <strong>{phaseMessage(view)}</strong>
          <span>
            {roleLabel(view.role)} seat ·{' '}
            {view.participants.find((participant) => participant.kind === 'computer')
              ?.displayName === 'Computer'
              ? 'computer opponent'
              : 'human duel'}{' '}
            · server timer
          </span>
        </div>
        <span className="turn-banner__status">
          <span className="sonar-dot" /> LIVE
        </span>
      </div>
      {error && (
        <div className="hunt-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => window.location.reload()}>
            Reconnect
          </button>
        </div>
      )}
      <div className="hunt-combat-grid">
        <div className="hunt-combat-grid__board">
          <HuntBoard
            view={view}
            selectedZone={selectedZone}
            onSelect={(zone) => {
              if (view.role === 'whale' && view.phase === 'whale_hide') setDraftZone(zone);
              if (view.role === 'tracer' && view.phase === 'tracer_hunt') {
                setTargetZone(zone);
                setScanZone(zone);
              }
            }}
            disabled={view.phase !== 'whale_hide' && view.phase !== 'tracer_hunt'}
            selectionLabel={
              view.role === 'tracer'
                ? `Lead suspect: ${targetZone}`
                : `Private marker: ${draftZone}`
            }
          />
        </div>
        <aside className="hunt-combat-grid__panel">
          {view.phase === 'round_intro' && (
            <section className="hunt-state-card">
              <span className="state-card__round">ROUND {view.roundIndex}</span>
              <h2>Eyes on the current.</h2>
              <p>
                {ROLE_COPY[view.role].title} {ROLE_COPY[view.role].detail}
              </p>
              <strong>Briefing ends in {formatRemaining(view, now)}</strong>
            </section>
          )}
          {view.role === 'whale' && view.phase === 'whale_hide' && (
            <WhaleControls
              draftZone={draftZone}
              draftMove={draftMove}
              draftDecoy={draftDecoy}
              busy={busy}
              onZone={setDraftZone}
              onMove={setDraftMove}
              onDecoy={setDraftDecoy}
              onHide={() =>
                onCommand({
                  kind: 'select-whale-plan',
                  zone: draftZone,
                  move: draftMove,
                  ...(draftMove === 'decoy' ? { decoyZone: draftDecoy } : {}),
                })
              }
            />
          )}
          {view.role === 'tracer' && view.phase === 'tracer_hunt' && (
            <TracerControls
              view={view}
              targetZone={targetZone}
              scanZone={scanZone}
              busy={busy}
              onScanZone={(zone) => {
                setScanZone(zone);
                setTargetZone(zone);
              }}
              onScan={(scan) => onCommand({ kind: 'scan', zone: scanZone, scan })}
              onCatch={() => onCommand({ kind: 'lock-catch', zone: targetZone })}
            />
          )}
          {view.role === 'whale' && view.phase === 'tracer_hunt' && (
            <section className="hunt-state-card hunt-state-card--waiting">
              <span className="waiting-icon">
                <GameIcon name="search" size={23} />
              </span>
              <h2>Tracer is hunting.</h2>
              <p>Your private move is locked. Watch the live intel strip as they spend scans.</p>
            </section>
          )}
          {view.role === 'tracer' && view.phase === 'whale_hide' && (
            <section className="hunt-state-card hunt-state-card--waiting">
              <span className="waiting-icon">
                <WhaleSilhouette label="Whale is hiding" />
              </span>
              <h2>Whale is hiding.</h2>
              <p>A private footprint is being planted. Your board unlocks when the signal lands.</p>
            </section>
          )}
        </aside>
      </div>
      {(view.phase === 'round_reveal' || view.phase === 'match_over') && (
        <RoundReveal view={view} busy={busy} onBackToLobby={onBackToLobby} />
      )}
      <FinalReport view={view} />
      {impactKey === resultKey && <MatchImpact view={view} onDismiss={() => setImpactKey(null)} />}
      <div className="hunt-match-footer">
        <span>
          <span className="sonar-dot" /> Provider activity is measured, bounded, and informational.
        </span>
        <span className="hunt-match-footer__right">
          <MatchCode matchId={view.matchId} />
          <span>v{view.stateVersion}</span>
        </span>
      </div>
    </section>
  );
}

export function HuntScreen({
  initialRole = 'tracer',
  initialMatch,
  matchId: initialMatchId,
  transport,
  lobbyTransport,
  sourceMode = 'training',
  sourceReason,
}: HuntScreenProps = {}) {
  const api = useMemo(() => transport ?? createHuntV2ApiTransport(), [transport]);
  const lobbyApi = useMemo(() => lobbyTransport ?? createHuntLobbyApiTransport(), [lobbyTransport]);
  const [role, setRole] = useState<HuntV2Role>(initialRole);
  const [match, setMatch] = useState<HuntV2MatchView | null>(initialMatch ?? null);
  const [matchId, setMatchId] = useState<string | null>(
    initialMatchId ?? initialMatch?.matchId ?? null,
  );
  const [lobbyId, setLobbyId] = useState<string | null>(null);
  const [lobby, setLobby] = useState<HuntLobbyView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [account, setAccount] = useState<AccountView | null>(null);
  const [progression, setProgression] = useState<ProgressionView | null>(null);
  const [entryMode, setEntryMode] = useState<HuntMode | 'menu'>(
    initialMatch || initialMatchId ? 'duel' : 'menu',
  );
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!matchId) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await api.getMatch(matchId);
        if (!cancelled) {
          setMatch(next);
          setRole(next.role);
          setError('');
        }
      } catch (caught) {
        if (!cancelled)
          setError(caught instanceof Error ? caught.message : 'Could not restore the Hunt.');
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 800);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, matchId]);
  useEffect(() => {
    if (match) return;
    let cancelled = false;
    void Promise.all([
      fetch('/api/account', { credentials: 'same-origin' }).then(
        (response) => response.json() as Promise<AccountView>,
      ),
      fetch('/api/progression', { credentials: 'same-origin' }).then(
        (response) => response.json() as Promise<ProgressionView>,
      ),
    ])
      .then(([nextAccount, nextProgression]) => {
        if (!cancelled) {
          setAccount(nextAccount);
          setProgression(nextProgression);
        }
      })
      .catch(() => {
        /* Profile data is additive; the match lobby remains usable if it is unavailable. */
      });
    return () => {
      cancelled = true;
    };
  }, [match]);
  useEffect(() => {
    if (!lobbyId || matchId || match) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await lobbyApi.getLobby(lobbyId);
        if (cancelled) return;
        setLobby(next);
        setRole(next.role);
        if (next.status === 'matched' && next.matchId) {
          setMatchId(next.matchId);
          setLobbyId(null);
          try {
            window.sessionStorage.removeItem('whale-hunt.lobby');
            window.sessionStorage.setItem('whale-hunt.match', next.matchId);
          } catch {
            /* optional */
          }
        }
      } catch (caught) {
        if (!cancelled)
          setError(caught instanceof Error ? caught.message : 'Could not read the lobby.');
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 900);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [lobbyApi, lobbyId, match, matchId]);
  function enterMatch(next: HuntV2MatchView): void {
    setEntryMode('duel');
    setMatch(next);
    setMatchId(next.matchId);
    setRole(next.role);
    setLobby(null);
    setLobbyId(null);
    try {
      window.sessionStorage.removeItem('whale-hunt.lobby');
      window.sessionStorage.setItem('whale-hunt.match', next.matchId);
    } catch {
      /* optional */
    }
  }
  async function start(opponentMode: OpponentMode = 'computer') {
    setEntryMode('duel');
    setBusy(true);
    setError('');
    try {
      if (opponentMode === 'computer') {
        enterMatch(
          await api.createMatch({
            role,
            idempotencyKey: `hunt-computer-${Date.now()}`,
          }),
        );
      } else {
        const next = await lobbyApi.joinLobby({
          role,
          idempotencyKey: `hunt-lobby-${Date.now()}`,
        });
        setRole(next.role);
        setLobby(next);
        setLobbyId(next.lobbyId);
        try {
          window.sessionStorage.setItem('whale-hunt.lobby', next.lobbyId);
        } catch {
          /* optional */
        }
        if (next.status === 'matched' && next.matchId) enterMatch(await api.getMatch(next.matchId));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not enter the Hunt lobby.');
    } finally {
      setBusy(false);
    }
  }
  async function join(requestedMatchId: string) {
    setBusy(true);
    setError('');
    try {
      const next = await api.joinMatch(requestedMatchId, `hunt-v2-join-${Date.now()}`);
      enterMatch(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not join the Hunt duel.');
    } finally {
      setBusy(false);
    }
  }
  async function send(command: Omit<HuntV2Command, 'expectedStateVersion' | 'idempotencyKey'>) {
    if (!matchId || !match || busy) return;
    setBusy(true);
    setError('');
    try {
      let next = await api.command(matchId, {
        ...command,
        ...commandMeta(match, command.kind),
      } as HuntV2Command);
      if (command.kind === 'select-whale-plan')
        next = await api.command(matchId, {
          kind: 'hide-trade',
          ...commandMeta(next, 'hide-trade'),
        });
      setMatch(next);
    } catch (caught) {
      if (caught instanceof HuntV2ApiError && caught.stateVersion !== undefined) {
        try {
          setMatch(await api.getMatch(matchId));
        } catch {
          /* retain error */
        }
      }
      setError(caught instanceof Error ? caught.message : 'That Hunt action was not accepted.');
    } finally {
      setBusy(false);
    }
  }
  function backToLobby(): void {
    setMatch(null);
    setMatchId(null);
    setLobby(null);
    setLobbyId(null);
    setEntryMode('duel');
    setError('');
    try {
      window.sessionStorage.removeItem('whale-hunt.match');
      window.sessionStorage.removeItem('whale-hunt.lobby');
    } catch {
      /* optional */
    }
  }
  async function cancelLobby() {
    if (!lobbyId || busy) return;
    setBusy(true);
    try {
      await lobbyApi.cancelLobby(lobbyId, `hunt-lobby-cancel-${Date.now()}`);
    } catch {
      /* The seat may have matched between polls; the next refresh owns the truth. */
    }
    setLobby(null);
    setLobbyId(null);
    try {
      window.sessionStorage.removeItem('whale-hunt.lobby');
    } catch {
      /* optional */
    }
    setBusy(false);
  }
  async function rename(displayName: string): Promise<void> {
    try {
      const response = await fetch('/api/account/name', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName }),
      });
      if (!response.ok) throw new Error('That handle could not be saved.');
      setAccount((current) => (current ? { ...current, displayName } : current));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That handle could not be saved.');
    }
  }
  return (
    <div className="whale-hunt">
      <div className="hunt-shell">
        {entryMode === 'menu' && !match && !lobby ? (
          <ModeLobby sourceMode={sourceMode} sourceReason={sourceReason} onSelect={setEntryMode} />
        ) : entryMode === 'real' && !match && !lobby ? (
          <SignalHuntScreen onBack={() => setEntryMode('menu')} />
        ) : !match && lobby ? (
          <LobbyWaiting view={lobby} now={now} busy={busy} onCancel={() => void cancelLobby()} />
        ) : !match ? (
          <Lobby
            role={role}
            onRole={setRole}
            busy={busy}
            onStart={(mode) => void start(mode)}
            onJoin={(requestedMatchId) => void join(requestedMatchId)}
            account={account}
            progression={progression}
            onRename={rename}
            sourceMode={sourceMode}
            onBack={() => setEntryMode('menu')}
          />
        ) : (
          <MatchScreen
            view={match}
            now={now}
            busy={busy}
            error={error}
            onCommand={(command) => void send(command)}
            onBackToLobby={backToLobby}
          />
        )}
        {error && !match && (
          <div className="hunt-lobby-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError('')}>
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Compatibility copy retained for previously saved v1 state.
const LEGACY_V1_PRIVACY_FIELD = 'view.ownTargets';
function TracerPanel() {
  return null;
}
function HuntRevealPanel() {
  return null;
}
const LEGACY_HUNT_COPY = [
  'Build your position. Leave them chasing the wrong trail.',
  'Read the footprints. Find the hidden targets.',
  'Finding players… computers join in 8 seconds.',
  'Six locations. One hidden pattern.',
  'Finish investigating',
  'FINAL RECONSTRUCTION',
  'Skip reveal animation',
  'Rematch',
  'Swap roles',
];
void LEGACY_V1_PRIVACY_FIELD;
void LEGACY_HUNT_COPY;
void TracerPanel;
void HuntRevealPanel;

import { useEffect, useMemo, useState } from 'react';
import type {
  SignalHuntCandidateView,
  SignalHuntCaseSummary,
  SignalHuntDirection,
  SignalHuntLane,
  SignalHuntThesis,
  SignalHuntTransport,
  SignalHuntView,
} from '../../shared/signal-hunt.js';
import { SIGNAL_HUNT_LANES, SIGNAL_HUNT_THESES } from '../../shared/signal-hunt.js';
import { createSignalHuntApiTransport, SignalHuntApiError } from '../api/signal-hunt.js';
import { GameIcon } from '../game-ui/primitives.js';

const LANE_LABELS: Record<SignalHuntLane, string> = {
  flow: 'Smart Money flow',
  whales: 'Whale footprint',
  cohort: 'Holder cohort',
  tape: 'Trade tape',
  market: 'Price + volume',
};

const THESIS_LABELS: Record<SignalHuntThesis, string> = {
  accumulation: 'Accumulation',
  distribution: 'Distribution',
  'whale-activity': 'Whale activity',
  'mixed-signal': 'Mixed signal',
};
const DIRECTION_LABELS: Record<SignalHuntDirection, string> = {
  long: 'Long · accumulation',
  short: 'Short · distribution',
};

function money(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}m`;
  if (absolute >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
}

function price(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 1_000) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (value >= 1) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `$${value.toLocaleString(undefined, { maximumSignificantDigits: 4 })}`;
}

function linePoints(values: readonly number[]): string {
  if (!values.length) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  return values
    .map((value, index) => {
      const x = 8 + (index / Math.max(1, values.length - 1)) * 284;
      const y = 76 - ((value - min) / Math.max(0.0001, max - min)) * 58;
      return `${x.toFixed(1)},${Math.max(8, Math.min(76, y)).toFixed(1)}`;
    })
    .join(' ');
}

function SignalChart({
  candidate,
  outcome = false,
}: {
  candidate: SignalHuntCandidateView;
  outcome?: boolean;
}) {
  const points =
    outcome && 'outcomeChart' in candidate
      ? (candidate as SignalHuntCandidateView & { outcomeChart: readonly { value: number }[] })
          .outcomeChart
      : candidate.chart;
  const values = points.map((point) => point.value);
  const first = values[0] ?? 0;
  const last = values.at(-1) ?? first;
  const move = first ? (last / first - 1) * 100 : 0;
  return (
    <div className="signal-hunt-chart" role="img" aria-label={`${candidate.alias} price trace`}>
      <svg viewBox="0 0 300 96" preserveAspectRatio="none" aria-hidden="true">
        {[22, 48, 74].map((y) => (
          <line key={y} className="signal-hunt-chart__grid" x1="8" x2="292" y1={y} y2={y} />
        ))}
        <polyline
          className={`signal-hunt-chart__line ${outcome ? 'is-outcome' : ''}`}
          points={linePoints(values)}
        />
      </svg>
      <span className={move >= 0 ? 'is-positive' : 'is-negative'}>
        {move >= 0 ? '+' : ''}
        {move.toFixed(2)}%
      </span>
    </div>
  );
}

function CasePicker({
  cases,
  selected,
  onSelect,
  onStart,
  busy,
  onBack,
}: {
  cases: readonly SignalHuntCaseSummary[];
  selected: SignalHuntCaseSummary | null;
  onSelect: (value: SignalHuntCaseSummary) => void;
  onStart: () => void;
  busy: boolean;
  onBack: () => void;
}) {
  const hasCases = cases.length > 0;
  return (
    <section className="signal-hunt-entry" aria-labelledby="signal-hunt-title">
      <div className="signal-hunt-entry__copy">
        <button className="signal-hunt-back" type="button" onClick={onBack}>
          ← Back to modes
        </button>
        <span className="hunt-lobby__eyebrow">
          <span className="sonar-dot" /> REAL DATA REPLAY · SIGNAL HUNT
        </span>
        <h1 id="signal-hunt-title">
          Catch the <em>real signal.</em>
        </h1>
        <p>
          Choose a frozen current, inspect five evidence lanes, and identify the asset with the
          strongest whale or Smart Money footprint. Every clue belongs to the selected snapshot.
        </p>
      </div>
      {hasCases ? (
        <div className="signal-hunt-case-list" aria-label="Available real-data cases">
          {cases.map((candidateCase) => (
            <button
              key={candidateCase.caseId}
              type="button"
              className={`signal-hunt-case ${selected?.caseId === candidateCase.caseId ? 'is-selected' : ''}`}
              onClick={() => onSelect(candidateCase)}
            >
              <span className="signal-hunt-case__tag">
                {candidateCase.sourceKind === 'historical-reconstructed'
                  ? 'HISTORICAL SNAPSHOT'
                  : 'LIVE SIGNAL'}
              </span>
              <strong>{candidateCase.title}</strong>
              <small>{candidateCase.subtitle}</small>
              <span>
                {candidateCase.candidateCount} assets ·{' '}
                {new Date(candidateCase.snapshotAt).toLocaleString()}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="signal-hunt-empty" role="status">
          <span className="hunt-kicker">NO SNAPSHOT READY</span>
          <strong>There is no provider snapshot to hunt yet.</strong>
          <p>
            Start the server with a working Nansen key, or use the five included historical replay
            cases.
          </p>
        </div>
      )}
      <div className="signal-hunt-entry__footer">
        <span>{selected?.sourceLabel ?? 'Select a case'}</span>
        <button className="hunt-cta" type="button" disabled={!selected || busy} onClick={onStart}>
          {busy ? 'Opening case…' : 'Start investigation'} <GameIcon name="arrow" size={18} />
        </button>
      </div>
    </section>
  );
}

function CandidateCard({
  candidate,
  selected,
  onSelect,
  disabled,
  revealed = false,
}: {
  candidate: SignalHuntCandidateView;
  selected: boolean;
  onSelect: () => void;
  disabled: boolean;
  revealed?: boolean;
}) {
  return (
    <button
      type="button"
      className={`signal-hunt-candidate ${selected ? 'is-selected' : ''} ${revealed ? 'is-revealed' : ''}`}
      onClick={onSelect}
      disabled={disabled}
    >
      <span className="signal-hunt-candidate__topline">
        <b>{candidate.alias}</b>
        <span>{candidate.chain}</span>
      </span>
      <strong>
        {revealed && 'name' in candidate && 'symbol' in candidate
          ? `${candidate.name} · ${candidate.symbol}`
          : 'Identity sealed until lock'}
      </strong>
      <SignalChart candidate={candidate} outcome={revealed} />
      <span className="signal-hunt-candidate__facts">
        <span>
          <small>PRICE</small>
          <b>{price(candidate.currentPrice)}</b>
        </span>
        <span>
          <small>MOVE</small>
          <b className={(candidate.changePct ?? 0) >= 0 ? 'is-positive' : 'is-negative'}>
            {candidate.changePct === undefined
              ? '—'
              : `${candidate.changePct >= 0 ? '+' : ''}${candidate.changePct.toFixed(2)}%`}
          </b>
        </span>
        <span>
          <small>LIQUIDITY</small>
          <b>{money(candidate.liquidityUsd)}</b>
        </span>
      </span>
      <span className="signal-hunt-candidate__footer">
        {selected ? 'Selected' : 'Inspect this asset'} <span>{selected ? '✓' : '→'}</span>
      </span>
    </button>
  );
}

function EvidenceLaneBar({
  view,
  selected,
  onSelectLane,
  busy,
}: {
  view: SignalHuntView;
  selected: SignalHuntCandidateView | undefined;
  onSelectLane: (lane: SignalHuntLane) => void;
  busy: boolean;
}) {
  const scanned = new Set(view.scans.map((scan) => scan.clueId));
  return (
    <section className="signal-hunt-evidence-lanes" aria-label="Evidence lanes">
      <div className="signal-hunt-evidence-lanes__heading">
        <div>
          <span className="hunt-kicker">CHOOSE THE EVIDENCE</span>
          <strong>{selected ? `Inspecting ${selected.alias}` : 'Select a signal above'}</strong>
        </div>
        <span>{view.scansRemaining} scans left</span>
      </div>
      <div className="signal-hunt-lanes">
        {SIGNAL_HUNT_LANES.map((lane) => {
          const descriptor = selected?.clueDescriptors.find((item) => item.lane === lane);
          const alreadyScanned = descriptor ? scanned.has(descriptor.clueId) : false;
          return (
            <button
              key={lane}
              type="button"
              className="signal-hunt-lane"
              disabled={busy || !selected || alreadyScanned || view.scansRemaining === 0}
              onClick={() => onSelectLane(lane)}
            >
              <span className="signal-hunt-lane__index">
                {alreadyScanned
                  ? '✓'
                  : String(SIGNAL_HUNT_LANES.indexOf(lane) + 1).padStart(2, '0')}
              </span>
              <span>
                <b>{LANE_LABELS[lane]}</b>
                <small>{descriptor?.question ?? 'Provider coverage unavailable'}</small>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function InvestigationPanel({
  view,
  selected,
  thesis,
  direction,
  onThesis,
  onDirection,
  onLock,
  busy,
}: {
  view: SignalHuntView;
  selected: SignalHuntCandidateView | undefined;
  thesis: SignalHuntThesis;
  direction: SignalHuntDirection;
  onThesis: (value: SignalHuntThesis) => void;
  onDirection: (value: SignalHuntDirection) => void;
  onLock: () => void;
  busy: boolean;
}) {
  return (
    <aside className="signal-hunt-investigation">
      <div className="signal-hunt-investigation__heading">
        <div>
          <span className="hunt-kicker">EVIDENCE DESK</span>
          <h2>Read the current.</h2>
        </div>
        <strong>{view.scansRemaining} scans</strong>
      </div>
      <p className="signal-hunt-muted">
        Evidence selected below the charts appears here with its Nansen timestamp and metrics.
      </p>
      {selected ? (
        <div className="signal-hunt-selected">
          <span>FOCUS ASSET</span>
          <strong>{selected.alias}</strong>
          <small>{selected.chain} · identity sealed</small>
        </div>
      ) : (
        <div className="signal-hunt-selected signal-hunt-selected--empty">
          Select a candidate to inspect.
        </div>
      )}
      {view.scans.length > 0 && (
        <div className="signal-hunt-log">
          <span className="hunt-kicker">INTEL LOG</span>
          {view.scans.map((scan) => (
            <article key={scan.clueId}>
              <small>
                {scan.candidateAlias ?? 'Selected signal'} · {scan.sourceLabel} · {scan.lane}
              </small>
              <strong>{scan.headline}</strong>
              <p>{scan.detail}</p>
              <div>
                {scan.metrics.map((metric) => (
                  <span key={metric.label}>
                    <small>{metric.label}</small>
                    <b>{metric.value}</b>
                  </span>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
      <div className="signal-hunt-thesis">
        <span className="hunt-kicker">YOUR THESIS</span>
        <div>
          {SIGNAL_HUNT_THESES.map((value) => (
            <button
              key={value}
              type="button"
              className={thesis === value ? 'is-selected' : ''}
              onClick={() => onThesis(value)}
              disabled={busy}
            >
              {THESIS_LABELS[value]}
            </button>
          ))}
        </div>
      </div>
      <div className="signal-hunt-position">
        <span className="hunt-kicker">POSITION READ</span>
        <div>
          {(['long', 'short'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={direction === value ? 'is-selected' : ''}
              onClick={() => onDirection(value)}
              disabled={busy}
            >
              {DIRECTION_LABELS[value]}
            </button>
          ))}
        </div>
      </div>
      <button className="hunt-cta" type="button" disabled={busy || !selected} onClick={onLock}>
        Lock {direction} read <GameIcon name="arrow" size={18} />
      </button>
    </aside>
  );
}

function ResultPanel({ view, onBack }: { view: SignalHuntView; onBack: () => void }) {
  const result = view.result;
  if (!result) return null;
  const selectedAlias =
    view.candidates.find((candidate) => candidate.assetId === result.selectedAssetId)?.alias ??
    'your signal';
  const targetDirection = result.targetDirection ?? result.target.direction ?? 'long';
  const correctDirection = result.correctDirection ?? targetDirection === result.selectedDirection;
  return (
    <section
      className={`signal-hunt-result ${result.correctAsset ? 'is-caught' : 'is-missed'}`}
      aria-live="polite"
    >
      <div className="signal-hunt-result__heading">
        <div>
          <span className="hunt-kicker">SNAPSHOT REVEAL · {view.case.sourceLabel}</span>
          <h2>{result.correctAsset ? 'Signal caught.' : 'The current moved elsewhere.'}</h2>
          <p>
            You chose <strong>{selectedAlias}</strong>. {result.explanation}
          </p>
        </div>
        <strong>
          {result.score}
          <small>POINTS</small>
        </strong>
      </div>
      <div className="signal-hunt-result__target">
        <div>
          <span className="hunt-kicker">TARGET ASSET</span>
          <h3>
            {result.target.alias}{' '}
            <small>
              {result.target.name} · {result.target.symbol}
            </small>
          </h3>
          <p>
            {result.target.chain} · {targetDirection.toUpperCase()} ·{' '}
            {THESIS_LABELS[result.targetThesis]}
          </p>
        </div>
        <SignalChart candidate={result.target} outcome />
      </div>
      <div className="signal-hunt-result__evidence">
        <span className="hunt-kicker">WHY NANSEN FLAGGED IT</span>
        <div>
          {result.target.unlockedClues.map((clue) => (
            <article key={clue.clueId}>
              <b>{clue.title}</b>
              <strong>{clue.headline}</strong>
              <p>{clue.detail}</p>
              <div>
                {clue.metrics.map((metric) => (
                  <span key={metric.label}>
                    <small>{metric.label}</small>
                    <b>{metric.value}</b>
                  </span>
                ))}
              </div>
            </article>
          ))}
        </div>
      </div>
      <div className="signal-hunt-result__actions">
        <span>
          {result.correctThesis
            ? 'Thesis confirmed · +250'
            : `Actual read: ${THESIS_LABELS[result.targetThesis]}`}
          {' · '}
          {correctDirection
            ? 'Direction confirmed · +200'
            : `Direction: ${targetDirection.toUpperCase()}`}
        </span>
        <button className="hunt-cta" type="button" onClick={onBack}>
          Choose another snapshot <GameIcon name="arrow" size={18} />
        </button>
      </div>
    </section>
  );
}

export interface SignalHuntScreenProps {
  readonly transport?: SignalHuntTransport;
  readonly onBack: () => void;
}

export function SignalHuntScreen({ transport, onBack }: SignalHuntScreenProps) {
  const api = useMemo(() => transport ?? createSignalHuntApiTransport(), [transport]);
  const [cases, setCases] = useState<readonly SignalHuntCaseSummary[]>([]);
  const [selectedCase, setSelectedCase] = useState<SignalHuntCaseSummary | null>(null);
  const [view, setView] = useState<SignalHuntView | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [thesis, setThesis] = useState<SignalHuntThesis>('accumulation');
  const [direction, setDirection] = useState<SignalHuntDirection>('long');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void api
      .listCases()
      .then((next) => {
        if (!cancelled) {
          setCases(next);
          setSelectedCase(next[0] ?? null);
        }
      })
      .catch((caught) => {
        if (!cancelled)
          setError(caught instanceof Error ? caught.message : 'Signal cases unavailable.');
      });
    return () => {
      cancelled = true;
    };
  }, [api]);
  async function start() {
    if (!selectedCase || busy) return;
    setBusy(true);
    setError('');
    try {
      setView(
        await api.start({
          caseId: selectedCase.caseId,
          idempotencyKey: `signal-start-${Date.now()}`,
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The case could not open.');
    } finally {
      setBusy(false);
    }
  }
  async function command(command: Parameters<SignalHuntTransport['command']>[1]) {
    if (!view || busy) return;
    setBusy(true);
    setError('');
    try {
      setView(
        await api.command(view.attemptId, {
          ...command,
          expectedStateVersion: view.stateVersion,
          idempotencyKey: `${command.kind}-${Date.now()}`,
        } as never),
      );
    } catch (caught) {
      if (caught instanceof SignalHuntApiError && caught.stateVersion !== undefined) {
        try {
          setView(await api.get(view.attemptId));
        } catch {
          /* keep the current error */
        }
      }
      setError(caught instanceof Error ? caught.message : 'That investigation was not accepted.');
    } finally {
      setBusy(false);
    }
  }
  if (error && !cases.length)
    return (
      <section className="signal-hunt-entry">
        <p className="hunt-lobby-error">{error}</p>
        <button className="hunt-ghost-button" type="button" onClick={onBack}>
          Back
        </button>
      </section>
    );
  if (!view)
    return (
      <CasePicker
        cases={cases}
        selected={selectedCase}
        onSelect={setSelectedCase}
        onStart={() => void start()}
        busy={busy}
        onBack={onBack}
      />
    );
  const selected = view.candidates.find((candidate) => candidate.assetId === selectedAssetId);
  return (
    <section className="signal-hunt-play" aria-label="Real Whale Hunt">
      <header className="signal-hunt-play__header">
        <div>
          <button className="signal-hunt-back" type="button" onClick={onBack}>
            ← Exit hunt
          </button>
          <span className="hunt-kicker">REAL WHALE HUNT · {view.case.sourceLabel}</span>
          <h1>{view.case.title}</h1>
          <p>{view.case.subtitle}</p>
        </div>
        <div>
          <span>SNAPSHOT</span>
          <strong>{new Date(view.case.snapshotAt).toLocaleString()}</strong>
          <small>{view.case.candidateCount} candidates · frozen evidence</small>
        </div>
      </header>
      {error && (
        <div className="hunt-error" role="alert">
          {error}
        </div>
      )}
      {view.phase === 'investigate' ? (
        <div className="signal-hunt-play__grid">
          <div>
            <div className="signal-hunt-candidate-grid">
              {view.candidates.map((candidate) => (
                <CandidateCard
                  key={candidate.assetId}
                  candidate={candidate}
                  selected={selectedAssetId === candidate.assetId}
                  onSelect={() => setSelectedAssetId(candidate.assetId)}
                  disabled={busy}
                />
              ))}
            </div>
            <EvidenceLaneBar
              view={view}
              selected={selected}
              onSelectLane={(lane) => {
                if (selected)
                  void command({
                    kind: 'scan',
                    candidateId: selected.assetId,
                    lane,
                    expectedStateVersion: view.stateVersion,
                    idempotencyKey: '',
                  });
              }}
              busy={busy}
            />
            <p className="signal-hunt-disclaimer">
              Evidence is informational. Identity, labels, and coverage are revealed from the frozen
              Nansen case after lock.
            </p>
          </div>
          <InvestigationPanel
            view={view}
            selected={selected}
            thesis={thesis}
            direction={direction}
            onThesis={setThesis}
            onDirection={setDirection}
            onLock={() => {
              if (selected)
                void command({
                  kind: 'lock',
                  candidateId: selected.assetId,
                  thesis,
                  direction,
                  expectedStateVersion: view.stateVersion,
                  idempotencyKey: '',
                });
            }}
            busy={busy}
          />
        </div>
      ) : (
        <ResultPanel
          view={view}
          onBack={() => {
            setView(null);
            setSelectedAssetId(null);
          }}
        />
      )}
    </section>
  );
}

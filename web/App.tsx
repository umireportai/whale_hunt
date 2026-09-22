import { useEffect, useState } from 'react';
import { api } from './api';
import { HuntScreen } from './hunt/index';
import { WhaleSilhouette } from './game-ui/primitives';

type FeedState = 'loading' | 'live' | 'replay' | 'unavailable' | 'training';

interface HealthState {
  readonly mode?: 'live' | 'synthetic' | 'unavailable';
  readonly provider?: 'nansen' | 'disabled' | 'unavailable';
  readonly realHuntMode?: 'live' | 'historical' | 'none';
  readonly reason?: string;
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [feed, setFeed] = useState<FeedState>('loading');
  const [feedReason, setFeedReason] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api('/sessions', {}),
      fetch('/healthz', { credentials: 'same-origin' }).then(async (response) => {
        if (!response.ok) throw new Error('The Whale Hunt health check failed.');
        return (await response.json()) as HealthState;
      }),
    ])
      .then(([, health]) => {
        if (cancelled) return;
        setFeed(
          health.provider === 'nansen' && health.mode === 'live'
            ? 'live'
            : health.realHuntMode === 'historical'
              ? 'replay'
              : health.mode === 'unavailable'
                ? 'unavailable'
                : 'training',
        );
        setFeedReason(health.reason ?? '');
        setReady(true);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : 'The Hunt connection slipped.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="whale-app">
      <header className="global-header">
        <a className="global-brand" href="/" aria-label="Whale Hunt home">
          <span className="global-brand__mark">
            <WhaleSilhouette label="Whale Hunt" />
          </span>
          <span>
            <strong>WHALE</strong> HUNT
            <small>READ THE CURRENT · CATCH THE MOVE</small>
          </span>
        </a>
        <div className="global-header__status" aria-label="Data feed status">
          <span className={`feed-dot feed-dot--${feed}`} />
          <span>
            {feed === 'live'
              ? 'NANSEN FEED'
              : feed === 'replay'
                ? 'NANSEN REPLAY'
                : feed === 'unavailable'
                  ? 'NANSEN OFFLINE'
                  : feed === 'training'
                    ? 'DUEL FEED'
                    : 'CONNECTING'}
          </span>
        </div>
      </header>

      {error ? (
        <main className="app-error" role="alert">
          <span className="app-error__code">SIGNAL LOST</span>
          <h1>Couldn’t reach Whale Hunt.</h1>
          <p>{error}</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reconnect
          </button>
        </main>
      ) : !ready ? (
        <main className="app-loading" aria-live="polite">
          <span className="app-loading__ring" />
          <span>Syncing the current…</span>
        </main>
      ) : (
        <main>
          <HuntScreen
            sourceReason={feedReason}
            sourceMode={
              feed === 'live'
                ? 'live'
                : feed === 'replay'
                  ? 'historical'
                  : feed === 'unavailable'
                    ? 'unavailable'
                    : 'training'
            }
          />
        </main>
      )}
    </div>
  );
}

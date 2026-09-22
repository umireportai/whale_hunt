import type { CSSProperties, ReactNode } from 'react';
import type { EvidenceCategory } from '../../shared/evidence.js';

export type GameUiState =
  'default' | 'loading' | 'empty' | 'unavailable' | 'selected' | 'locked' | 'revealed';

export type GameUiNamespace = 'whale-hunt';

export interface UiNamespaceProps {
  namespace?: GameUiNamespace;
  className?: string;
}

export interface ChartPoint {
  at?: string;
  value: number | string;
}

export interface ChartScale {
  min: number;
  max: number;
}

export const ASSET_ACCENTS = [
  '#69ddbb',
  '#6cb8ff',
  '#a89bff',
  '#f2bd69',
  '#55d8e9',
  '#ef9fba',
] as const;

export const EVIDENCE_CATEGORY_LABELS: Record<EvidenceCategory, string> = {
  flow: 'Flow',
  crowd: 'Crowd',
  'whale-footprint': 'Whale footprint',
  volume: 'Volume',
  volatility: 'Volatility',
  absorption: 'Absorption',
};

export type GameIconName =
  | 'alert'
  | 'arrow'
  | 'cash'
  | 'check'
  | 'chevron'
  | 'close'
  | 'flow'
  | 'lock'
  | 'pin'
  | 'pulse'
  | 'search'
  | 'short'
  | 'long'
  | 'user'
  | 'volume'
  | 'whale'
  | 'whale-footprint'
  | 'volatility'
  | 'absorption';

const ICON_PATHS: Record<GameIconName, ReactNode> = {
  alert: (
    <>
      <path d="M12 3 2.8 20h18.4L12 3Z" />
      <path d="M12 9v5M12 17h.01" />
    </>
  ),
  arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
  cash: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <circle cx="12" cy="12" r="3" />
      <path d="M6 12h.01M18 12h.01" />
    </>
  ),
  check: <path d="m5 12 4 4L20 5" />,
  chevron: <path d="m8 10 4 4 4-4" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  flow: (
    <>
      <path d="M3 8h16m-4-4 4 4-4 4M21 16H5m4-4-4 4 4 4" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="3" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
    </>
  ),
  pin: (
    <>
      <path d="m15 4 5 5-3 1-3 5-1 4-2-2 2-3-5-5 1-3 6-2Z" />
      <path d="m5 19 3-3" />
    </>
  ),
  pulse: <path d="M2 12h5l3-8 4 16 3-8h5" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  short: <path d="M4 7h16M4 17h16M8 7l-4 4 4 4" />,
  long: <path d="M4 17h16M4 7h16m8 10 4-4-4-4" />,
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 21v-2a7 7 0 0 1 14 0v2" />
    </>
  ),
  volume: (
    <>
      <path d="M3 13h4l4-4v10l-4-4H3v-2Z" />
      <path d="M16 9a5 5 0 0 1 0 6M19 6a9 9 0 0 1 0 12" />
    </>
  ),
  whale: (
    <>
      <path d="M4 13c4-1 6-5 12-5 5 0 8 3 9 7 2-1 4-3 6-3-1 4-3 6-6 7C17 23 6 21 4 13Z" />
      <path d="M16 8c-2-4 0-6 1-6 2 1 2 3 2 5M20 8c1-3 3-4 4-3-1 2-2 3-4 4" />
      <circle cx="10" cy="13" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  'whale-footprint': (
    <>
      <path d="M5 18c3-3 5-6 6-10m2 12c2-3 4-6 6-9" />
      <circle cx="7" cy="7" r="2" />
      <circle cx="18" cy="16" r="2" />
    </>
  ),
  volatility: (
    <>
      <path d="m3 16 4-5 4 3 4-8 6 5" />
      <path d="M3 21h18" />
    </>
  ),
  absorption: (
    <>
      <path d="M4 6v12M9 9v6M14 4v16M19 8v8" />
      <path d="M2 12h20" />
    </>
  ),
};

export function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function uiRoot(namespace?: GameUiNamespace, className?: string): string {
  return classNames('game-ui', namespace, className);
}

export function assetAccent(index: number): string {
  return ASSET_ACCENTS[Math.abs(index) % ASSET_ACCENTS.length] ?? ASSET_ACCENTS[0];
}

export function toChartNumber(value: number | string): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** Display-only index values start at 100; this never changes settlement inputs. */
export function normalizeToStartingIndex(values: readonly (number | string)[]): number[] {
  if (values.length === 0) return [];
  const first = toChartNumber(values[0]!);
  if (first === 0) return values.map(() => 100);
  return values.map((value) => (toChartNumber(value) / first) * 100);
}

export function getSharedChartScale(
  series: readonly (readonly (number | string)[])[],
  padding = 2,
): ChartScale {
  const normalized = series.flatMap((values) => normalizeToStartingIndex(values));
  if (normalized.length === 0) return { min: 98, max: 102 };
  const min = Math.min(...normalized);
  const max = Math.max(...normalized);
  if (min === max) return { min: min - padding, max: max + padding };
  return { min: min - padding, max: max + padding };
}

export function formatIndexDelta(value: number): string {
  const delta = value - 100;
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`;
}

export function categoryIcon(category: EvidenceCategory): GameIconName {
  if (category === 'whale-footprint') return 'whale-footprint';
  if (category === 'volatility') return 'volatility';
  if (category === 'absorption') return 'absorption';
  if (category === 'volume') return 'volume';
  if (category === 'crowd') return 'user';
  return 'flow';
}

export function GameIcon({
  name,
  size = 18,
  label,
  className,
}: {
  name: GameIconName;
  size?: number;
  label?: string;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {label && <title>{label}</title>}
      {ICON_PATHS[name]}
    </svg>
  );
}

export function WhaleSilhouette({
  label = 'Whale Hunt',
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <svg className={className} viewBox="0 0 64 40" fill="none" role="img" aria-label={label}>
      <path
        d="M5 19c8-1 12-9 25-9 11 0 17 6 19 13 4-2 7-5 11-5-1 6-4 9-8 11C35 43 8 34 5 19Z"
        fill="currentColor"
      />
      <path
        d="M31 11c-4-7-1-10 0-10 3 2 4 5 4 9M37 10c1-5 4-6 6-5-1 4-3 6-6 7"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="15" cy="20" r="2" fill="var(--game-ui-background, #0b1016)" />
      <path
        d="M25 27c3 4 7 5 10 5"
        stroke="var(--game-ui-background, #0b1016)"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SonarMark({ className }: { className?: string }) {
  return (
    <span className={classNames('game-ui__sonar', className)} aria-hidden="true">
      <span />
      <span />
      <i />
    </span>
  );
}

export function fixedDisplayMoney(value: string | number): string {
  if (typeof value === 'string') return value.startsWith('$') ? value : `$${value}`;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function cssVars(index: number): CSSProperties {
  return { '--asset-accent': assetAccent(index) } as CSSProperties;
}

import type { SyntheticAsset, SyntheticScenario } from '../../../fixtures/synthetic/scenarios.js';
import type { HuntV2Window, HuntV2Zone } from '../../../shared/hunt-v2.js';
import type { HuntV2BoardFactory } from './v2.js';

function hash(value: string): number {
  let result = 2_166_136_261;
  for (const character of value) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16_777_619);
  }
  return result >>> 0;
}

function fallbackVolumes(asset: SyntheticAsset, length: number): number[] {
  return Array.from({ length }, (_, index) => {
    const change = Math.abs(
      (asset.series[index] ?? asset.series[0] ?? 1) -
        (asset.series[index - 1] ?? asset.series[0] ?? 1),
    );
    return Math.round(300 + change * 1_000 + index * 12);
  });
}

function pulseIndices(volume: readonly number[]): number[] {
  return volume
    .map((value, index) => ({ value, index }))
    .sort((left, right) => right.value - left.value)
    .slice(0, Math.min(3, volume.length))
    .map((item) => item.index)
    .sort((left, right) => left - right);
}

function windowFor(asset: SyntheticAsset, zone: HuntV2Zone): HuntV2Window {
  const price = asset.series.length >= 2 ? asset.series : [asset.entry, asset.exit];
  const volume =
    asset.volumeSeries && asset.volumeSeries.length >= 2
      ? asset.volumeSeries.slice(-price.length)
      : fallbackVolumes(asset, price.length);
  return {
    zone,
    price,
    volume,
    pulseIndices: pulseIndices(volume),
    market: {
      symbol: asset.symbol,
      name: asset.name,
      chain: asset.providerChain ?? asset.category.split(' · ')[0] ?? 'market',
      sourceKind: asset.smartMoney ? 'nansen' : 'synthetic',
      observedAt: asset.observedAt,
      smartMoney: asset.smartMoney ?? { direction: 'unavailable' },
      whalePressure: asset.whalePressure,
      whalePositionUsd: asset.whalePositionUsd,
      holderMetrics: asset.holderMetrics,
    },
  };
}

/** Creates shuffled, role-safe Hunt boards from one server-collected live scenario. */
export function createLiveHuntBoardFactory(scenario: SyntheticScenario): HuntV2BoardFactory {
  return (matchId, roundIndex) => {
    const assets = [...scenario.assets];
    const rotation = hash(`${matchId}:${roundIndex}`) % Math.max(1, assets.length);
    const rotated = assets.slice(rotation).concat(assets.slice(0, rotation));
    if (hash(`${matchId}:${roundIndex}:direction`) % 2 === 1) rotated.reverse();
    return rotated
      .slice(0, 3)
      .map((asset, index) => windowFor(asset, (['A', 'B', 'C'] as const)[index]!));
  };
}

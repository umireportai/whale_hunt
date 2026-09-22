import type { DatabaseSync } from 'node:sqlite';
import type { HuntReveal } from '../../shared/hunt.js';
import type { HuntMatchRow } from '../db/hunt.js';
import { readHuntParticipants } from '../db/hunt.js';
import type { HuntMatchScores, HuntSuspicionRecord } from '../domain/hunt/types.js';
import { ProgressionService } from '../domain/progression/index.js';

/** Recoverable, idempotent projection of persisted completions; no client-supplied scores. */
export function syncProgression(db: DatabaseSync, service: ProgressionService): void {
  const matches = db
    .prepare(
      `SELECT m.* FROM hunt_matches m WHERE m.phase='finished'
    AND EXISTS (SELECT 1 FROM hunt_participants p WHERE p.match_id=m.match_id
      AND (p.kind='human' OR p.connection='substituted')
      AND NOT EXISTS (SELECT 1 FROM progression_hunt_results r WHERE r.match_id=m.match_id AND r.player_id=p.participant_id))`,
    )
    .all() as unknown as HuntMatchRow[];
  for (const match of matches) {
    const participants = readHuntParticipants(db, match.match_id);
    const reveal = JSON.parse(match.reveal_payload!) as HuntReveal;
    const scores = JSON.parse(match.scores_payload!) as HuntMatchScores;
    const suspicions = JSON.parse(match.suspicions_payload) as HuntSuspicionRecord[];
    const matchKind = db
      .prepare(
        "SELECT 1 FROM hunt_events WHERE match_id=? AND kind='participant-substituted' LIMIT 1",
      )
      .get(match.match_id)
      ? 'substituted'
      : participants.some((p) => p.kind === 'computer')
        ? 'computer'
        : 'human';
    const isPair = (pair: { primaryAssetId: string; secondaryAssetId: string }) =>
      new Set([pair.primaryAssetId, pair.secondaryAssetId]).has(reveal.primaryAssetId) &&
      new Set([pair.primaryAssetId, pair.secondaryAssetId]).has(reveal.secondaryAssetId);
    for (const participant of participants.filter(
      (p) => p.kind === 'human' || p.connection === 'substituted',
    )) {
      service.recordHuntResult({
        playerId: participant.participant_id,
        matchId: match.match_id,
        completedAt: match.completed_at!,
        role:
          participant.role === 'whale' ? 'whale' : participant.is_captain ? 'captain' : 'tracer',
        maxTracers: match.max_tracers,
        matchKind,
        reveal,
        scores,
        correctPairBeforeFinal: suspicions.some(
          (s) => s.actorId === participant.participant_id && isPair(s),
        ),
        finalIncludesDecoy: reveal.accusation !== null && !isPair(reveal.accusation),
      });
    }
  }
}

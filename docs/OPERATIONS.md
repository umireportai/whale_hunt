# Whale Hunt Operations

## Production startup

1. Install Node.js 24 LTS.
2. Run `npm ci`.
3. Copy `.env.example` to `.env` and set deployment values.
4. Run `npm run build`.
5. Start with `NODE_ENV=production npm start`.
6. Check `GET /healthz` before routing traffic to the service.

The production process serves the browser bundle and API from one origin. Use HTTPS when exposing it outside a trusted network. Keep the directory containing `DATABASE_PATH` on persistent storage and include it in the host backup policy.

## Duello lobby

Duello has two entry paths: start a match immediately against the computer, or enter the online lobby as the whale or tracer. Two players who select opposite roles are paired into one match. If nobody joins, the waiting lobby promotes the match to a computer opponent automatically after the configured wait period. Browser sessions are anonymous; no user account or login service is required.

## Live Nansen mode

Live mode is opt-in. Set `DATA_MODE=live` and provide one `NANSEN_API_KEY`. The provider client uses bounded requests, response validation, caching, and the configured credit budget. Provider failures are reported as unavailable data; synthetic data is not presented as live data.

## Health and administration

- `GET /healthz` is safe for liveness and readiness checks and does not expose secrets.
- `GET /api/admin/usage` is disabled unless `ADMIN_TOKEN` is set. When enabled, send `Authorization: Bearer <ADMIN_TOKEN>`.

Do not log `.env`, authorization headers, API keys, or raw provider responses.

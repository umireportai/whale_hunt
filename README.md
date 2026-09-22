# Whale Hunt

Whale Hunt is a server-authoritative market-signal game. Players investigate wallet and market evidence, identify the hidden whale move, and compete as the whale or tracer.

The deployment contains two Hunt modes:

- Real Whale Hunt: inspect current Nansen-backed evidence when live mode is enabled.
- Duello: play the whale-versus-tracer match with a human opponent or a computer fallback.

The application does not execute trades, connect to wallets, or provide financial advice.

## Requirements

- Node.js 24 LTS (`>=24.0.0 <25.0.0`)
- npm 11 or a compatible npm version
- SQLite support supplied by Node.js; no separate database server is required
- Docker Engine or Docker Desktop for container deployment

## Install and run

```bash
git clone https://github.com/umireportai/whale_hunt.git
cd whale_hunt
cp .env.example .env
npm ci
npm run typecheck
npm run build
NODE_ENV=production npm start
```

Open `http://127.0.0.1:8311`. The production server serves the API and web application from the same port.

## Configuration

Copy `.env.example` to `.env`. Keep `.env` private; it is ignored by Git and must never be committed.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATA_MODE` | `synthetic` | `synthetic` uses the five bundled historical replay cases. `live` enables Nansen collection. |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` in a container or server behind a firewall. |
| `API_PORT` | `8311` | API and web port. |
| `DATABASE_PATH` | `./data/whale-hunt.sqlite` | Persistent SQLite database location. |
| `NANSEN_API_KEY` | empty | The Nansen key used only in live mode. |
| `NANSEN_CREDIT_BUDGET` | `18` | Maximum Nansen credit budget for one process. |
| `NANSEN_LIVE_HUNT` | `true` | Set to `false` to disable live Hunt collection while retaining live mode. |
| `ADMIN_TOKEN` | empty | Optional bearer token for `/api/admin/usage`. |

Synthetic mode needs no provider credentials:

```dotenv
DATA_MODE=synthetic
```

Live mode requires the operator to set the one provider key securely:

```dotenv
DATA_MODE=live
NANSEN_API_KEY=replace-with-your-key
NANSEN_LIVE_HUNT=true
```

Keys stay on the server. Raw provider payloads and authorization headers are not returned to the browser or health endpoint.

## Dependencies

`npm ci` installs the exact versions recorded in `package-lock.json`.

Runtime dependencies:

- `fastify` — HTTP server
- `@fastify/cookie` — signed browser-session cookie support
- `@fastify/rate-limit` — request limiting
- `@fastify/static` — production web-bundle serving
- `react` and `react-dom` — browser interface
- `tsx` — TypeScript runtime for the server
- `zod` — request and provider-response validation

Build dependencies:

- `typescript` — type checking
- `vite` — production browser build
- `@vitejs/plugin-react` — React support for Vite
- `@types/node`, `@types/react`, `@types/react-dom` — TypeScript declarations

## Docker deployment

```bash
docker build -t whale-hunt .
docker run --name whale-hunt \
  --env-file .env \
  -p 8311:8311 \
  -v whale-hunt-data:/app/data \
  whale-hunt
```

The image builds the web bundle, runs the production server on port `8311`, and keeps SQLite data in `/app/data`. Set `HOST=0.0.0.0` when using Docker.

## Commands

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the locked dependency set. |
| `npm run typecheck` | Check TypeScript without emitting files. |
| `npm run build` | Type-check and build the browser bundle into `dist/`. |
| `npm run dev` | Build and run the local server on port `8311`. |
| `npm start` | Start the server. Use `NODE_ENV=production` to serve `dist/`. |
| `npm run db:migrate` | Create or update the configured SQLite schema. |

For a server with an existing `dist/` directory:

```bash
npm ci --omit=dev
NODE_ENV=production npm start
```

## Health and API

`GET /healthz` returns status, data mode, provider status, and a safe availability reason. It never returns credentials.

- `/api/hunt/*` — multiplayer Hunt rooms, commands, replays, and matchmaking.
- `/api/hunt/v2/*` — Duello matches and lobby operations.
- `/api/signal-hunt/*` — Real Whale Hunt cases, scans, and result locks.
- `/api/progression` and `/api/shares/*` — Hunt history, badges, and public share projections.
- `/api/admin/usage` — provider usage protected by `Authorization: Bearer <ADMIN_TOKEN>`.

The server validates all commands, owns hidden state and outcomes, and applies idempotency to state-changing operations.

## Repository layout

- `web/` — React interface and Hunt styles.
- `server/` — Fastify API, Hunt rules, SQLite persistence, Nansen adapter, and evidence processing.
- `shared/` — Contracts shared by browser and server.
- `fixtures/synthetic/` — The five credential-free historical replay cases.
- `Dockerfile` — Production container definition.
- `.env.example` — Safe configuration template with no credentials.

For an AI-assisted installation, use [AI_INSTALL_PROMPT.md](AI_INSTALL_PROMPT.md).

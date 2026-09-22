# AI installation prompt

Copy this prompt into an AI coding assistant or server automation agent:

```text
Install and run the Whale Hunt repository from:
https://github.com/umireportai/whale_hunt

Follow these requirements exactly:

1. Confirm that Node.js is version 24 LTS (24.x) and npm is available. Stop and explain how to install Node 24 if it is missing or another major version is active.
2. Clone the repository and enter its directory.
3. Create the environment file with:
   cp .env.example .env
4. Install the locked dependencies with:
   npm ci
5. For a standard installation, leave DATA_MODE=synthetic. Do not invent or request a Nansen key for synthetic mode.
6. Run the checks:
   npm run typecheck
   npm run build
7. Start the application in production mode:
   NODE_ENV=production npm start
8. Verify that GET http://127.0.0.1:8311/healthz returns status "ok" and reports synthetic mode.
9. Open http://127.0.0.1:8311/ and verify the application loads. Confirm that Duello offers both direct computer play and the online lobby, and that the lobby can wait for an opponent before falling back to the computer.
10. Keep the SQLite directory persistent. Do not delete the configured DATABASE_PATH. The database stores anonymous session, lobby, and match state; this installation does not require user accounts.
11. Never print, commit, upload, or expose .env contents, Nansen credentials, or ADMIN_TOKEN.

For a live Nansen installation, ask the operator to provide the key securely, then set only this variable in .env:
NANSEN_API_KEY=the-operator-supplied-key

Do not add alternate Nansen key variables, source-code secrets, extra services, or unrelated packages. If Docker is preferred, build with `docker build -t whale-hunt .` and run with the operator's `.env`, port 8311, and a persistent `/app/data` volume.

Report the installed Node version, the two check results, the health-check response status, and the final URL. Do not report secret values.
```

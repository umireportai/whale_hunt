import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { buildApp } from './app.js';

if (existsSync('.env')) loadEnvFile('.env');
if (existsSync('../.env')) loadEnvFile('../.env');
if (existsSync('../../.env')) loadEnvFile('../../.env');
const app = await buildApp({ serveStatic: process.env.NODE_ENV === 'production', logger: true });
try {
  await app.listen({
    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.API_PORT ?? 8311),
  });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app.close();
  });

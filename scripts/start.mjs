import { access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function start() {
  let argumentPort;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      console.log('Usage: npm start -- [--port 3000]\nRuns the production standalone server on 0.0.0.0. PORT is used when --port is omitted.');
      return;
    }
    if (argument === '--port' || argument === '-p' || argument.startsWith('--port=')) {
      if (argumentPort !== undefined) throw new Error('Specify the port only once.');
      argumentPort = argument.startsWith('--port=') ? argument.slice(7) : args[++index];
      if (argumentPort === undefined) throw new Error('The --port option requires a number between 1 and 65535.');
    } else throw new Error(`Unknown option: ${argument}. Use --help for usage.`);
  }

  // Preserve the calling environment; load local production defaults in Next.js precedence order.
  for (const filename of ['.env.production.local', '.env.local', '.env.production', '.env']) {
    const candidate = path.join(root, filename);
    if (existsSync(candidate)) process.loadEnvFile(candidate);
  }
  const port = argumentPort ?? process.env.PORT ?? '3000';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('The port must be a whole number between 1 and 65535.');
  }
  process.env.PORT = String(Number(port));
  process.env.HOSTNAME = '0.0.0.0';
  process.env.NODE_ENV = 'production';
  process.env.NEXT_TELEMETRY_DISABLED ??= '1';
  const database = process.env.DATABASE_PATH || path.join(root, 'data', 'game.sqlite');
  process.env.DATABASE_PATH = database === ':memory:' ? database : path.resolve(root, database);
  const server = path.join(root, '.next', 'standalone', 'server.js');
  try { await access(server); }
  catch { throw new Error('The production server is missing. Run npm run build before npm start.'); }
  await import(pathToFileURL(server).href);
}

start().catch(error => {
  console.error(`Unable to start Team Capital: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

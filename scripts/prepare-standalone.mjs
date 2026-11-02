import { access, cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const standalone = path.join(root, '.next', 'standalone');

try {
  await access(path.join(standalone, 'server.js'));
  await mkdir(path.join(standalone, '.next'), { recursive: true });
  for (const [source, target] of [
    [path.join(root, 'public'), path.join(standalone, 'public')],
    [path.join(root, '.next', 'static'), path.join(standalone, '.next', 'static')],
  ]) {
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true });
  }
  console.log('Standalone server prepared with public assets and static chunks.');
} catch (error) {
  console.error('Could not prepare the standalone server. Run a successful Next.js build first.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3'],
  // Runtime databases and local credentials must never travel with a release.
  outputFileTracingExcludes: {
    '/*': ['./data/**/*', './output/**/*', './.env*', './test-results/**/*', './playwright-report/**/*'],
  },
  poweredByHeader: false,
};
export default nextConfig;

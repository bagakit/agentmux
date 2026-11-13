import base from '../../mobile/test/connection-link.config.mts'

// Actual current Host assembly/public RPC and the separately compiled source CLI. Native process I/O
// alone is controlled by the existing fixture. No freshness override or shared dist is involved.
export default { ...base, cacheDir: '.tmp/connection-link-public',
  test: { ...base.test, include: ['apps/host/test/mobile-link.test.ts'], environment: 'node' } }

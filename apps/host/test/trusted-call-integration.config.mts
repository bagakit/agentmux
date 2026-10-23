import inputAuthority from '../../desktop/test/input-authority.config.mts'

// The mounted Renderer exercises input and original workface recovery across an
// owner restart. The additional case owns the real post-dispatch reply loss.
export default { ...inputAuthority, test: { ...inputAuthority.test,
  include: ['apps/desktop/test/terminal-input-authority.integration.test.tsx',
    'apps/host/test/trusted-call-integration.test.ts'],
  testNamePattern: 'keeps actual (?:terminal|agent) keyboard/paste/binary|consumes a nonempty incomplete Main catalogue|trusted call native proof',
  passWithNoTests: false, fileParallelism: false, maxWorkers: 1,
  testTimeout: 90_000, hookTimeout: 30_000
} }

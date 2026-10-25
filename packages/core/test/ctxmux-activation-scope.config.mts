import base from './durable-local-creation.config.mts'
export default { ...base, test: { ...base.test, include: [
  'packages/core/test/ctxmux-live-artifact-independence.test.ts',
  'packages/core/test/ctxmux-owner-compatibility.test.ts',
  'packages/core/test/ctxmux-live-listener-launch.test.ts',
  'packages/core/test/ctxmux-cold-start-readiness.test.ts',
  'packages/core/test/ctxmux-daemon-diagnostic-lifetime.test.ts',
  'packages/core/test/ctxmux-activation-public.integration.test.ts'
], passWithNoTests: false, maxWorkers: 1, testTimeout: 20_000, hookTimeout: 20_000 } }

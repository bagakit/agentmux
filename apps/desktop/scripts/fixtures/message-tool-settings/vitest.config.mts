import base from '../settings-overview/vitest.config.mts'
export default { ...base, test: { ...base.test, include: [
  'apps/desktop/test/settings-message-tool.test.tsx',
  'apps/desktop/test/settings-modules-control.test.ts'
] } }

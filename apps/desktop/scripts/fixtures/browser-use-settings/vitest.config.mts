import base from '../settings-modules/vitest.config.mts'
export default { ...base, test: { ...base.test, include: [
  'apps/desktop/test/settings-browser-agent-control.test.tsx',
] } }

import base from '../../../vitest.config'
export default { ...base, define: { ...base.define, __AGENTMUX_WEB_PREVIEW__: 'false' },
  test: { ...base.test, include: ['apps/desktop/test/capsule-client.test.ts'], maxWorkers: 1, passWithNoTests: false } }

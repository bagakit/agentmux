import base from './capsule-settings.config.mts'

export default {
  ...base,
  define: { ...base.define, __AGENTMUX_WEB_PREVIEW__: 'false' },
  test: { ...base.test, include: ['apps/desktop/test/workbench-close-ipc.test.ts'] }
}

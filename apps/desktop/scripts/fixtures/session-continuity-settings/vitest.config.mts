import base from '../settings-overview/vitest.config.mts'
export default { ...base, test: { ...base.test, include: ['apps/desktop/test/session-continuity-settings.test.tsx', 'apps/desktop/test/session-continuity-settings-control.test.ts'] } }

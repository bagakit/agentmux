import base from '../settings-overview/vitest.config.mts'
export default { ...base, test: { ...base.test, include: ['apps/desktop/test/session-continuity-supervision.test.tsx', 'apps/desktop/test/session-continuity-control-main.test.ts'] } }

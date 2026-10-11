import base from '../settings-overview/vitest.config.mts'
export default { ...base, test: { ...base.test, include: ['apps/desktop/test/initial-continuity-supervision.test.tsx'] } }

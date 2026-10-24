import base from './capsule-settings.config.mts'

export default { ...base, test: { ...base.test, include: ['apps/desktop/test/capsule-partial-recovery.test.tsx'] } }

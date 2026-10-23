import base from './capsule-settings.config.mts'

export default { ...base, test: { ...base.test, include: ['apps/desktop/test/capsule-toolkit.test.tsx'], testTimeout: 20000 } }

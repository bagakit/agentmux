import base from './capsule-settings.config.mts'

export default { ...base, test: { ...base.test, include: ['apps/desktop/test/capsule-toolkit.test.tsx', 'apps/desktop/test/capsule-toolkit-tui.test.ts'], testTimeout: 45000 } }

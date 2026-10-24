import base from './capsule-settings.config.mts'
export default { ...base, test: { ...base.test, include: ['apps/desktop/test/conversation-capsule.test.tsx', 'apps/desktop/test/capsule-browser.test.ts'] } }

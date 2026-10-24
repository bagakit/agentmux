import base from './capsule-settings.config.mts'
export default { ...base, test: { ...base.test, include: ['apps/desktop/test/conversation-capsule.test.tsx', 'apps/desktop/test/capsule-browser.test.ts', 'apps/desktop/test/capsule-chrome.test.tsx', 'apps/desktop/test/capsule-partial-recovery.test.tsx'] } }

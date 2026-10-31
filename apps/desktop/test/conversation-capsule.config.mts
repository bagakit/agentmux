import { mergeConfig } from 'vite'
import { aliases } from '../scripts/fixtures/conversation-style-entry/environment.mjs'
import base from './capsule-settings.config.mts'
export default { ...mergeConfig(base, { resolve: { alias: aliases } }), test: { ...base.test, include: ['apps/desktop/test/conversation-capsule.test.tsx', 'apps/desktop/test/capsule-browser.test.ts', 'apps/desktop/test/capsule-chrome.test.tsx', 'apps/desktop/test/capsule-partial-recovery.test.tsx'] } }

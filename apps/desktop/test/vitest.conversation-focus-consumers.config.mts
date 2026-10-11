import base from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'
import { defineConfig } from 'vitest/config'
export default defineConfig({...base, cacheDir:'.cache/conversation-focus-consumers', test:{...base.test, environment:'happy-dom',
 include:['apps/desktop/test/focus-timeline-conversation-records.test.tsx',
 'apps/desktop/test/focus-selected-consumer-cost.test.tsx','apps/desktop/test/agent-focus-context.test.ts','apps/desktop/test/focus-context-recap-menu.test.tsx',
 'apps/desktop/test/activity-ruler-mapping.test.ts','apps/desktop/test/conversation-ruler-windows.test.ts','apps/desktop/test/launcher-resume-previews.test.tsx']}})

import { randomUUID } from 'node:crypto'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const toolbar = 'packages/client-ui/src/components/RovingToolbar.tsx'
await verifyRendererSourceMutations({
  name: 'roving-toolbar-' + randomUUID(),
  tests: ['apps/desktop/test/note-toolbar-focus.test.tsx', 'apps/desktop/test/annotation-toolbar-focus.test.tsx'],
  sources: [toolbar],
  owningConfig: 'apps/desktop/test/settings-form-rows.config.mts',
  mutations: [
    { label: 'horizontal-toolbar-loses-arrow-navigation', file: toolbar, before: 'orientation="horizontal"', after: 'orientation="vertical"' }
  ]
})
